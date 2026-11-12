/**
 * Minimal RFC 6455 client, enough for the Chrome DevTools Protocol.
 *
 * The whole extension is dependency-free: the panel only talks to the host
 * bridge, and the bridge service (this process) speaks WebSocket with the
 * platform's own `http` upgrade and a small frame codec. No `ws` package, no
 * Node version assumptions about a global WebSocket.
 */
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

export type MiniWebSocketHandlers = {
  onMessage?: (data: string) => void;
  onClose?: (reason: string) => void;
};

export type MiniWebSocketOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  heartbeatMs?: number;
};

function frame(opcode: number, payload: any): any {
  const length = payload.length;
  let headerLength = 2;
  if (length >= 126 && length <= 0xffff) headerLength += 2;
  else if (length > 0xffff) headerLength += 8;
  const header = Buffer.alloc(headerLength + 4);
  header[0] = 0x80 | opcode;
  let offset = 2;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  const mask = randomBytes(4);
  mask.copy(header, offset);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, masked]);
}

export class MiniWebSocket {
  private socket: any = null;
  private buffer: any = Buffer.alloc(0);
  private fragments: any[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private closeReason = '';
  private heartbeat: any = null;
  private handlers: MiniWebSocketHandlers;

  private constructor(handlers: MiniWebSocketHandlers) {
    this.handlers = handlers;
  }

  static connect(url: string, handlers: MiniWebSocketHandlers, options: MiniWebSocketOptions = {}): Promise<MiniWebSocket> {
    return new Promise((resolve, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new Error(`CDP 地址无效: ${url}`));
        return;
      }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        reject(new Error(`CDP 地址必须是 ws:// 或 wss://: ${url}`));
        return;
      }
      const secure = parsed.protocol === 'wss:';
      const key = randomBytes(16).toString('base64');
      const timeoutMs = options.timeoutMs ?? 15000;
      let settled = false;
      const settle = (error?: Error, value?: MiniWebSocket) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value as MiniWebSocket);
      };

      const request = (secure ? httpsRequest : httpRequest)({
        hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: parsed.port || (secure ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        headers: {
          ...(options.headers ?? {}),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13',
        },
        timeout: timeoutMs,
      });

      request.on('upgrade', (response: any, socket: any, head: any) => {
        const expected = createHash('sha1').update(`${key}${HANDSHAKE_GUID}`).digest('base64');
        if (response.headers['sec-websocket-accept'] !== expected) {
          socket.destroy();
          settle(new Error('CDP WebSocket 握手校验失败'));
          return;
        }
        const ws = new MiniWebSocket(handlers);
        ws.socket = socket;
        socket.setNoDelay(true);
        if (head && head.length > 0) ws.ingest(head);
        socket.on('data', (chunk: any) => ws.ingest(chunk));
        socket.on('close', () => ws.fail('CDP WebSocket 连接已关闭'));
        socket.on('error', (error: any) => ws.fail(`CDP WebSocket 错误: ${error?.message ?? error}`));
        ws.startHeartbeat(options.heartbeatMs ?? 20000);
        settle(undefined, ws);
      });

      request.on('response', (response: any) => {
        response.resume();
        settle(new Error(`CDP WebSocket 被拒绝（HTTP ${response.statusCode}）`));
      });
      request.on('error', (error: any) => settle(new Error(`CDP WebSocket 连接失败: ${error?.message ?? error}`)));
      request.on('timeout', () => {
        request.destroy();
        settle(new Error(`CDP WebSocket 连接超时（${Math.round(timeoutMs / 1000)}s）`));
      });
      request.end();
    });
  }

  isOpen(): boolean {
    return !this.closed && this.socket !== null;
  }

  send(text: string): void {
    if (!this.isOpen()) throw new Error(this.closeReason || 'CDP 连接已关闭');
    this.socket.write(frame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
  }

  close(reason = '客户端关闭'): void {
    if (this.closed) return;
    try {
      if (this.socket) {
        this.socket.write(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      }
    } catch {
      /* socket already gone */
    }
    this.fail(reason);
    try {
      this.socket?.end();
    } catch {
      /* ignore */
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.heartbeat = setInterval(() => {
      if (!this.isOpen()) return;
      try {
        this.socket.write(frame(OPCODE_PING, Buffer.alloc(0)));
      } catch {
        this.fail('CDP 心跳失败');
      }
    }, intervalMs);
    this.heartbeat.unref?.();
  }

  private fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    try {
      this.socket?.destroy();
    } catch {
      /* ignore */
    }
    this.socket = null;
    try {
      this.handlers.onClose?.(reason);
    } catch {
      /* listener failure never breaks the socket */
    }
  }

  private ingest(chunk: any): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.parseFrame()) {
      if (this.closed) return;
    }
  }

  private parseFrame(): boolean {
    const buffer = this.buffer;
    if (buffer.length < 2) return false;
    const first = buffer[0];
    const second = buffer[1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    if (length === 126) {
      if (buffer.length < offset + 2) return false;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return false;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(64 * 1024 * 1024)) {
        this.fail('CDP 消息超过 64MB 上限');
        return false;
      }
      length = Number(big);
      offset += 8;
    }

    let mask: any = null;
    if (masked) {
      if (buffer.length < offset + 4) return false;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buffer.length < offset + length) return false;

    let payload = buffer.subarray(offset, offset + length);
    this.buffer = buffer.subarray(offset + length);
    if (mask) {
      const unmasked = Buffer.allocUnsafe(length);
      for (let index = 0; index < length; index += 1) {
        unmasked[index] = payload[index] ^ mask[index & 3];
      }
      payload = unmasked;
    }

    if (opcode === OPCODE_PING) {
      try {
        this.socket?.write(frame(OPCODE_PONG, payload));
      } catch {
        this.fail('CDP Pong 发送失败');
      }
      return true;
    }
    if (opcode === OPCODE_PONG) return true;
    if (opcode === OPCODE_CLOSE) {
      let reason = 'CDP 对端关闭连接';
      if (payload.length >= 2) {
        const code = payload.readUInt16BE(0);
        const text = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        reason = `CDP 连接已关闭（code ${code}${text ? `: ${text}` : ''}）`;
      }
      try {
        this.socket?.write(frame(OPCODE_CLOSE, Buffer.alloc(0)));
      } catch {
        /* ignore */
      }
      this.fail(reason);
      return false;
    }

    if (opcode === OPCODE_TEXT || opcode === OPCODE_BINARY) {
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === OPCODE_CONTINUATION) {
      this.fragments.push(payload);
    } else {
      return true;
    }

    if (!fin) return true;
    const whole = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === OPCODE_TEXT) {
      try {
        this.handlers.onMessage?.(whole.toString('utf8'));
      } catch {
        /* listener failure never breaks the socket */
      }
    }
    return true;
  }
}
