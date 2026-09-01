#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE_URL = process.env.ACR_META_MCP_URL || 'http://127.0.0.1:20445';

const DEFAULT_SERVICES = [
  { id: 'acr-core', name: 'ACR Core Daemon', envVar: 'ACR_CORE_PORT', defaultPort: 20443, healthPath: '/health' },
  { id: 'acr-meta-mcp', name: 'Meta-MCP Forward Proxy', envVar: 'ACR_META_MCP_PORT', defaultPort: 20445, healthPath: '/health' },
  { id: 'acr-bridge', name: 'ACR MCP Bridge', envVar: 'ACR_BRIDGE_PORT', defaultPort: 20444, healthPath: '/health' },
  { id: 'nats-jetstream', name: 'Internal NATS Broker', envVar: 'ACR_NATS_PORT', defaultPort: 4222, healthPath: '' },
  { id: 'gitea', name: 'Local Ecosystem Gitea', envVar: 'ACR_GITEA_PORT', defaultPort: 3300, healthPath: '/api/v1/version' },
];

function getPortsConfigFile(): string {
  const dir = join(homedir(), '.acr');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, 'ports.json');
}

function loadPortOverrides(): Record<string, number> {
  const file = getPortsConfigFile();
  if (!existsSync(file)) return {};
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed.ports || {};
  } catch {
    return {};
  }
}

