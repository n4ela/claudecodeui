import { readFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getKimiCodeHome } from './kimi-paths.js';

export class KimiProviderAuth implements IProviderAuth {
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('kimi', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentialPath = path.join(getKimiCodeHome(), 'credentials', 'kimi-code.json');

    try {
      const credential = readObjectRecord(JSON.parse(await readFile(credentialPath, 'utf8')));
      const accessToken = readOptionalString(credential?.access_token);
      const refreshToken = readOptionalString(credential?.refresh_token);
      const authenticated = Boolean(accessToken || refreshToken);
      return {
        installed,
        provider: 'kimi',
        authenticated,
        email: authenticated ? 'Kimi Code account' : null,
        method: authenticated ? 'oauth_device_code' : null,
        error: authenticated ? undefined : 'Kimi Code is not logged in. Run `kimi login`.',
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        installed,
        provider: 'kimi',
        authenticated: false,
        email: null,
        method: null,
        error: code === 'ENOENT'
          ? 'Kimi Code is not logged in. Run `kimi login`.'
          : error instanceof Error ? error.message : 'Unable to read Kimi credentials.',
      };
    }
  }
}

