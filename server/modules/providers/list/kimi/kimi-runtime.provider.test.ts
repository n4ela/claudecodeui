import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
} from './kimi-runtime.provider.js';
import { KimiSessionsProvider } from './kimi-sessions.provider.js';

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
console.log(JSON.stringify({ role: 'assistant', content: 'Kimi response' }));
if (prompt !== 'Hang before completion') {
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
      'Hang after completion',
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
