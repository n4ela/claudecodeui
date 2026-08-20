import assert from 'node:assert/strict';
import test from 'node:test';

import { acceptSequencedChatEvent } from './chatEventSequence';

test('drops replayed events from the current run', () => {
  const sequences = new Map<string, number>();
  const runs = new Map<string, string>();

  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-1', seq: 1 }), true);
  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-1', seq: 2 }), true);
  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-1', seq: 1 }), false);
  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-1', seq: 2 }), false);
  assert.equal(sequences.get('session-1'), 2);
});

test('accepts a restarted sequence when a new run id arrives', () => {
  const sequences = new Map([['session-1', 42]]);
  const runs = new Map([['session-1', 'run-1']]);

  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-2' }), true);
  assert.equal(sequences.get('session-1'), 0);
  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', { runId: 'run-2', seq: 1 }), true);
  assert.equal(sequences.get('session-1'), 1);
});

test('leaves unsequenced non-run events untouched', () => {
  const sequences = new Map([['session-1', 7]]);
  const runs = new Map([['session-1', 'run-1']]);

  assert.equal(acceptSequencedChatEvent(sequences, runs, 'session-1', {}), true);
  assert.equal(sequences.get('session-1'), 7);
  assert.equal(runs.get('session-1'), 'run-1');
});
