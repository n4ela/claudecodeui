import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import { normalizeProviderTimestamp, normalizeSessionName, readObjectRecord, readOptionalString } from '@/shared/utils.js';

import { getKimiSessionIndexPath } from './kimi-paths.js';

type KimiIndexEntry = { sessionId: string; sessionDir: string; workDir: string };

async function readKimiIndex(): Promise<KimiIndexEntry[]> {
  try {
    const bySessionId = new Map<string, KimiIndexEntry>();
    for (const line of (await readFile(getKimiSessionIndexPath(), 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = readObjectRecord(JSON.parse(line));
        const sessionId = readOptionalString(entry?.sessionId);
        const sessionDir = readOptionalString(entry?.sessionDir);
        const workDir = readOptionalString(entry?.workDir);
        if (sessionId && sessionDir && workDir) bySessionId.set(sessionId, { sessionId, sessionDir, workDir });
      } catch {
        // Skip damaged index lines; later entries remain usable.
      }
    }
    return [...bySessionId.values()];
  } catch {
    return [];
  }
}

export class KimiSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'kimi' as const;

  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    for (const entry of await readKimiIndex()) {
      const indexed = await this.upsertEntry(entry, since);
      if (indexed) processed += 1;
    }
    return processed;
  }

  async synchronizeFile(filePath: string): Promise<string | null> {
    const normalizedFile = path.resolve(filePath);
    if (normalizedFile === path.resolve(getKimiSessionIndexPath())) {
      const entries = await readKimiIndex();
      const latest = entries.at(-1);
      return latest ? this.upsertEntry(latest) : null;
    }

    const entries = await readKimiIndex();
    const entry = entries.find(({ sessionDir }) => {
      const root = `${path.resolve(sessionDir)}${path.sep}`;
      return normalizedFile === path.resolve(sessionDir) || normalizedFile.startsWith(root);
    });
    return entry ? this.upsertEntry(entry) : null;
  }

  private async upsertEntry(entry: KimiIndexEntry, since?: Date): Promise<string | null> {
    const statePath = path.join(entry.sessionDir, 'state.json');
    const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    let state: Record<string, unknown> = {};
    try { state = readObjectRecord(JSON.parse(await readFile(statePath, 'utf8'))) ?? {}; } catch { /* use file dates */ }

    const custom = readObjectRecord(state.custom);
    if (custom?.archived === true) return null;

    let wireStats: Awaited<ReturnType<typeof stat>> | null = null;
    try { wireStats = await stat(wirePath); } catch { return null; }
    const createdAt = normalizeProviderTimestamp(state.createdAt ?? wireStats.birthtimeMs);
    const updatedAt = normalizeProviderTimestamp(state.updatedAt ?? wireStats.mtimeMs);
    if (since && Date.parse(updatedAt) < since.getTime()) return null;

    const pending = sessionsDb.getSessionByProviderSessionId(entry.sessionId)
      ?? sessionsDb.getSessionById(entry.sessionId)
      ?? sessionsDb.findLatestPendingAppSession(this.provider, entry.workDir);
    if (pending && !pending.provider_session_id) {
      sessionsDb.assignProviderSessionId(pending.session_id, entry.sessionId);
    }

    const existing = sessionsDb.getSessionByProviderSessionId(entry.sessionId)
      ?? sessionsDb.getSessionById(entry.sessionId);
    const fallbackTitle = 'Untitled Kimi Session';
    const title = existing?.custom_name && existing.custom_name !== fallbackTitle
      ? existing.custom_name
      : readOptionalString(state.title) ?? readOptionalString(state.lastPrompt);

    return sessionsDb.createSession(
      entry.sessionId,
      this.provider,
      entry.workDir,
      normalizeSessionName(title, fallbackTitle),
      createdAt,
      updatedAt,
      wirePath,
    );
  }
}

