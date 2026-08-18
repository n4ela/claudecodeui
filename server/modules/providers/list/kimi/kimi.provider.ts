import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

import { KimiProviderAuth } from './kimi-auth.provider.js';
import { KimiMcpProvider } from './kimi-mcp.provider.js';
import { KimiProviderModels } from './kimi-models.provider.js';
import { kimiRuntime } from './kimi-runtime.provider.js';
import { KimiSessionSynchronizer } from './kimi-session-synchronizer.provider.js';
import { KimiSessionsProvider } from './kimi-sessions.provider.js';
import { KimiSkillsProvider } from './kimi-skills.provider.js';

export class KimiProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = kimiRuntime;
  readonly models: IProviderModels = new KimiProviderModels();
  readonly mcp = new KimiMcpProvider();
  readonly auth: IProviderAuth = new KimiProviderAuth();
  readonly skills: IProviderSkills = new KimiSkillsProvider();
  readonly sessions: IProviderSessions = new KimiSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KimiSessionSynchronizer();

  constructor() {
    super('kimi');
  }
}

