import type { ChildProcess } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import type {
  AnyRecord,
  ProviderModelsDefinition,
  ProviderRuntimeContext,
  ProviderRuntimeWriter,
} from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

type KimiRuntimeOptions = {
  sessionId?: string;
  projectPath?: string;
  cwd?: string;
  model?: string | null;
  effort?: string;
  sessionSummary?: string;
  images?: unknown;
  files?: unknown;
};

type KimiChildProcess = ChildProcess & {
  aborted?: boolean;
};

type ActiveKimiProcess = {
  child: KimiChildProcess;
  keys: Set<string>;
  aborted: boolean;
};

type TerminalState = {
  code?: number | null;
  error?: unknown;
};

type RunStoppedNotification = {
  userId: string | number | null;
  provider: 'kimi';
  sessionId: string;
  sessionName?: string;
  stopReason: 'completed';
};

type RunFailedNotification = Omit<RunStoppedNotification, 'stopReason'> & {
  error: string;
};

// The notification service is still JavaScript and infers its default-null
// parameters too narrowly when called from a strict TypeScript provider.
const sendRunStoppedNotification = notifyRunStopped as unknown as (
  input: RunStoppedNotification,
) => void;
const sendRunFailedNotification = notifyRunFailed as unknown as (
  input: RunFailedNotification,
) => void;

/**
 * Kimi's final resume hint is a semantic end-of-turn marker, but the CLI can
 * retain a Node handle after writing it. Give healthy processes a short window
 * to exit normally before terminating the already-completed headless process.
 */
const KIMI_EXIT_GRACE_MS = 1_000;
const KIMI_FORCE_KILL_GRACE_MS = 1_000;

/**
 * All live Kimi children grouped by every id that can address them. A Set is
 * required because an already-completed CLI may still be exiting when the next
 * run for the same app session starts; a single map value would orphan one of
 * the children and make Stop unable to reach it.
 */
const activeKimiProcesses = new Map<string, Set<ActiveKimiProcess>>();

function addProcessKey(processRecord: ActiveKimiProcess, key: string | null | undefined): void {
  if (!key || processRecord.keys.has(key)) return;
  processRecord.keys.add(key);
  const processes = activeKimiProcesses.get(key) ?? new Set<ActiveKimiProcess>();
  processes.add(processRecord);
  activeKimiProcesses.set(key, processes);
}

function removeProcess(processRecord: ActiveKimiProcess): void {
  for (const key of processRecord.keys) {
    const processes = activeKimiProcesses.get(key);
    if (!processes) continue;
    processes.delete(processRecord);
    if (processes.size === 0) activeKimiProcesses.delete(key);
  }
  processRecord.keys.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? 'Unknown Kimi error');
}

/** Used by the Kimi runtime tests to verify provider-supported effort filtering. */
export function resolveKimiEffort(
  model: string | undefined,
  effort: string | undefined,
  modelsDefinition: ProviderModelsDefinition | null,
): string | undefined {
  const option = modelsDefinition?.OPTIONS?.find((entry) => entry.value === model);
  const allowed = option?.effort?.values.map((entry) => entry.value) ?? [];
  return typeof effort === 'string' && effort !== 'default' && allowed.includes(effort)
    ? effort
    : undefined;
}

/** Used by the Kimi runtime and its tests to capture the provider-native session id. */
export function readKimiSessionId(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as AnyRecord;
  return record.role === 'meta'
    && record.type === 'session.resume_hint'
    && typeof record.session_id === 'string'
    ? record.session_id
    : null;
}

function isKimiTurnComplete(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const record = event as AnyRecord;
  return record.role === 'meta' && record.type === 'session.resume_hint';
}

