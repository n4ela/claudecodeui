import os from 'node:os';
import path from 'node:path';

/** Kimi honors KIMI_CODE_HOME as the root for config, auth and sessions. */
export const getKimiCodeHome = (): string => (
  process.env.KIMI_CODE_HOME?.trim() || path.join(os.homedir(), '.kimi-code')
);

export const getKimiSessionIndexPath = (): string => (
  path.join(getKimiCodeHome(), 'session_index.jsonl')
);

export const getKimiSessionsPath = (): string => (
  path.join(getKimiCodeHome(), 'sessions')
);

