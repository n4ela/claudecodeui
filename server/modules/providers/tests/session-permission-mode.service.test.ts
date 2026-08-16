import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionPermissionModeService } from '@/modules/providers/services/session-permission-mode.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-permission-mode-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('Codex sessions default to full access and persist that choice', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('codex-default', 'codex', '/workspace/demo');

    const value = sessionPermissionModeService.getSessionPermissionMode('codex-default');

    assert.equal(value?.permissionMode, 'bypassPermissions');
    assert.equal(sessionsDb.getSessionById('codex-default')?.permission_mode, 'bypassPermissions');
  });
});

test('a stored mode wins over a stale mode attached to chat.send', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('codex-shared', 'codex', '/workspace/demo');
    const updated = sessionPermissionModeService.setSessionPermissionMode('codex-shared', 'acceptEdits');
    assert.equal(updated.ok, true);

    const value = sessionPermissionModeService.getSessionPermissionMode(
      'codex-shared',
      'bypassPermissions',
    );

    assert.equal(value?.permissionMode, 'acceptEdits');
  });
});

test('a valid first-send mode initializes a brand-new session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('codex-new', 'codex', '/workspace/demo');

    const value = sessionPermissionModeService.getSessionPermissionMode('codex-new', 'default');

    assert.equal(value?.permissionMode, 'default');
    assert.equal(sessionsDb.getSessionById('codex-new')?.permission_mode, 'default');
  });
});

test('invalid modes are rejected without changing the session', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('codex-invalid', 'codex', '/workspace/demo');
    sessionPermissionModeService.getSessionPermissionMode('codex-invalid');

    const result = sessionPermissionModeService.setSessionPermissionMode('codex-invalid', 'plan');

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'INVALID_PERMISSION_MODE');
    assert.equal(sessionsDb.getSessionById('codex-invalid')?.permission_mode, 'bypassPermissions');
  });
});
