export type Tab = 'services' | 'deploy' | 'logs' | 'metrics' | 'terminal' | 'branches';
export type Screen = 'boot' | 'disconnected' | 'loading' | 'ready' | 'error';
export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info';

export type Me = {
  user?: { id?: string; email?: string; name?: string; avatarUrl?: string };
  token?: { scope?: string; orgId?: string | null; access?: string };
};

export type Org = {
  id: string;
  name: string;
  slug?: string;
  role?: string;
  tier?: string;
  balance_micros?: string;
  is_personal?: boolean;
};

export type Project = {
  id: string;
  org_id?: string;
  name: string;
  status?: string;
  region?: string;
  created_at?: string;
  updated_at?: string;
};

export type Service = {
  id: string;
  project_id?: string;
  type: string;
  name: string;
  status?: string;
  desired_state?: string;
  image?: string | null;
  port?: number | null;
  domain?: string | null;
  endpoint_host?: string | null;
  private_host?: string | null;
  private_fqdn?: string | null;
  region?: string;
  always_on?: boolean;
  volume_gib?: number | null;
  volume_mount_path?: string | null;
  branch_id?: string | null;
  websocket?: boolean;
  endpoint?: string | null;
  spec?: { cpus?: number; cpu_kind?: string; memory_mb?: number };
  machine_count?: number;
  created_at?: string;
  updated_at?: string;
  source?: { type?: string; branch?: string; autoDeploy?: boolean } | null;
};

export type Branch = {
  id: string;
  name: string;
  is_default?: boolean;
  status?: string;
  parent_branch_id?: string | null;
  created_at?: string;
};

export type Region = { slug: string; label: string };

export type LogLine = {
  ts?: string | number;
  level?: string;
  instance?: string;
  region?: string;
  message?: string;
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
  me: Me | null;
  orgs: Org[];
  orgId: string | null;
  projects: Project[];
  projectId: string | null;
  branches: Branch[];
  branch: string | null;
  services: Service[];
  regions: Region[];
  serviceId: string | null;
  tab: Tab;
  settings: Record<string, string>;
  term: Record<string, TermState>;
  helpOpen: boolean;
};
