import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type {
  NormalizedMessage,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';

import {
  abortKimiSession,
  kimiRuntime,
  readKimiSessionId,
  resolveKimiEffort,
} from '../list/kimi/kimi-runtime.provider.js';
import { KimiSessionsProvider } from '../list/kimi/kimi-sessions.provider.js';

const sessionsProvider = new KimiSessionsProvider();
const models = {
  OPTIONS: [{
    value: 'kimi-code/k3',
    label: 'K3',
    effort: { default: 'max', values: [{ value: 'low' }, { value: 'high' }, { value: 'max' }] },
  }],
  DEFAULT: 'kimi-code/k3',
};
const runtimeContext: ProviderRuntimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId === 'app-existing' ? 'ses_existing' : null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || models.DEFAULT,
  getProviderModels: async () => models,
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name: string): string => (
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name
);

const delay = (milliseconds: number): Promise<void> => (
  new Promise((resolve) => setTimeout(resolve, milliseconds))
);

async function createFakeKimiExecutable(binDir: string): Promise<void> {
  const scriptPath = path.join(binDir, 'kimi.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1] || '';
if (process.env.KIMI_ARGS_CAPTURE) {
  fs.writeFileSync(process.env.KIMI_ARGS_CAPTURE, JSON.stringify({
    args,
    effort: process.env.KIMI_MODEL_THINKING_EFFORT || null,
  }));
}
console.log(JSON.stringify({ role: 'meta', type: 'system.version', version: '1.2.3' }));
const hasPendingToolCall = prompt === 'Hang before completion'
  || prompt === 'Hang after resume hint'
  || prompt === 'Hang after persisted completion';
console.log(JSON.stringify({
  role: 'assistant',
  content: 'Kimi response',
  ...(hasPendingToolCall ? {
    tool_calls: [{ id: 'tool-1', function: { name: 'Read', arguments: '{}' } }],
  } : {}),
}));
if (prompt === 'Hang after persisted completion' && process.env.KIMI_TEST_WIRE_PATH) {
  fs.appendFileSync(process.env.KIMI_TEST_WIRE_PATH, JSON.stringify({
    type: 'turn.ended',
    turnId: 2,
    reason: 'completed',
    time: Date.now(),
  }) + '\\n');
}
if (!prompt.startsWith('Hang ') || prompt === 'Hang after resume hint') {
  console.log(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'ses_new' }));
}
if (prompt.startsWith('Hang ')) {
  setInterval(() => {}, 60_000);
}
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'kimi.cmd'), '@echo off\r\nnode "%~dp0kimi.js" %*\r\n', 'utf8');
    return;
  }
  const commandPath = path.join(binDir, 'kimi');
  await writeFile(commandPath, '#!/bin/sh\nexec node "$(dirname "$0")/kimi.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

type TestWriter = ProviderRuntimeWriter & { providerSessionId?: string };

function createWriter(messages: NormalizedMessage[]): TestWriter {
  return {
    userId: null,
    send(message) {
      messages.push(message as NormalizedMessage);
    },
    setSessionId(sessionId) {
      this.providerSessionId = sessionId;
    },
  };
}

async function withFakeKimi(run: (tempRoot: string) => Promise<void>): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kimi-runtime-'));
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  try {
    await createFakeKimiExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    await run(tempRoot);
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test('Kimi runtime uses prompt JSONL, resumes native sessions and forwards reasoning effort', async () => {
  await withFakeKimi(async (tempRoot) => {
    const capturePath = path.join(tempRoot, 'args.json');
    const previousCapture = process.env.KIMI_ARGS_CAPTURE;
    const messages: NormalizedMessage[] = [];
    const writer = createWriter(messages);

    try {
      process.env.KIMI_ARGS_CAPTURE = capturePath;
      await kimiRuntime.run('Inspect this project', {
        sessionId: 'app-existing',
        cwd: tempRoot,
        model: 'kimi-code/k3',
        effort: 'high',
      }, writer, runtimeContext);

      const capture = JSON.parse(await readFile(capturePath, 'utf8')) as {
        args: string[];
        effort: string | null;
      };
      assert.deepEqual(capture.args, [
        '--prompt', 'Inspect this project',
        '--output-format', 'stream-json',
        '--session', 'ses_existing',
        '--model', 'kimi-code/k3',
      ]);
      assert.equal(capture.effort, 'high');
      assert.equal(writer.providerSessionId, 'ses_new');
      assert.ok(messages.some((message) => message.kind === 'stream_delta' && message.content === 'Kimi response'));
      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
      assert.ok(messages.some((message) => message.kind === 'complete' && message.success === true));
    } finally {
      if (previousCapture === undefined) delete process.env.KIMI_ARGS_CAPTURE;
      else process.env.KIMI_ARGS_CAPTURE = previousCapture;
    }
  });
});

test('Kimi runtime completes on the final resume hint and cleans up a CLI that stays alive', async () => {
  await withFakeKimi(async (tempRoot) => {
    const messages: NormalizedMessage[] = [];
    await kimiRuntime.run(
      'Hang after resume hint',
      { sessionId: 'app-existing', cwd: tempRoot },
      createWriter(messages),
      runtimeContext,
    );

    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(messages.some((message) => message.kind === 'complete' && message.success === true));
    await delay(1_250);
    assert.equal(abortKimiSession('app-existing'), false);
    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('Kimi runtime completes on a terminal assistant envelope when resume hint is missing', async () => {
  await withFakeKimi(async (tempRoot) => {
    const messages: NormalizedMessage[] = [];
    await kimiRuntime.run(
      'Hang after assistant completion',
      { sessionId: 'app-existing', cwd: tempRoot },
      createWriter(messages),
      runtimeContext,
    );

    assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(messages.some((message) => message.kind === 'complete' && message.success === true));
    await delay(1_250);
    assert.equal(abortKimiSession('app-existing'), false);
  });
});

test('Kimi runtime falls back to a newly persisted completed turn when resume hint is missing', async () => {
  await withFakeKimi(async (tempRoot) => {
    const sessionDir = path.join(tempRoot, 'sessions', 'ses_existing');
    const wireDir = path.join(sessionDir, 'agents', 'main');
    const wirePath = path.join(wireDir, 'wire.jsonl');
    const previousKimiHome = process.env.KIMI_CODE_HOME;
    const previousWirePath = process.env.KIMI_TEST_WIRE_PATH;
    const messages: NormalizedMessage[] = [];

    try {
      await mkdir(wireDir, { recursive: true });
      await writeFile(wirePath, `${JSON.stringify({
        type: 'turn.ended',
        turnId: 1,
        reason: 'completed',
        time: Date.now() - 1_000,
      })}\n`, 'utf8');
      await writeFile(path.join(tempRoot, 'session_index.jsonl'), `${JSON.stringify({
        sessionId: 'ses_existing',
        sessionDir,
        workDir: tempRoot,
      })}\n`, 'utf8');
      process.env.KIMI_CODE_HOME = tempRoot;
      process.env.KIMI_TEST_WIRE_PATH = wirePath;

      await Promise.race([
        kimiRuntime.run(
          'Hang after persisted completion',
          { sessionId: 'app-existing', cwd: tempRoot },
          createWriter(messages),
          runtimeContext,
        ),
        delay(3_000).then(() => { throw new Error('persisted completion fallback timed out'); }),
      ]);

      assert.equal(messages.filter((message) => message.kind === 'complete').length, 1);
      assert.ok(messages.some((message) => message.kind === 'complete' && message.success === true));
      await delay(1_250);
      assert.equal(abortKimiSession('app-existing'), false);
    } finally {
      if (previousKimiHome === undefined) delete process.env.KIMI_CODE_HOME;
      else process.env.KIMI_CODE_HOME = previousKimiHome;
      if (previousWirePath === undefined) delete process.env.KIMI_TEST_WIRE_PATH;
      else process.env.KIMI_TEST_WIRE_PATH = previousWirePath;
    }
  });
});

test('closing a newer Kimi process does not orphan an older process for the same session', async () => {
  await withFakeKimi(async (tempRoot) => {
    const firstRun = kimiRuntime.run(
      'Hang before completion',
      { sessionId: 'app-existing', cwd: tempRoot },
      createWriter([]),
      runtimeContext,
    );
    await delay(100);

    await kimiRuntime.run(
      'Finish normally',
      { sessionId: 'app-existing', cwd: tempRoot },
      createWriter([]),
      runtimeContext,
    );

    assert.equal(abortKimiSession('app-existing'), true);
    await firstRun;
    assert.equal(abortKimiSession('app-existing'), false);
  });
});

test('Kimi runtime helpers accept only model-supported efforts and read resume hints', () => {
  assert.equal(resolveKimiEffort('kimi-code/k3', 'max', models), 'max');
  assert.equal(resolveKimiEffort('kimi-code/k3', 'ultra', models), undefined);
  assert.equal(resolveKimiEffort('kimi-code/k3', 'default', models), undefined);
  assert.equal(readKimiSessionId({ role: 'meta', type: 'session.resume_hint', session_id: 'ses_1' }), 'ses_1');
  assert.equal(readKimiSessionId({ role: 'assistant', content: 'hi' }), null);
});
