import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

class FakeWebSocket {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, (...args: unknown[]) => unknown>();

  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }

  on(event: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(event, handler);
  }

  async receive(payload: Record<string, unknown>): Promise<void> {
    await this.handlers.get('message')?.(JSON.stringify(payload));
  }
}

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'chat-permission-mode-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('subscribe, mode updates, and sends share one authoritative session mode', async () => {
  await withIsolatedDatabase(async () => {
    sessionsDb.createAppSession('shared-mode', 'codex', '/workspace/demo');
    const socket = new FakeWebSocket();
    let runtimePermissionMode: unknown;
    const runtime = {
      hasRuntime: () => true,
      run: async (_provider: unknown, _command: unknown, options: Record<string, unknown>, writer: { send: (event: unknown) => void }) => {
        runtimePermissionMode = options.permissionMode;
        writer.send({ kind: 'complete', provider: 'codex', sessionId: 'native', exitCode: 0 });
      },
      abort: async () => true,
      resolveToolApproval: () => undefined,
      getPendingApprovalsForSession: () => [],
    };

    handleChatConnection(socket as never, {} as never, { runtime } as never);
    await socket.receive({
      type: 'chat.subscribe',
      sessions: [{ sessionId: 'shared-mode', lastSeq: 0 }],
    });
    assert.equal(
      socket.frames.find((frame) => frame.kind === 'chat_subscribed')?.permissionMode,
      'bypassPermissions',
    );

    await socket.receive({
      type: 'chat.permission-mode',
      sessionId: 'shared-mode',
      permissionMode: 'acceptEdits',
    });
    assert.equal(
      socket.frames.find((frame) => frame.kind === 'session_permission_mode')?.permissionMode,
      'acceptEdits',
    );

    await socket.receive({
      type: 'chat.send',
      sessionId: 'shared-mode',
      content: 'hello',
      options: { permissionMode: 'bypassPermissions' },
    });

    assert.equal(runtimePermissionMode, 'acceptEdits');
    assert.equal(sessionsDb.getSessionById('shared-mode')?.permission_mode, 'acceptEdits');
  });
});
