import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedMessage } from './useSessionStore';
import {
  dedupeAdjacentAssistantEchoes,
  removeOptimisticUserEchoes,
} from './sessionMessageReconciliation';

const createUserMessage = (
  id: string,
  timestamp: string,
  overrides: Partial<NormalizedMessage> = {},
): NormalizedMessage => ({
  id,
  sessionId: 'session-1',
  timestamp,
  provider: 'claude',
  kind: 'text',
  role: 'user',
  content: '',
  ...overrides,
});

test('replaces an optimistic image-only turn with its persisted Claude copy', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png', name: 'image.png' }],
  });
  const persisted = createUserMessage('claude_image', '2026-07-28T20:30:26.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('does not collapse an attachment-only turn into a server row without attachments', () => {
  const local = createUserMessage('local_image', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/upload.png' }],
  });
  const persisted = createUserMessage('claude_empty', '2026-07-28T20:30:22.000Z');

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), [local]);
});

test('matches optimistic attachment turns to persisted turns one-to-one', () => {
  const firstLocal = createUserMessage('local_first', '2026-07-28T20:30:21.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/first.png' }],
  });
  const secondLocal = createUserMessage('local_second', '2026-07-28T20:30:25.000Z', {
    images: [{ path: 'C:/Users/test/.cloudcli/assets/second.png' }],
  });
  const firstPersisted = createUserMessage('claude_first', '2026-07-28T20:30:22.000Z', {
    images: [{ data: 'data:image/png;base64,AAAA' }],
  });

  const remainingRealtime = removeOptimisticUserEchoes(
    [firstPersisted],
    [firstLocal, secondLocal],
  );

  assert.deepEqual(remainingRealtime.map((message) => message.id), ['local_second']);
});

test('keeps the existing optimistic text reconciliation behavior', () => {
  const local = createUserMessage('local_text', '2026-07-28T20:30:21.000Z', {
    content: 'hello',
  });
  const persisted = createUserMessage('claude_text', '2026-07-28T20:30:26.000Z', {
    content: 'hello',
  });

  assert.deepEqual(removeOptimisticUserEchoes([persisted], [local]), []);
});

test('removes a live Kimi echo that sorts after the persisted assistant reply', () => {
  const persisted = createUserMessage('kimi-history', '2026-08-21T01:09:07.589Z', {
    provider: 'kimi',
    role: 'assistant',
    content: 'Final Kimi reply',
  });
  const live = createUserMessage('__streaming_session-1', '2026-08-21T01:09:07.700Z', {
    provider: 'kimi',
    kind: 'stream_delta',
    role: undefined,
    content: 'Final Kimi reply',
  });

  assert.deepEqual(dedupeAdjacentAssistantEchoes([persisted, live]), [persisted]);
});

test('prefers the persisted Kimi reply when it sorts after the live row', () => {
  const live = createUserMessage('__streaming_session-1', '2026-08-21T01:09:07.500Z', {
    provider: 'kimi',
    kind: 'stream_delta',
    role: undefined,
    content: 'Final Kimi reply',
  });
  const persisted = createUserMessage('kimi-history', '2026-08-21T01:09:07.589Z', {
    provider: 'kimi',
    role: 'assistant',
    content: 'Final Kimi reply',
  });

  assert.deepEqual(dedupeAdjacentAssistantEchoes([live, persisted]), [persisted]);
});

test('collapses persisted and two live copies of the same Kimi reply', () => {
  const persisted = createUserMessage('kimi-history', '2026-08-21T01:37:33.249Z', {
    provider: 'kimi',
    role: 'assistant',
    content: 'One persisted reply',
  });
  const firstLive = createUserMessage('kimi-live', '2026-08-21T01:37:33.300Z', {
    provider: 'kimi',
    kind: 'stream_delta',
    role: undefined,
    content: 'One persisted reply',
  });
  const accumulatedLive = createUserMessage('__streaming_session-1', '2026-08-21T01:37:33.400Z', {
    provider: 'kimi',
    kind: 'stream_delta',
    role: undefined,
    content: 'One persisted reply',
  });

  assert.deepEqual(
    dedupeAdjacentAssistantEchoes([persisted, firstLive, accumulatedLive]),
    [persisted],
  );
  assert.deepEqual(
    dedupeAdjacentAssistantEchoes([firstLive, accumulatedLive, persisted]),
    [persisted],
  );
});
