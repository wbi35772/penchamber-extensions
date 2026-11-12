import type { HostClient } from '@openchamber/sdk';
import type { Api } from './api';
import type { State, Tab } from './types';

export type Ctx = {
  host: HostClient;
  api: Api;
  state: State;
  render(): void;
  setTab(tab: Tab): void;
  selectService(serviceId: string | null): void;
  refreshProject(): Promise<void>;
  selectOrg(orgId: string): Promise<void>;
  openProject(projectId: string): Promise<void>;
  closeProject(): void;
  copy(text: string): void;
};
