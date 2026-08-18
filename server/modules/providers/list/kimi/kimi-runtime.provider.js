import crossSpawn from 'cross-spawn';

import {
  appendFilesInputTag,
  appendImagesInputTag,
  normalizeAttachmentDescriptors,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage } from '@/shared/utils.js';

const activeKimiProcesses = new Map();

export function resolveKimiEffort(model, effort, modelsDefinition) {
  const option = modelsDefinition?.OPTIONS?.find((entry) => entry.value === model);
  const allowed = option?.effort?.values?.map((entry) => entry.value) || [];
  return typeof effort === 'string' && effort !== 'default' && allowed.includes(effort)
    ? effort
    : undefined;
}

export function readKimiSessionId(event) {
  return event?.role === 'meta' && event?.type === 'session.resume_hint'
    ? event.session_id || null
    : null;
}

async function spawnKimi(command, options = {}, writer, context) {
  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, effort, sessionSummary, images, files } = options;
    const providerSessionId = context.resolveProviderSessionId(sessionId);
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = providerSessionId;
    let sessionCreatedSent = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let kimiProcess = null;
    let completeSent = false;
    let terminalNotificationSent = false;

    const finalAppSessionId = () => sessionId || capturedSessionId || processKey;
    const notifyTerminal = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) return;
      terminalNotificationSent = true;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: writer?.userId || null,
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
      } else {
        notifyRunFailed({
          userId: writer?.userId || null,
          provider: 'kimi',
          sessionId: finalAppSessionId(),
          sessionName: sessionSummary,
          error: error || `Kimi CLI exited with code ${code}`,
        });
      }
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) return;
      capturedSessionId = nextSessionId;
      if (!sessionId && kimiProcess) {
        activeKimiProcesses.delete(processKey);
        activeKimiProcesses.set(nextSessionId, kimiProcess);
      }
      if (writer.setSessionId) writer.setSessionId(nextSessionId);
      if (!providerSessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        writer.send(createNormalizedMessage({
          kind: 'session_created', provider: 'kimi',
          sessionId: nextSessionId, newSessionId: nextSessionId,
        }));
      }
    };

    const processLine = (line) => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch {
        writer.send(createNormalizedMessage({
          kind: 'stream_delta', provider: 'kimi', sessionId: capturedSessionId || sessionId || null,
          content: line,
        }));
        return;
      }
      registerSession(readKimiSessionId(event));
      for (const message of context.normalizeMessage(event, capturedSessionId || sessionId || null)) {
        writer.send(message);
      }
    };

    void context.resolveResumeModel(sessionId, model).then(async (resolvedModel) => {
      let modelsDefinition = null;
      try { modelsDefinition = await context.getProviderModels(); } catch { /* effort remains provider default */ }
      const resolvedEffort = resolveKimiEffort(resolvedModel, effort, modelsDefinition);
      const hasAttachments = normalizeAttachmentDescriptors(images).length > 0
        || normalizeAttachmentDescriptors(files).length > 0;
      const prompt = appendFilesInputTag(
        appendImagesInputTag(command?.trim() || '', images),
        files,
      );
      const args = ['--prompt', (command?.trim() || hasAttachments) ? prompt : 'Continue.', '--output-format', 'stream-json'];
      if (providerSessionId) args.push('--session', providerSessionId);
      if (resolvedModel) args.push('--model', resolvedModel);

      const env = { ...process.env };
      if (resolvedEffort) env.KIMI_MODEL_THINKING_EFFORT = resolvedEffort;
      kimiProcess = crossSpawn('kimi', args, {
        cwd: workingDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      });
      activeKimiProcesses.set(processKey, kimiProcess);

      kimiProcess.stdout.on('data', (data) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(processLine);
      });
      kimiProcess.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
      });
      kimiProcess.on('close', async (code) => {
        activeKimiProcesses.delete(processKey);
        if (capturedSessionId) activeKimiProcesses.delete(capturedSessionId);
        if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
        stdoutBuffer = '';
        const errorText = stderrBuffer.trim();
        if (code !== 0 && errorText) {
          writer.send(createNormalizedMessage({
            kind: 'error', provider: 'kimi', sessionId: finalAppSessionId(), content: errorText,
          }));
        }
        if (!completeSent && !kimiProcess.aborted) {
          completeSent = true;
          writer.send(createCompleteMessage({ provider: 'kimi', sessionId: finalAppSessionId(), exitCode: code }));
        }
        if (code === 0) {
          notifyTerminal({ code });
          resolve();
          return;
        }
        if ((code === 127 || code === null) && !(await context.isProviderInstalled())) {
          writer.send(createNormalizedMessage({
            kind: 'error', provider: 'kimi', sessionId: finalAppSessionId(),
            content: 'Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/',
          }));
        }
        notifyTerminal({ code, error: errorText || null });
        reject(new Error(errorText || (code === null ? 'Kimi CLI process was terminated' : `Kimi CLI exited with code ${code}`)));
      });
      kimiProcess.on('error', async (error) => {
        activeKimiProcesses.delete(processKey);
        const installed = await context.isProviderInstalled();
        const content = installed
          ? error.message
          : 'Kimi Code CLI is not installed. Install it from https://www.kimi.com/code/docs/en/';
        writer.send(createNormalizedMessage({
          kind: 'error', provider: 'kimi', sessionId: finalAppSessionId(), content,
        }));
        if (!completeSent && !kimiProcess.aborted) {
          completeSent = true;
          writer.send(createCompleteMessage({ provider: 'kimi', sessionId: finalAppSessionId(), exitCode: 1 }));
        }
        notifyTerminal({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortKimiSession(sessionId) {
  const process = activeKimiProcesses.get(sessionId);
  if (!process) return false;
  process.aborted = true;
  process.kill('SIGTERM');
  activeKimiProcesses.delete(sessionId);
  return true;
}

export const kimiRuntime = { run: spawnKimi, abort: abortKimiSession };
export { spawnKimi, abortKimiSession };