function savePortOverrides(overrides: Record<string, number>): void {
  const file = getPortsConfigFile();
  const data = {
    version: '1.0.0',
    updatedAt: new Date().toISOString(),
    ports: overrides,
  };
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

function resolveServicePort(s: (typeof DEFAULT_SERVICES)[0], overrides: Record<string, number>): number {
  if (process.env[s.envVar] && !isNaN(Number(process.env[s.envVar]))) {
    return Number(process.env[s.envVar]);
  }
  return overrides[s.id] || s.defaultPort;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';

  switch (command) {
    case 'health': {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'list':
    case 'servers': {
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers`);
      const data = (await res.json()) as any;
      console.log('\n======================================================');
      console.log(' ACR META-MCP REGISTERED SERVERS');
      console.log('======================================================');
      for (const s of data.servers || []) {
        const state = s.enabled ? (s.quarantined ? 'QUARANTINE' : s.healthStatus) : 'DISABLED';
        console.log(` • [${state.padEnd(10)}] ${s.id.padEnd(20)} | ${s.transport.padEnd(16)} | ${s.displayName} (${s.toolCount} tools)`);
      }
      console.log(`\nTotal: ${data.count} registered servers\n`);
      break;
    }

    case 'import': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: acr-meta-mcp import <path/to/mcp_config.json>');
        process.exit(1);
      }
      const rawContent = readFileSync(filePath, 'utf-8');
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawContent,
      });
      const data = await res.json();
      console.log('[ACR Meta-MCP] Config Imported:', JSON.stringify(data, null, 2));
      break;
    }

    case 'enable':
    case 'disable': {
      const serverId = args[1];
      if (!serverId) {
        console.error(`Usage: acr-meta-mcp ${command} <serverId>`);
        process.exit(1);
      }
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/${serverId}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: command === 'enable' }),
      });
      const data = await res.json();
      console.log(`[ACR Meta-MCP] Server ${serverId} updated:`, data);
      break;
    }

    case 'tools': {
      const view = args[1] || 'projected';
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools?view=${view}`);
      const data = (await res.json()) as any;
      console.log(`\n======================================================`);
      console.log(` ACR META-MCP CATALOG (${view.toUpperCase()})`);
      console.log(`======================================================`);
      for (const t of data.tools || []) {
        console.log(` • ${t.name.padEnd(32)} | [${t.serverId}] ${t.description}`);
      }
      console.log(`\nTotal tools: ${data.tools?.length || 0}\n`);
      break;
    }

    case 'call': {
      const toolName = args[1];
      const jsonArgs = args[2] ? JSON.parse(args[2]) : {};
      if (!toolName) {
        console.error('Usage: acr-meta-mcp call <tool_name> [json_args]');
        process.exit(1);
      }
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName, arguments: jsonArgs }),
      });
      const data = await res.json();
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'vault': {
      const subAction = args[1] || 'list';
      if (subAction === 'list') {
        const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/secrets`);
        const data = (await res.json()) as any;
        console.log('\n======================================================');
        console.log(' ACR META-MCP AUTH VAULT SECRETS (ENCRYPTED DATABASE)');
        console.log('======================================================');
        for (const s of data.secrets || []) {
          console.log(` • [${s.domain.padEnd(10)}] ${s.refId.padEnd(32)} | ${s.serverId.padEnd(16)} | Cipher: ${s.algorithm || 'aes-256-gcm'}`);
        }
        console.log(`\nTotal vaulted secrets: ${data.count}\n`);
      } else if (subAction === 'set') {
        const serverId = args[2];
        const key = args[3];
        const value = args[4];
        if (!serverId || !key || !value) {
          console.error('Usage: acr-meta-mcp vault set <serverId> <key> <value> [domain] [cipher]');
          process.exit(1);
        }
        const domain = args[5] || 'personal';
        const cipher = args[6] || 'aes-256-gcm';
        const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/secrets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, key, value, domain, cipher }),
        });
        const data = await res.json();
        console.log('[ACR Meta-MCP Vault] Stored secret:', data);
      } else if (subAction === 'delete') {
        const refId = args[2];
        if (!refId) {
          console.error('Usage: acr-meta-mcp vault delete <refId>');
          process.exit(1);
        }
        const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/secrets/${refId}`, {
          method: 'DELETE',
        });
        const data = await res.json();
        console.log('[ACR Meta-MCP Vault] Deleted secret:', data);
      } else if (subAction === 'rotate') {
        const newMasterSecret = args[2];
        if (!newMasterSecret) {
          console.error('Usage: acr-meta-mcp vault rotate <newMasterPassphrase>');
          process.exit(1);
        }
        const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/rotate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newMasterSecret }),
        });
        const data = await res.json();
        console.log('[ACR Meta-MCP Vault] Master key rotated:', data);
      } else {
        console.error('Unknown vault action. Valid: list | set | delete | rotate');
      }
      break;
    }

    case 'ports': {
      const subAction = args[1] || 'list';
      const overrides = loadPortOverrides();

      if (subAction === 'list') {
        console.log('\n======================================================');
        console.log(' ACR ECOSYSTEM SERVICE PORT MAPPINGS');
        console.log('======================================================');
        for (const s of DEFAULT_SERVICES) {
          const port = resolveServicePort(s, overrides);
          const isCustom = port !== s.defaultPort;
          const badge = isCustom ? '[CUSTOM]' : '[DEFAULT]';
          console.log(` • ${badge.padEnd(10)} ${s.name.padEnd(24)} -> :${port.toString().padEnd(6)} ($${s.envVar})`);
        }
        console.log(`\nConfig file: ${getPortsConfigFile()}\n`);
      } else if (subAction === 'set') {
        const serviceId = args[2];
        const portNum = parseInt(args[3], 10);
        if (!serviceId || isNaN(portNum)) {
          console.error('Usage: acr-meta-mcp ports set <service-id> <port>');
          console.error(`Available services: ${DEFAULT_SERVICES.map((s) => s.id).join(', ')}`);
          process.exit(1);
        }
        if (portNum < 1024 || portNum > 65535) {
          console.error('[ERROR] Port must be between 1024 and 65535.');
          process.exit(1);
        }
        const found = DEFAULT_SERVICES.find((s) => s.id === serviceId);
        if (!found) {
          console.error(`[ERROR] Unknown service "${serviceId}". Valid: ${DEFAULT_SERVICES.map((s) => s.id).join(', ')}`);
          process.exit(1);
        }
        overrides[serviceId] = portNum;
        savePortOverrides(overrides);
        console.log(`[SUCCESS] Port for "${serviceId}" set to :${portNum} in ~/.acr/ports.json`);
      } else if (subAction === 'reset') {
        const serviceId = args[2];
        if (serviceId) {
          delete overrides[serviceId];
          savePortOverrides(overrides);
          console.log(`[SUCCESS] Reset port for "${serviceId}" to default.`);
        } else {
          const file = getPortsConfigFile();
          if (existsSync(file)) unlinkSync(file);
          console.log('[SUCCESS] All service ports reset to factory defaults.');
        }
      } else if (subAction === 'test') {
        console.log('\n======================================================');
        console.log(' TESTING SERVICE PORT CONNECTIVITY');
        console.log('======================================================');
        for (const s of DEFAULT_SERVICES) {
          const port = resolveServicePort(s, overrides);
          if (!s.healthPath) {
            console.log(` • [ONLINE]  ${s.name.padEnd(24)} :${port} (TCP socket assumed reachable)`);
            continue;
          }
          const start = Date.now();
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 1500);
            const res = await fetch(`http://localhost:${port}${s.healthPath}`, { signal: controller.signal });
            clearTimeout(timeout);
            const latency = Date.now() - start;
            console.log(` • [ONLINE]  ${s.name.padEnd(24)} :${port} (${latency}ms) [HTTP ${res.status}]`);
          } catch {
            console.log(` • [OFFLINE] ${s.name.padEnd(24)} :${port} (unreachable)`);
          }
        }
        console.log('');
      } else if (subAction === 'export') {
        const asJson = args.includes('--json');
        if (asJson) {
          const obj: Record<string, number> = {};
          for (const s of DEFAULT_SERVICES) obj[s.id] = resolveServicePort(s, overrides);
          console.log(JSON.stringify({ version: '1.0.0', ports: obj }, null, 2));
        } else {
          console.log('# ACR Ecosystem Dynamic Port Configuration');
          for (const s of DEFAULT_SERVICES) {
            console.log(`${s.envVar}=${resolveServicePort(s, overrides)}`);
          }
          console.log(`ACR_DAEMON_URL=http://localhost:${resolveServicePort(DEFAULT_SERVICES[0], overrides)}`);
          console.log(`ACR_META_MCP_URL=http://localhost:${resolveServicePort(DEFAULT_SERVICES[1], overrides)}`);
        }
      } else {
        console.error('Unknown ports action. Valid: list | set | reset | test | export');
      }
      break;
    }

    case 'audit': {
      const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/audit?limit=20`);
      const data = (await res.json()) as any;
      console.log('\n======================================================');
      console.log(' ACR META-MCP AUDIT TRAIL');
      console.log('======================================================');
      for (const a of data.logs || []) {
        console.log(` [${a.timestamp.slice(11, 19)}] ${a.eventType.padEnd(18)} | ${a.status.padEnd(8)} | ${a.actorDid} -> ${a.toolName || a.serverId || ''} (${a.latencyMs?.toFixed(2)}ms)`);
      }
      console.log('');
      break;
    }

    default:
      console.log(`
ACR Meta-MCP Forward Proxy CLI (v0.8.2)

Usage:
  acr-meta-mcp health
  acr-meta-mcp list
  acr-meta-mcp import <path/to/mcp_config.json>
  acr-meta-mcp enable <serverId>
  acr-meta-mcp disable <serverId>
  acr-meta-mcp tools [raw|policy|projected]
  acr-meta-mcp call <tool_name> [json_args]
  acr-meta-mcp vault [list|set|delete|rotate]
  acr-meta-mcp ports [list|set|reset|test|export]
  acr-meta-mcp audit
`);
  }
}

main().catch((err) => {
  console.error('[ACR Meta-MCP CLI] Error:', err.message);
  process.exit(1);
});
