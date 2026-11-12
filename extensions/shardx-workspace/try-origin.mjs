import { readFileSync } from 'node:fs';
import { parseManifestJson } from './node_modules/@openchamber/sdk/dist/parse.js';
const raw = JSON.parse(readFileSync('./package.json','utf8'));
const tryVariant = (label, mutate) => {
  const obj = JSON.parse(JSON.stringify(raw));
  mutate(obj.openchamber);
  const res = parseManifestJson(JSON.stringify(obj));
  console.log('==', label, res.ok ? 'OK' : 'FAIL: '+res.code, res.ok ? '' : res.message);
};
tryVariant('http-origin + caps', (m) => { m.capabilities = ['origins','network']; m.contributes.origins = ['http://127.0.0.1:40325']; });
tryVariant('https-ip + caps', (m) => { m.capabilities = ['origins','network']; m.contributes.origins = ['https://127.0.0.1:40325']; });
tryVariant('https-localhost + caps', (m) => { m.capabilities = ['origins','network']; m.contributes.origins = ['https://localhost:40325']; });
tryVariant('caps only', (m) => { m.capabilities = ['origins','network']; });