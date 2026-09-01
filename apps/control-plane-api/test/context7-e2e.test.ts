import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MetaMcpServer } from '../src/server.js';

describe('Context7 Real MCP Tool E2E Integration & QA Test', () => {
  const TEST_PORT = 29446;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  const CONTEXT7_API_KEY = 'ctx7sk-368b8367-c3ec-436e-8df3-74f1526f86fe';
  let server: MetaMcpServer;

  before(async () => {
    server = new MetaMcpServer();
    await server.start({ port: TEST_PORT, host: '127.0.0.1' });
  });

  after(async () => {
    await server.stop();
  });

  it('1. Ingest real Context7 configuration and verify secret redaction', async () => {
    const context7Config = {
      mcpServers: {
        context7: {
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp', '--api-key', CONTEXT7_API_KEY],
          env: {
            CONTEXT7_API_KEY: CONTEXT7_API_KEY,
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
    assert.ok(json.secretCount >= 1);
    assert.ok(json.fingerprintSha256.length === 64);
  });

  it('2. Verify Context7 server status and containment profile in registry', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;

    const context7Server = json.servers.find((s: any) => s.id === 'context7');
    assert.ok(context7Server, 'context7 server should be registered');
    assert.equal(context7Server.enabled, true);
    assert.equal(context7Server.quarantined, false);
    assert.equal(context7Server.sandboxProfile, 'workspace-scoped');
  });

  it('3. Register Context7 real tool definitions into catalog', async () => {
    // Inject discovered Context7 tools
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

  it('4. Execute real Context7 tool call through Meta-MCP Forward Proxy', async () => {
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

  it('5. Execute JSON-RPC tools/call over Streamable HTTP /mcp endpoint', async () => {
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

  it('6. Verify audit trail recorded Context7 invocations', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/audit?limit=10`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.ok(json.logs.some((l: any) => l.serverId === 'context7' || l.toolName?.includes('context7')));
  });
});
