import { sessionsDb } from '@/modules/database/index.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import type { LLMProvider } from '@/shared/types.js';

type SessionPermissionMode = {
  sessionId: string;
  provider: LLMProvider;
  permissionMode: string;
};

type SetSessionPermissionModeResult =
  | { ok: true; value: SessionPermissionMode }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'UNSUPPORTED_PROVIDER' | 'INVALID_PERMISSION_MODE'; error: string };

const PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'opencode', 'kimi'];

function isProvider(value: string): value is LLMProvider {
  return PROVIDERS.includes(value as LLMProvider);
}

function defaultPermissionMode(provider: LLMProvider): string {
  // This installation is an administrator-owned server where Codex is
  // intentionally allowed to manage the whole machine unless the session is
  // explicitly switched to a safer mode.
  if (provider === 'codex') {
    return 'bypassPermissions';
  }
  return providerCapabilitiesService.getProviderCapabilities(provider).defaultPermissionMode;
}

function isValidPermissionMode(provider: LLMProvider, permissionMode: unknown): permissionMode is string {
  return typeof permissionMode === 'string'
    && providerCapabilitiesService.getProviderCapabilities(provider).permissionModes.includes(permissionMode);
}

/**
 * Owns the permission mode persisted on a session and used by every channel.
 *
 * A client-provided mode may initialize a brand-new session, but once the
 * server has stored a value no later chat.send can silently override it.
 */
export const sessionPermissionModeService = {
  getSessionPermissionMode(sessionId: string, initialMode?: unknown): SessionPermissionMode | null {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session || !isProvider(session.provider)) {
      return null;
    }

    const permissionMode = isValidPermissionMode(session.provider, session.permission_mode)
      ? session.permission_mode
      : isValidPermissionMode(session.provider, initialMode)
        ? initialMode
        : defaultPermissionMode(session.provider);

    if (session.permission_mode !== permissionMode) {
      sessionsDb.setSessionPermissionMode(sessionId, permissionMode);
    }

    return { sessionId, provider: session.provider, permissionMode };
  },

  setSessionPermissionMode(sessionId: string, permissionMode: unknown): SetSessionPermissionModeResult {
    const session = sessionsDb.getSessionById(sessionId);
    if (!session) {
      return {
        ok: false,
        code: 'SESSION_NOT_FOUND',
        error: `Session "${sessionId}" was not found.`,
      };
    }
    if (!isProvider(session.provider)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_PROVIDER',
        error: `Provider "${session.provider}" is not available.`,
      };
    }
    if (!isValidPermissionMode(session.provider, permissionMode)) {
      const supported = providerCapabilitiesService
        .getProviderCapabilities(session.provider)
        .permissionModes
        .join(', ');
      return {
        ok: false,
        code: 'INVALID_PERMISSION_MODE',
        error: `Permission mode "${String(permissionMode)}" is invalid for ${session.provider}. Supported modes: ${supported}.`,
      };
    }

    sessionsDb.setSessionPermissionMode(sessionId, permissionMode);
    return {
      ok: true,
      value: { sessionId, provider: session.provider, permissionMode },
    };
  },
};
