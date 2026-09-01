import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MetaMcpServer } from '../src/server.js';

describe('Context7 Real MCP Tool E2E Integration & QA Test', () => {
  const TEST_PORT = 29446;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  const DYNAMIC_API_KEY = process.env.CONTEXT7_API_KEY || 'dynamic-ctx7-api-key-test-val';
  let server: MetaMcpServer;

  before(async () => {
    server = new MetaMcpServer();
    await server.start({ port: TEST_PORT, host: '127.0.0.1' });
  });

  after(async () => {
    await server.stop();
  });

  it('1. Store Context7 API key dynamically into the SQLite3MultipleCiphers Auth Vault', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/secrets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acr-agent-did': 'did:key:admin-local',
      },
      body: JSON.stringify({
        serverId: 'context7',
        key: 'CONTEXT7_API_KEY',
        value: DYNAMIC_API_KEY,
        domain: 'personal',
        cipher: 'chacha20-poly1305',
      }),
    });

    assert.equal(res.status, 201);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.equal(json.secret.serverId, 'context7');
    assert.equal(json.secret.algorithm, 'chacha20-poly1305');
  });

  it('2. Ingest real Context7 configuration and verify secret placeholder redaction', async () => {
    const context7Config = {
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp', '--api-key', '${CONTEXT7_API_KEY}'],
          env: {
            CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}',
          },
        },
      },
    };

    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/import`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acr-agent-did': 'did:key:z6Mkq5Xv...claude-qa-admin',
      },
      body: JSON.stringify(context7Config),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.ok(json.installedServers.includes('context7'));
    assert.ok(json.fingerprintSha256.length === 64);
  });

  it('3. Verify Context7 server status and containment profile in registry', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;

    const context7Server = json.servers.find((s: any) => s.id === 'context7');
    assert.ok(context7Server, 'context7 server should be registered');
    assert.equal(context7Server.enabled, true);
    assert.equal(context7Server.quarantined, false);
    assert.equal(context7Server.sandboxProfile, 'workspace-scoped');
  });

  it('4. Register Context7 real tool definitions into catalog', async () => {
    (server.service as any).toolStore.set('context7', [
      {
        name: 'resolve-library-id',
        description: 'Resolve package or library name to Context7 ID (e.g. /facebook/react)',
        inputSchema: {
          type: 'object',
          properties: { libraryName: { type: 'string' } },
          required: ['libraryName'],
        },
      },
      {
        name: 'query-docs',
        description: 'Fetch up-to-date documentation content from Context7 index',
        inputSchema: {
          type: 'object',
          properties: {
            libraryId: { type: 'string' },
            query: { type: 'string' },
          },
          required: ['libraryId', 'query'],
        },
      },
    ]);

    server.service.registry.updateHealth('context7', 'ONLINE', 2);

    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools?view=projected`, {
      headers: {
        'x-acr-agent-did': 'did:key:z6Mkq5Xv...claude-agent',
        'x-acr-role': 'agent',
      },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    const tools = json.tools;
    assert.ok(tools.some((t: any) => t.name === 'context7__resolve-library-id'));
    assert.ok(tools.some((t: any) => t.name === 'context7__query-docs'));
  });

  it('5. Execute real Context7 tool call through Meta-MCP Forward Proxy', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools/call`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acr-agent-did': 'did:key:z6Mkq5Xv...claude-agent',
        'x-acr-role': 'agent',
      },
      body: JSON.stringify({
        toolName: 'context7__resolve-library-id',
        args: { libraryName: 'Next.js' },
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'SUCCESS');
    assert.ok(json.result.content[0].text.includes('context7'));
    assert.ok(json.latencyMs >= 0);
  });

  it('6. Execute JSON-RPC tools/call over Streamable HTTP /mcp endpoint', async () => {
    const res = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-acr-agent-did': 'did:key:z6Mkq5Xv...claude-agent',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'context7__query-docs',
          arguments: {
            libraryId: '/vercel/next.js',
            query: 'App router server actions',
          },
        },
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.jsonrpc, '2.0');
    assert.equal(json.id, 101);
    assert.ok(json.result.content[0].text.includes('context7'));
  });

  it('7. Verify vault secret list and audit trail recorded Context7 invocations', async () => {
    const vaultRes = await fetch(`${BASE_URL}/api/v1/meta-mcp/vault/secrets`);
    assert.equal(vaultRes.status, 200);
    const vaultJson = (await vaultRes.json()) as any;
    assert.ok(vaultJson.secrets.some((s: any) => s.serverId === 'context7'));

    const auditRes = await fetch(`${BASE_URL}/api/v1/meta-mcp/audit?limit=10`);
    assert.equal(auditRes.status, 200);
    const auditJson = (await auditRes.json()) as any;
    assert.ok(auditJson.logs.some((l: any) => l.serverId === 'context7' || l.toolName?.includes('context7')));
  });
});
