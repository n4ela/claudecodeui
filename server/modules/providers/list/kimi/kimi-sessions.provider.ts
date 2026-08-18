import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'kimi';

const stringifyValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
};

const extractParts = (content: unknown): Array<AnyRecord> => (
  Array.isArray(content)
    ? content.map(readObjectRecord).filter((entry): entry is AnyRecord => entry !== null)
    : typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : []
);

const visibleUserOrigin = (message: AnyRecord): boolean => {
  const origin = readObjectRecord(message.origin);
  return !origin || origin.kind === 'user';
};

const addMessageContent = (
  messages: NormalizedMessage[],
  content: unknown,
  sessionId: string | null,
  timestamp: string,
  role: 'user' | 'assistant',
  idPrefix: string,
): void => {
  const textParts: string[] = [];
  const thinkParts: string[] = [];
  const images: Array<{ data?: string; path?: string }> = [];
  for (const part of extractParts(content)) {
    if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
    if (part.type === 'think' && typeof part.think === 'string') thinkParts.push(part.think);
    if (part.type === 'image_url') {
      const imageUrl = readObjectRecord(part.imageUrl ?? part.image_url);
      const url = readOptionalString(imageUrl?.url);
      if (url) images.push(url.startsWith('data:') ? { data: url } : { path: url });
    }
  }

  if (thinkParts.length > 0) {
    messages.push(createNormalizedMessage({
      id: `${idPrefix}-thinking`, sessionId, timestamp, provider: PROVIDER,
      kind: 'thinking', content: thinkParts.join('\n'),
    }));
  }

  const rawText = textParts.join('\n');
  const parsedImages = parseImagesInputTag(rawText);
  const parsedFiles = parseFilesInputTag(parsedImages.text);
  const restoredImages = [
    ...images,
    ...parsedImages.attachments.map((attachment) => ({ path: attachment.path })),
  ];
  if (parsedFiles.text.trim() || restoredImages.length > 0 || parsedFiles.attachments.length > 0) {
    messages.push(createNormalizedMessage({
      id: `${idPrefix}-text`, sessionId, timestamp, provider: PROVIDER,
      kind: 'text', role, content: parsedFiles.text,
      images: restoredImages.length > 0 ? restoredImages : undefined,
      files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
    }));
  }
};

