import { createHash } from 'node:crypto';
import { InstallManifest, RawMcpConfig, SanitizedServerSpec } from './types.js';
import { parseAndSanitizeServer, parseRawConfig } from './parser.js';

export function compileInstallManifest(
  input: string | RawMcpConfig,
  domain: 'personal' | 'org' | 'enterprise' | 'ephemeral' = 'personal'
): InstallManifest {
  const raw = parseRawConfig(input);
  const mcpServers = raw.mcpServers ?? {};

  const servers: SanitizedServerSpec[] = [];
  let totalSecretRefs = 0;

  for (const [serverId, config] of Object.entries(mcpServers)) {
    const sanitized = parseAndSanitizeServer(serverId, config, domain);
    servers.push(sanitized);
    totalSecretRefs += sanitized.secretRefs.length;
  }

  // Deterministic canonical payload for SHA-256 fingerprint
  const canonicalPayload = JSON.stringify({
    v: '1.0.0',
    servers: servers.map((s) => ({
      id: s.serverId,
      transport: s.transport,
      stdio: s.stdioSpec,
      remote: s.remoteSpec,
    })),
  });

  const fingerprintSha256 = createHash('sha256').update(canonicalPayload).digest('hex');

  return {
    manifestVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    fingerprintSha256,
    servers,
    totalServers: servers.length,
    totalSecretRefs,
  };
}
