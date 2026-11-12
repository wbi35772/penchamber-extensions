export type Tab = 'services' | 'deploy' | 'logs' | 'metrics' | 'terminal' | 'branches';
export type Screen = 'boot' | 'disconnected' | 'loading' | 'ready' | 'error';
export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export type Profile = {
  id: string;
  name: string;
  status: string;
  folder?: string;
  proxy_id?: string | null;
  platform?: string;
  fingerprint?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
};

export type Proxy = {
  id: string;
  protocol?: string;
  host: string;
  port: number;
  country?: string;
  status?: string;
};

/** One entry of ShardX `/running`: a browser that is already up with CDP. */
export type RunningProfile = {
  profileId: string;
  pid: number | null;
  cdpWebSocketDebuggerUrl: string;
  cdpHttpUrl: string;
  raw: Record<string, any>;
};

export type TargetInfo = {
  targetId: string;
  type: string;
  url?: string;
  title?: string;
  status?: string;
};

export type CdpResponse = {
  id: string;
  result?: any;
  error?: any;
};

export type CdpStartResult = {
  cdpWebSocketDebuggerUrl: string;
  raw: Record<string, unknown>;
};

export type FingerprintTemplate = Record<string, unknown>;

export type LogLine = {
  ts?: string | number;
  level?: string;
  message?: string;
  instance?: string;
  source?: string;
};

export type MetricPoint = [number, number];

export type MetricSeries = {
  name: string;
  unit?: string;
  labels?: Record<string, string>;
  points?: MetricPoint[];
  sampleIntervalSeconds?: number;
};

export type ExecResult = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

export type ServiceState = { desiredState?: string; state?: string };

export type Build = {
  id?: string;
  buildId?: string;
  status?: string;
  createdAt?: string;
  created_at?: string;
  source?: string;
  ref?: string;
  branch?: string;
  sha?: string;
  commit?: string;
  url?: string;
};

export type ServiceCreate = {
  type: string;
  name: string;
  branch?: string;
  region?: string;
  image?: string;
  port?: number;
  websocket?: boolean;
  alwaysOn?: boolean;
  volumeGib?: number;
  volumeMountPath?: string;
  pgVersion?: string;
};

export type DeployRequest = {
  image: string;
  branch?: string;
  group?: string;
  port?: number;
  websocket?: boolean;
  endpoint?: string;
  replaceSource?: boolean;
};

export type GithubDeployRequest = {
  owner: string;
  repo: string;
  source: 'public';
  branch?: string;
  rootDir?: string;
  port?: number;
};

export type TermKind = 'cmd' | 'out' | 'err' | 'meta';

export type TermLine = {
  kind: TermKind;
  text: string;
  time?: number;
};

export type TermState = {
  lines: TermLine[];
  history: string[];
  draft: string;
  cursor: number;
};

export type State = {
  screen: Screen;
  error: string | null;
  me: any | null;
  orgs: any[];
  orgId: string | null;
  projects: any[];
  projectId: string | null;
  branches: any[];
  branch: string | null;
  services: any[];
  regions: any[];
  serviceId: string | null;
  tab: Tab;
  settings: Record<string, string>;
  term: Record<string, TermState>;
  helpOpen: boolean;
};