function spawnKimi(
  command: string,
  options: KimiRuntimeOptions = {},
  writer: ProviderRuntimeWriter,
  context: ProviderRuntimeContext,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, files } = options;
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || `${Date.now()}-${Math.random()}`;
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let kimiProcess: KimiChildProcess | null = null;
    let processRecord: ActiveKimiProcess | null = null;
    let completeSent = false;
    let semanticCompletionSeen = false;
    let terminalNotificationSent = false;
    let promiseSettled = false;
    let exitTimer: NodeJS.Timeout | null = null;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const finalAppSessionId = (): string => sessionId || capturedSessionId || processKey;

    const settleResolved = (): void => {
      if (promiseSettled) return;
      promiseSettled = true;
      resolve();
    };

    const settleRejected = (error: unknown): void => {
      if (promiseSettled) return;
      promiseSettled = true;
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    };

    const clearExitTimers = (): void => {
      if (exitTimer) clearTimeout(exitTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      exitTimer = null;
      forceKillTimer = null;
    };

    const notifyTerminal = ({ code = null, error = null }: TerminalState = {}): void => {
      if (terminalNotificationSent) return;
      terminalNotificationSent = true;
      if (code === 0 && !error) {
        sendRunStoppedNotification({
          userId: writer.userId || null,
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      } else {
        sendRunFailedNotification({
          userId: writer.userId || null,
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          sessionName: sessionSummary,
          error: error ? errorMessage(error) : `Kimi CLI exited with code ${code}`,
        });
      }
    };

    const scheduleCompletedProcessCleanup = (): void => {
      const child = kimiProcess;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;

      exitTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        }, KIMI_FORCE_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }, KIMI_EXIT_GRACE_MS);
      exitTimer.unref?.();
    };

    const completeSemantically = (): void => {
      if (semanticCompletionSeen) return;
      semanticCompletionSeen = true;
      if (!completeSent && !processRecord?.aborted) {
        completeSent = true;
        writer.send(createCompleteMessage({
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          exitCode: 0,
        }));
        notifyTerminal({ code: 0 });
      }
      settleResolved();
      scheduleCompletedProcessCleanup();
    };

    const registerSession = (nextSessionId: string | null): void => {
      if (!nextSessionId || capturedSessionId === nextSessionId) return;
      capturedSessionId = nextSessionId;
      if (!sessionId && processRecord) addProcessKey(processRecord, nextSessionId);
      writer.setSessionId?.(nextSessionId);
      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        writer.send(createNormalizedMessage({
          kind: 'session_created',
          provider: 'kimi',
          sessionId: nextSessionId,
          newSessionId: nextSessionId,
        }));
      }
    };

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        writer.send(createNormalizedMessage({
          kind: 'stream_delta',
          provider: 'kimi',
          sessionId: capturedSessionId || sessionId || null,
          content: line,
        }));
        return;
      }

      registerSession(readKimiSessionId(event));
      for (const message of context.normalizeMessage(event, capturedSessionId || sessionId || null)) {
        writer.send(message);
      }
      if (isKimiTurnComplete(event)) completeSemantically();
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      let modelsDefinition: ProviderModelsDefinition | null = null;
      try {
        modelsDefinition = await context.getProviderModels();
      } catch {
        // The provider default still works when the optional effort catalog is unavailable.
      }
      const resolvedEffort = resolveKimiEffort(resolvedModel, effort, modelsDefinition);
      const hasAttachments = normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      const trimmedCommand = command.trim();
      const prompt = appendFilesInputTag(appendImagesInputTag(trimmedCommand, images), files);
      const args = [
        '--prompt',
        trimmedCommand || hasAttachments ? prompt : 'Continue.',
        '--output-format',
        'stream-json',
      ];
      if (providerSessionId) args.push('--session', providerSessionId);
      if (resolvedModel) args.push('--model', resolvedModel);

      const env = { ...process.env };
      if (resolvedEffort) env.KIMI_MODEL_THINKING_EFFORT = resolvedEffort;
      kimiProcess = crossSpawn('kimi', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      }) as KimiChildProcess;
      processRecord = { child: kimiProcess, keys: new Set<string>(), aborted: false };
      addProcessKey(processRecord, processKey);
      if (capturedSessionId && !sessionId) addProcessKey(processRecord, capturedSessionId);

      kimiProcess.stdout?.on('data', (data: Buffer | string) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(processLine);
      });
      kimiProcess.stderr?.on('data', (data: Buffer | string) => {
        stderrBuffer += data.toString();
      });
      kimiProcess.on('close', async (code) => {
        clearExitTimers();
        if (processRecord) removeProcess(processRecord);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
        stdoutBuffer = '';

        if (semanticCompletionSeen) {
          settleResolved();
          return;
        }
        if (processRecord?.aborted) {
          settleResolved();
          return;
        }

        const errorText = stderrBuffer.trim();
        if (code !== 0 && errorText) {
          writer.send(createNormalizedMessage({
            kind: 'error',
            provider: 'kimi',
            sessionId: finalAppSessionId(),
            content: errorText,
          }));
        }
        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({
            provider: 'kimi',
            sessionId: finalAppSessionId(),
            exitCode: code,
          }));
        }
        if (code === 0) {
          notifyTerminal({ code });
          settleResolved();
          return;
        }
        if ((code === 127 || code === null) && !(await context.isProviderInstalled())) {
          writer.send(createNormalizedMessage({
            kind: 'error',
            provider: 'kimi',
            sessionId: finalAppSessionId(),
            content: 'Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/',
          }));
        }
        notifyTerminal({ code, error: errorText || null });
        settleRejected(new Error(
          errorText || (code === null
            ? 'Kimi CLI process was terminated'
            : `Kimi CLI exited with code ${code}`),
        ));
      });
      kimiProcess.on('error', async (error) => {
        clearExitTimers();
        if (processRecord) removeProcess(processRecord);
        if (semanticCompletionSeen || processRecord?.aborted) {
          settleResolved();
          return;
        }
        const installed = await context.isProviderInstalled();
        const content = installed
          ? error.message
          : 'Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/';
        writer.send(createNormalizedMessage({
          kind: 'error',
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          content,
        }));
        if (!completeSent) {
          completeSent = true;
          writer.send(createCompleteMessage({
            provider: 'kimi',
            sessionId: finalAppSessionId(),
            exitCode: 1,
          }));
        }
        notifyTerminal({ error });
        settleRejected(error);
      });
    }).catch(settleRejected);
  });
}

function abortKimiSession(sessionId: string): boolean {
  const processes = activeKimiProcesses.get(sessionId);
  if (!processes || processes.size === 0) return false;

  let aborted = false;
  for (const processRecord of [...processes]) {
    if (processRecord.child.exitCode !== null || processRecord.child.signalCode !== null) continue;
    processRecord.aborted = true;
    processRecord.child.aborted = true;
    aborted = processRecord.child.kill('SIGTERM') || aborted;
  }
  return aborted;
}

/** Consumed by KimiProvider to execute and abort Kimi CLI runs. */
export const kimiRuntime = { run: spawnKimi, abort: abortKimiSession };

/** Exported for focused Kimi runtime tests. Production callers use `kimiRuntime`. */
export { spawnKimi, abortKimiSession };
