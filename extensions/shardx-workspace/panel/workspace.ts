import { transport } from './transport';

export type SkillStep = {
  action: 'navigate' | 'wait' | 'click' | 'type' | 'evaluate' | 'extract' | string;
  url?: string;
  selector?: string;
  text?: string;
  script?: string;
  ms?: number;
  mode?: 'text' | 'html' | 'markdown';
  [key: string]: any;
};

export type Skill = {
  id: string;
  name: string;
  site: string;
  url_pattern: string;
  description: string;
  steps: SkillStep[];
  created_at: number;
  updated_at: number;
};

export type Mapping = {
  profile_id: string;
  profile_name: string;
  session_id: string;
  source: string;
  updated_at: number;
};

export type Assignment = {
  skill_id: string;
  target_type: 'profile' | 'folder';
  target_id: string;
  created_at: number;
};

export type WorkspaceSettings = {
  launcher_path: string;
};

export type WorkspaceState = {
  version: number;
  mappings: Mapping[];
  skills: Skill[];
  assignments: Assignment[];
  settings: WorkspaceSettings;
};

export type ServerProcess = { pid: number; path: string };

export type ServerStatus = {
  found: boolean;
  running: boolean;
  version: string | null;
  port: number | null;
  apiEnabled: boolean;
  dataRoot: string;
  settingsPath: string;
  launcherPath: string;
  processes: ServerProcess[];
  statePath?: string;
};

export type ServerSyncResult = {
  version: string;
  port: number;
  dataRoot: string;
  syncedAt: number;
  profiles: any[];
  profileCount: number;
  folders: any[];
  folderCount: number;
  proxies: any[];
  proxyCount: number;
  running: any[];
  runningCount: number;
};

type StateResponse = { state: WorkspaceState; statePath?: string };
type SkillResponse = StateResponse & { skill: Skill };

/**
 * Shared workspace state lives in the bridge service so the panel and the MCP
 * server see the same profile -> session mappings, skills and assignments.
 * MCP writes the same file (`%APPDATA%\shardx-workspace\state.json`), so a
 * panel refresh picks up agent bindings without a restart.
 */
export class WorkspaceClient {
  private cached: WorkspaceState | null = null;

  get current(): WorkspaceState | null {
    return this.cached;
  }

  private apply(response: StateResponse): WorkspaceState {
    this.cached = response.state;
    return response.state;
  }

  async load(): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/state', {});
    return this.apply(response);
  }

  async saveMapping(profileId: string, profileName: string, sessionId: string): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/mapping', {
      profile_id: profileId,
      profile_name: profileName,
      session_id: sessionId,
      source: 'panel',
    });
    return this.apply(response);
  }

  async removeMapping(profileId: string): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/mapping', { profile_id: profileId });
    return this.apply(response);
  }

  async saveSkill(skill: Partial<Skill>): Promise<{ skill: Skill; state: WorkspaceState }> {
    const response = await transport.call<SkillResponse>('/workspace/skill', { skill });
    this.cached = response.state;
    return { skill: response.skill, state: response.state };
  }

  async removeSkill(id: string): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/skill/remove', { id });
    return this.apply(response);
  }

  async assign(skillId: string, targetType: 'profile' | 'folder', targetId: string, remove = false): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/assign', {
      skill_id: skillId,
      target_type: targetType,
      target_id: targetId,
      remove,
    });
    return this.apply(response);
  }

  async saveSettings(settings: Partial<WorkspaceSettings>): Promise<WorkspaceState> {
    const response = await transport.call<StateResponse>('/workspace/settings', { settings });
    return this.apply(response);
  }

  async serverStatus(): Promise<ServerStatus> {
    return transport.call<ServerStatus>('/workspace/server/status', {});
  }

  async serverControl(action: 'start' | 'stop' | 'restart', launcherPath?: string): Promise<ServerStatus & { action?: string }> {
    return transport.call<ServerStatus & { action?: string }>('/workspace/server/control', {
      action,
      launcher_path: launcherPath ?? '',
    });
  }

  async syncServer(): Promise<ServerSyncResult> {
    return transport.call<ServerSyncResult>('/workspace/server/sync', {});
  }
}
