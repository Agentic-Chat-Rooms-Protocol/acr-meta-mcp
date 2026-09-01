#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const BASE_URL = process.env.ACR_META_MCP_URL || 'http://127.0.0.1:20445';

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
  acr-meta-mcp audit
`);
  }
}

main().catch((err) => {
  console.error('[ACR Meta-MCP CLI] Error:', err.message);
  process.exit(1);
});
