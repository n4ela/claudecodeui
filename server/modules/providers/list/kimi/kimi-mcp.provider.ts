import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readJsonConfig,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
  writeJsonConfig,
} from '@/shared/utils.js';

import { getKimiCodeHome } from './kimi-paths.js';

export class KimiMcpProvider extends McpProvider {
  constructor() {
    super('kimi', ['user', 'project'], ['stdio', 'http', 'sse']);
  }

  private configPath(scope: McpScope, workspacePath: string): string {
    return scope === 'user'
      ? path.join(getKimiCodeHome(), 'mcp.json')
      : path.join(workspacePath, '.kimi-code', 'mcp.json');
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(this.configPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = this.configPath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED', statusCode: 400,
        });
      }
      return {
        transport: 'stdio',
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        cwd: input.cwd,
        enabled: true,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for remote MCP servers.', {
        code: 'MCP_URL_REQUIRED', statusCode: 400,
      });
    }
    return {
      transport: input.transport,
      url: input.url,
      headers: input.headers ?? {},
      bearerTokenEnvVar: input.bearerTokenEnvVar,
      enabled: true,
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) return null;
    const command = readOptionalString(config.command);
    if (command) {
      return {
        provider: 'kimi', name, scope, transport: 'stdio', command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
      };
    }
    const url = readOptionalString(config.url);
    if (!url) return null;
    return {
      provider: 'kimi', name, scope,
      transport: config.transport === 'sse' ? 'sse' : 'http',
      url,
      headers: readStringRecord(config.headers),
      bearerTokenEnvVar: readOptionalString(config.bearerTokenEnvVar),
    };
  }
}
