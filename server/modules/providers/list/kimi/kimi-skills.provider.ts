import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

import { getKimiCodeHome } from './kimi-paths.js';

export class KimiSkillsProvider extends SkillsProvider {
  constructor() {
    super('kimi');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);
    const projectRoots = repoRoot && path.resolve(repoRoot) !== path.resolve(workspacePath)
      ? [workspacePath, repoRoot]
      : [workspacePath];

    for (const rootDir of projectRoots) {
      for (const relativeDir of [['.kimi-code', 'skills'], ['.agents', 'skills']]) {
        addUniqueProviderSkillSource(sources, seenRootDirs, {
          scope: 'project',
          rootDir: path.join(rootDir, ...relativeDir),
          commandPrefix: '/',
        });
      }
    }

    for (const rootDir of [path.join(getKimiCodeHome(), 'skills'), path.join(os.homedir(), '.agents', 'skills')]) {
      addUniqueProviderSkillSource(sources, seenRootDirs, {
        scope: 'user',
        rootDir,
        commandPrefix: '/',
      });
    }
    return sources;
  }
}

