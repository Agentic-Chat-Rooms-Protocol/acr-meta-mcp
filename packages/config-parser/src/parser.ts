import { RawMcpConfig, RawServerConfig, SanitizedServerSpec, TransportType } from './types.js';
import { sanitizeEnvAndHeaders } from './sanitizer.js';

export class ConfigParseError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ConfigParseError';
  }
}

export function parseRawConfig(input: string | RawMcpConfig): RawMcpConfig {
  if (typeof input === 'string') {
    try {
      return JSON.parse(input) as RawMcpConfig;
    } catch (err: any) {
      throw new ConfigParseError(`Invalid JSON syntax in MCP configuration: ${err.message}`, err);
    }
  }
  return input;
}

export function deduceTransport(config: RawServerConfig): TransportType {
  if ('command' in config && typeof config.command === 'string') {
    return 'stdio';
  }
  if ('url' in config && typeof config.url === 'string') {
    if (config.transport === 'streamable_http' || config.url.includes('/mcp')) {
      return 'streamable_http';
    }
    return 'sse';
  }
  throw new ConfigParseError('Unable to deduce transport: entry must contain either "command" or "url".', config);
}

export function parseAndSanitizeServer(
  serverId: string,
  config: RawServerConfig,
  domain: 'personal' | 'org' | 'enterprise' | 'ephemeral' = 'personal'
): SanitizedServerSpec {
  const transport = deduceTransport(config);

  if (transport === 'stdio') {
    const stdioConf = config as { command: string; args?: string[]; env?: Record<string, string> };
    if (!stdioConf.command || typeof stdioConf.command !== 'string') {
      throw new ConfigParseError(`Server "${serverId}" has missing or invalid "command" field.`);
    }

    const { sanitized, secretRefs } = sanitizeEnvAndHeaders(serverId, stdioConf.env, domain);

    return {
      serverId,
      displayName: serverId,
      transport: 'stdio',
      stdioSpec: {
        command: stdioConf.command,
        args: Array.isArray(stdioConf.args) ? stdioConf.args : [],
        envRefs: sanitized,
      },
      secretRefs,
    };
  }

  const remoteConf = config as { url: string; headers?: Record<string, string>; transport?: 'sse' | 'streamable_http' };
  if (!remoteConf.url || typeof remoteConf.url !== 'string') {
    throw new ConfigParseError(`Server "${serverId}" has missing or invalid "url" field.`);
  }

  const { sanitized, secretRefs } = sanitizeEnvAndHeaders(serverId, remoteConf.headers, domain);

  return {
    serverId,
    displayName: serverId,
    transport,
    remoteSpec: {
      url: remoteConf.url,
      headerRefs: sanitized,
    },
    secretRefs,
  };
}
