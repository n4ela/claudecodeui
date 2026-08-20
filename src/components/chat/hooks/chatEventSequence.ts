type SequencedChatEvent = {
  runId?: unknown;
  seq?: unknown;
};

/**
 * Records one live event and returns false when the same or an older event from
 * the current run was already handled. `seq` restarts for every provider run,
 * so `runId` changes reset the per-session high-water mark safely.
 */
export function acceptSequencedChatEvent(
  lastSeqBySession: Map<string, number>,
  lastRunBySession: Map<string, string>,
  sessionId: string,
  event: SequencedChatEvent,
): boolean {
  const eventRunId = typeof event.runId === 'string' && event.runId.length > 0
    ? event.runId
    : null;

  if (eventRunId && lastRunBySession.get(sessionId) !== eventRunId) {
    lastRunBySession.set(sessionId, eventRunId);
    lastSeqBySession.set(sessionId, 0);
  }

  if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) {
    return true;
  }

  const sequence = Math.max(0, Math.floor(event.seq));
  const known = lastSeqBySession.get(sessionId) ?? 0;
  if (sequence <= known) return false;

  lastSeqBySession.set(sessionId, sequence);
  return true;
}
