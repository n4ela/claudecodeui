import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { kimiRuntime, readKimiSessionId, resolveKimiEffort } from './kimi-runtime.provider.js';
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
const runtimeContext = {
  resolveProviderSessionId: (sessionId) => sessionId === 'app-existing' ? 'ses_existing' : null,
  resolveResumeModel: async (_sessionId, requestedModel) => requestedModel || models.DEFAULT,
  getProviderModels: async () => models,
  normalizeMessage: (raw, sessionId) => sessionsProvider.normalizeMessage(raw, sessionId),
  isProviderInstalled: async () => true,
};

const findEnvKey = (name) =>
  Object.keys(process.env).find((key) => key.toLowerCase() === name.toLowerCase()) || name;

async function createFakeKimiExecutable(binDir) {
  const scriptPath = path.join(binDir, 'kimi.js');
  await writeFile(scriptPath, `
const fs = require('node:fs');
if (process.env.KIMI_ARGS_CAPTURE) {
  fs.writeFileSync(process.env.KIMI_ARGS_CAPTURE, JSON.stringify({
    args: process.argv.slice(2),
    effort: process.env.KIMI_MODEL_THINKING_EFFORT || null,
  }));
}
console.log(JSON.stringify({ role: 'meta', type: 'system.version', version: '1.2.3' }));
console.log(JSON.stringify({ role: 'assistant', content: 'Kimi response' }));
console.log(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: 'ses_new' }));
`, 'utf8');

  if (process.platform === 'win32') {
    await writeFile(path.join(binDir, 'kimi.cmd'), '@echo off\r\nnode "%~dp0kimi.js" %*\r\n', 'utf8');
    return;
  }
  const commandPath = path.join(binDir, 'kimi');
  await writeFile(commandPath, '#!/bin/sh\nnode "$(dirname "$0")/kimi.js" "$@"\n', 'utf8');
  await chmod(commandPath, 0o755);
}

test('Kimi runtime uses prompt JSONL, resumes native sessions and forwards reasoning effort', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'kimi-runtime-'));
  const capturePath = path.join(tempRoot, 'args.json');
  const pathKey = findEnvKey('PATH');
  const previousPath = process.env[pathKey];
  const previousCapture = process.env.KIMI_ARGS_CAPTURE;
  const messages = [];
  const writer = {
    userId: null,
    send(message) { messages.push(message); },
    setSessionId(sessionId) { this.providerSessionId = sessionId; },
  };

  try {
    await createFakeKimiExecutable(tempRoot);
    process.env[pathKey] = `${tempRoot}${path.delimiter}${previousPath || ''}`;
    process.env.KIMI_ARGS_CAPTURE = capturePath;

    await kimiRuntime.run('Inspect this project', {
      sessionId: 'app-existing',
      cwd: tempRoot,
      model: 'kimi-code/k3',
      effort: 'high',
    }, writer, runtimeContext);

    const capture = JSON.parse(await readFile(capturePath, 'utf8'));
    assert.deepEqual(capture.args, [
      '--prompt', 'Inspect this project',
      '--output-format', 'stream-json',
      '--session', 'ses_existing',
      '--model', 'kimi-code/k3',
    ]);
    assert.equal(capture.effort, 'high');
    assert.equal(writer.providerSessionId, 'ses_new');
    assert.ok(messages.some((message) => message.kind === 'stream_delta' && message.content === 'Kimi response'));
    assert.ok(messages.some((message) => message.kind === 'complete' && message.success === true));
  } finally {
    if (previousPath === undefined) delete process.env[pathKey];
    else process.env[pathKey] = previousPath;
    if (previousCapture === undefined) delete process.env.KIMI_ARGS_CAPTURE;
    else process.env.KIMI_ARGS_CAPTURE = previousCapture;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('Kimi runtime helpers accept only model-supported efforts and read resume hints', () => {
  assert.equal(resolveKimiEffort('kimi-code/k3', 'max', models), 'max');
  assert.equal(resolveKimiEffort('kimi-code/k3', 'ultra', models), undefined);
  assert.equal(resolveKimiEffort('kimi-code/k3', 'default', models), undefined);
  assert.equal(readKimiSessionId({ role: 'meta', type: 'session.resume_hint', session_id: 'ses_1' }), 'ses_1');
  assert.equal(readKimiSessionId({ role: 'assistant', content: 'hi' }), null);
});
