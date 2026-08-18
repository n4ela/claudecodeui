import assert from 'node:assert/strict';
import test from 'node:test';

import { parseKimiProviderModels } from '@/modules/providers/list/kimi/kimi-models.provider.js';
import { KimiSessionsProvider } from '@/modules/providers/list/kimi/kimi-sessions.provider.js';

test('Kimi model catalog parser preserves aliases and reasoning effort metadata', () => {
  const parsed = parseKimiProviderModels({
    providers: { 'kimi-code': { type: 'kimi-code' } },
    models: {
      'kimi-code/k3': {
        provider: 'kimi-code',
        display_name: 'Kimi K3',
        support_efforts: ['low', 'high', 'max'],
        default_effort: 'max',
      },
      'kimi-code/kimi-for-coding': { provider: 'kimi-code' },
    },
  });

  assert.ok(parsed);
  assert.deepEqual(parsed.OPTIONS.map((option) => option.value), [
    'kimi-code/kimi-for-coding',
    'kimi-code/k3',
  ]);
  const k3 = parsed.OPTIONS.find((option) => option.value === 'kimi-code/k3');
  assert.equal(k3?.label, 'Kimi K3');
  assert.equal(k3?.effort?.default, 'max');
  assert.deepEqual(k3?.effort?.values.map((entry) => entry.value), ['low', 'high', 'max']);
});

test('Kimi stream-json normalizer maps assistant, tool and retry lines', () => {
  const provider = new KimiSessionsProvider();
  const assistant = provider.normalizeMessage({
    role: 'assistant',
    content: 'Checking',
    tool_calls: [{
      id: 'tc_1',
      function: { name: 'Shell', arguments: '{"command":"pwd"}' },
    }],
  }, 'ses_1');
  assert.equal(assistant[0]?.kind, 'stream_delta');
  assert.equal(assistant[0]?.content, 'Checking');
  assert.equal(assistant[1]?.kind, 'tool_use');
  assert.equal(assistant[1]?.toolName, 'Shell');
  assert.deepEqual(assistant[1]?.toolInput, { command: 'pwd' });

  const tool = provider.normalizeMessage({
    role: 'tool', tool_call_id: 'tc_1', content: 'ok',
  }, 'ses_1');
  assert.equal(tool[0]?.kind, 'tool_result');
  assert.equal(tool[0]?.toolId, 'tc_1');

  const retry = provider.normalizeMessage({
    role: 'meta', type: 'turn.step.retrying', error_message: 'rate limited',
  }, 'ses_1');
  assert.equal(retry[0]?.kind, 'status');
  assert.equal(retry[0]?.status, 'retrying');
});
