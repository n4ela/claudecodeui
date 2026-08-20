import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startPluginServer, stopPluginServer } from '../plugin-process.service.js';

test('plugin servers inherit the CloudCLI host executable', async (t) => {
  const pluginName = `runtime-identity-${process.pid}`;
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), 'cloudcli-plugin-runtime-'));
  const executableRecord = path.join(pluginDirectory, 'runtime.txt');
  const serverEntry = 'server.mjs';

  await writeFile(
    path.join(pluginDirectory, serverEntry),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(executableRecord)}, process.execPath);`,
      "console.log(JSON.stringify({ ready: true, port: 49152 }));",
      'setInterval(() => {}, 1000);',
    ].join('\n'),
    'utf8',
  );

  t.after(async () => {
    await stopPluginServer(pluginName);
    await rm(pluginDirectory, { recursive: true, force: true });
  });

  await startPluginServer(pluginName, pluginDirectory, serverEntry);

  assert.equal(await readFile(executableRecord, 'utf8'), process.execPath);
});