export class KimiSessionsProvider implements IProviderSessions {
  /** Normalize one line from `kimi --output-format stream-json`. */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) return [];
    const timestamp = normalizeProviderTimestamp(raw.timestamp ?? raw.time);
    const baseId = readOptionalString(raw.id) ?? generateMessageId('kimi');
    const role = readOptionalString(raw.role);

    if (role === 'assistant') {
      const messages: NormalizedMessage[] = [];
      const content = readOptionalString(raw.content);
      if (content?.trim()) {
        messages.push(createNormalizedMessage({
          id: `${baseId}-text`, sessionId, timestamp, provider: PROVIDER,
          kind: 'stream_delta', role: 'assistant', content,
        }));
      }
      const toolCalls = Array.isArray(raw.tool_calls) ? raw.tool_calls : [];
      for (const [index, rawCall] of toolCalls.entries()) {
        const call = readObjectRecord(rawCall);
        const fn = readObjectRecord(call?.function);
        if (!call || !fn) continue;
        const toolId = readOptionalString(call.id) ?? `${baseId}-tool-${index}`;
        const argumentsText = readOptionalString(fn.arguments);
        let toolInput: unknown = argumentsText ?? {};
        if (argumentsText) {
          try { toolInput = JSON.parse(argumentsText); } catch { /* preserve raw arguments */ }
        }
        messages.push(createNormalizedMessage({
          id: toolId, sessionId, timestamp, provider: PROVIDER,
          kind: 'tool_use', toolId,
          toolName: readOptionalString(fn.name) ?? 'Tool', toolInput,
        }));
      }
      return messages;
    }

    if (role === 'tool') {
      return [createNormalizedMessage({
        id: baseId, sessionId, timestamp, provider: PROVIDER,
        kind: 'tool_result', toolId: readOptionalString(raw.tool_call_id) ?? '',
        content: stringifyValue(raw.content), isError: Boolean(raw.is_error),
      })];
    }

    if (role === 'meta' && raw.type === 'turn.step.retrying') {
      const errorMessage = readOptionalString(raw.error_message) ?? 'Kimi is retrying the model request.';
      return [createNormalizedMessage({
        id: baseId, sessionId, timestamp, provider: PROVIDER,
        kind: 'status', status: 'retrying', content: errorMessage,
      })];
    }

    return [];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const session = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(options.providerSessionId ?? sessionId);
    const wirePath = session?.jsonl_path;
    const limit = options.limit === null || options.limit === undefined ? null : Math.max(0, options.limit);
    const offset = Math.max(0, options.offset ?? 0);
    if (!wirePath) return { messages: [], total: 0, hasMore: false, offset, limit };

    const messages: NormalizedMessage[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const lines = (await readFile(wirePath, 'utf8')).split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) continue;
        let record: AnyRecord | null = null;
        try { record = readObjectRecord(JSON.parse(line)); } catch { continue; }
        if (!record) continue;
        const timestamp = normalizeProviderTimestamp(record.time ?? record.timestamp);
        const baseId = readOptionalString(record.uuid) ?? generateMessageId('kimi-history');

        if (record.type === 'context.append_message') {
          const message = readObjectRecord(record.message);
          const role = readOptionalString(message?.role);
          if (message && role === 'user' && visibleUserOrigin(message)) {
            addMessageContent(messages, message.content, sessionId, timestamp, 'user', baseId);
          } else if (message && role === 'assistant') {
            addMessageContent(messages, message.content, sessionId, timestamp, 'assistant', baseId);
            const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];
            for (const rawCall of toolCalls) {
              const call = readObjectRecord(rawCall);
              const toolId = readOptionalString(call?.id);
              if (!call || !toolId) continue;
              messages.push(createNormalizedMessage({
                id: toolId, sessionId, timestamp, provider: PROVIDER,
                kind: 'tool_use', toolId,
                toolName: readOptionalString(call.name) ?? 'Tool',
                toolInput: readOptionalString(call.arguments) ?? call.arguments ?? {},
              }));
            }
          }
          continue;
        }

        if (record.type === 'context.append_loop_event') {
          const event = readObjectRecord(record.event);
          if (!event) continue;
          if (event.type === 'content.part') {
            const part = readObjectRecord(event.part);
            if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              messages.push(createNormalizedMessage({
                id: readOptionalString(event.uuid) ?? baseId, sessionId, timestamp, provider: PROVIDER,
                kind: 'text', role: 'assistant', content: part.text,
              }));
            } else if (part?.type === 'think' && typeof part.think === 'string' && part.think.trim()) {
              messages.push(createNormalizedMessage({
                id: readOptionalString(event.uuid) ?? baseId, sessionId, timestamp, provider: PROVIDER,
                kind: 'thinking', content: part.think,
              }));
            }
          } else if (event.type === 'tool.call') {
            const toolId = readOptionalString(event.toolCallId) ?? readOptionalString(event.uuid) ?? baseId;
            messages.push(createNormalizedMessage({
              id: toolId, sessionId, timestamp, provider: PROVIDER,
              kind: 'tool_use', toolId,
              toolName: readOptionalString(event.name) ?? 'Tool', toolInput: event.args ?? {},
            }));
          } else if (event.type === 'tool.result') {
            const result = readObjectRecord(event.result);
            messages.push(createNormalizedMessage({
              id: baseId, sessionId, timestamp, provider: PROVIDER,
              kind: 'tool_result', toolId: readOptionalString(event.toolCallId) ?? '',
              content: stringifyValue(result?.output), isError: Boolean(result?.isError),
            }));
          }
          continue;
        }

        if (record.type === 'usage.record') {
          const usage = readObjectRecord(record.usage);
          inputTokens += Number(usage?.inputOther ?? 0)
            + Number(usage?.inputCacheRead ?? 0)
            + Number(usage?.inputCacheCreation ?? 0);
          outputTokens += Number(usage?.output ?? 0);
        }
      }
    } catch (error) {
      console.warn(`[Kimi] Unable to read session history ${sessionId}:`, error);
      return { messages: [], total: 0, hasMore: false, offset, limit };
    }

    messages.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
    const { page, hasMore } = sliceTailPage(messages, limit, offset);
    const tokenUsage = inputTokens + outputTokens > 0
      ? { used: inputTokens + outputTokens, inputTokens, outputTokens, breakdown: { input: inputTokens, output: outputTokens } }
      : undefined;
    return { messages: page, total: messages.length, hasMore, offset, limit, tokenUsage };
  }
}
