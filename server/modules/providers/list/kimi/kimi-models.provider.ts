import { readFile } from 'node:fs/promises';
import path from 'node:path';

import spawn from 'cross-spawn';

import { sessionsDb } from '@/modules/database/index.js';
import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
} from '@/shared/utils.js';

export const KIMI_PREDEFINED_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'kimi-code/k3',
      label: 'K3',
      description: 'Kimi Code · 1M context',
      effort: {
        default: 'max',
        values: [
          { value: 'low', description: 'Fast reasoning' },
          { value: 'high', description: 'Deep reasoning' },
          { value: 'max', description: 'Maximum reasoning' },
        ],
      },
    },
    {
      value: 'kimi-code/k3-256k',
      label: 'K3 256K',
      description: 'Kimi Code · 256K context',
      effort: {
        default: 'max',
        values: [
          { value: 'low' },
          { value: 'high' },
          { value: 'max' },
        ],
      },
    },
    {
      value: 'kimi-code/kimi-for-coding',
      label: 'Kimi K2.7 Code',
      description: 'Kimi Code · standard speed',
    },
    {
      value: 'kimi-code/kimi-for-coding-highspeed',
      label: 'Kimi K2.7 Code Highspeed',
      description: 'Kimi Code · high speed',
    },
  ],
  DEFAULT: 'kimi-code/k3',
};

const toStringArray = (value: unknown): string[] => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && Boolean(entry.trim()))
    : []
);

const titleFromAlias = (alias: string): string => alias
  .split('/').pop()!
  .split(/[-_]/g)
  .filter(Boolean)
  .map((part) => part.toUpperCase() === 'K3' ? 'K3' : part.charAt(0).toUpperCase() + part.slice(1))
  .join(' ');

/** Parse `kimi provider list --json` while tolerating SDK camelCase and TOML snake_case fields. */
export function parseKimiProviderModels(raw: unknown): ProviderModelsDefinition | null {
  const root = readObjectRecord(raw);
  if (!root) return null;
  const models = readObjectRecord(root?.models);
  if (!models || Object.keys(models).length === 0) {
    return null;
  }

  const options: ProviderModelOption[] = [];
  for (const [alias, rawModel] of Object.entries(models)) {
    const model = readObjectRecord(rawModel);
    if (!model) continue;
    const efforts = toStringArray(model.supportEfforts ?? model.support_efforts);
    const defaultEffort = readOptionalString(model.defaultEffort ?? model.default_effort);
    const displayName = readOptionalString(model.displayName ?? model.display_name) ?? titleFromAlias(alias);
    const provider = readOptionalString(model.provider);
    const option: ProviderModelOption = {
      value: alias,
      label: displayName,
      description: provider ? `Kimi CLI · ${provider}` : 'Kimi CLI',
    };
    if (efforts.length > 0) {
      option.effort = {
        default: defaultEffort,
        values: efforts.map((value) => ({ value })),
      };
    }
    options.push(option);
  }

  if (options.length === 0) return null;
  const defaultModel = readOptionalString(root.defaultModel ?? root.default_model);
  return {
    OPTIONS: options.sort((left, right) => left.label.localeCompare(right.label)),
    DEFAULT: defaultModel && options.some((option) => option.value === defaultModel)
      ? defaultModel
      : options[0]!.value,
  };
}

async function readLatestSessionModel(wirePath: string): Promise<string | null> {
  try {
    const lines = (await readFile(wirePath, 'utf8')).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      try {
        const record = readObjectRecord(JSON.parse(line));
        if (record?.type === 'config.update') {
          const model = readOptionalString(record.modelAlias ?? record.model);
          if (model) return model;
        }
        if (record?.type === 'profile.bind') {
          const model = readOptionalString(record.modelAlias);
          if (model) return model;
        }
      } catch {
        // Ignore a malformed/truncated journal line.
      }
    }
  } catch {
    // The session may not have been persisted yet.
  }
  return null;
}

export class KimiProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const result = spawn.sync('kimi', ['provider', 'list', '--json'], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (!result.error && result.status === 0 && result.stdout?.trim()) {
        const dynamic = parseKimiProviderModels(JSON.parse(result.stdout));
        if (dynamic) return dynamic;
      }
    } catch {
      // Installation/auth may not be ready yet; the curated catalog keeps the UI usable.
    }
    return KIMI_PREDEFINED_MODELS;
  }

  async getCurrentActiveModel(sessionId?: string): Promise<ProviderCurrentActiveModel> {
    const catalog = await this.getSupportedModels();
    if (!sessionId?.trim()) {
      return buildDefaultProviderCurrentActiveModel(catalog);
    }

    const session = sessionsDb.getSessionById(sessionId)
      ?? sessionsDb.getSessionByProviderSessionId(sessionId);
    const wirePath = session?.jsonl_path;
    if (wirePath) {
      const model = await readLatestSessionModel(path.resolve(wirePath));
      if (model) return { model };
    }

    return buildDefaultProviderCurrentActiveModel(catalog);
  }
}
