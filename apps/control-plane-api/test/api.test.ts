import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MetaMcpServer } from '../src/server.js';

describe('Meta-MCP Control Plane API & JSON-RPC Gateway', () => {
  const TEST_PORT = 29445;
  const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;
  let server: MetaMcpServer;

  before(async () => {
    server = new MetaMcpServer();
    await server.start({ port: TEST_PORT, host: '127.0.0.1' });
  });

  after(async () => {
    await server.stop();
  });

  it('GET /health should return ONLINE status and version', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'ONLINE');
    assert.equal(json.version, '0.8.2');
    assert.ok(json.serverCount >= 2);
  });

  it('GET /api/v1/meta-mcp/servers should list registered servers', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.ok(Array.isArray(json.servers));
    assert.ok(json.count >= 2);
    const gitee = json.servers.find((s: any) => s.id === 'gitee-cloud');
    assert.ok(gitee);
    assert.equal(gitee.healthStatus, 'ONLINE');
  });

  it('POST /api/v1/meta-mcp/servers/import should ingest mcp_config.json cleanly', async () => {
    const importPayload = {
      mcpServers: {
        'github-ci-bot': {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp_secret_token_val_123456789' }
        }
      }
    };

    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acr-agent-did': 'did:key:test-admin' },
      body: JSON.stringify(importPayload),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.success, true);
    assert.ok(json.installedServers.includes('github-ci-bot'));
    assert.equal(json.secretCount, 1);
  });

  it('POST /api/v1/meta-mcp/servers/:id/toggle should enable/disable server', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/workspace-fs/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.server.enabled, false);

    // Re-enable
    await fetch(`${BASE_URL}/api/v1/meta-mcp/servers/workspace-fs/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('GET /api/v1/meta-mcp/tools should project tools for caller', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools?view=projected`, {
      headers: { 'x-acr-agent-did': 'did:key:agent-claude', 'x-acr-role': 'agent' },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.ok(Array.isArray(json.tools));
    assert.ok(json.tools.some((t: any) => t.name === 'gitee-cloud__create_issue'));
  });

  it('POST /api/v1/meta-mcp/tools/call should execute governed tool call', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acr-agent-did': 'did:key:agent-claude' },
      body: JSON.stringify({
        toolName: 'gitee-cloud__create_issue',
        args: { title: 'E2E Verified Meta-MCP Forward Proxy' }
      }),
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'SUCCESS');
    assert.ok(json.result.content[0].text.includes('created successfully'));
    assert.ok(json.latencyMs >= 0);
  });

  it('POST /mcp should handle JSON-RPC initialize and tools/list', async () => {
    const initRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {}
      }),
    });

    assert.equal(initRes.status, 200);
    const initJson = (await initRes.json()) as any;
    assert.equal(initJson.result.serverInfo.name, 'acr-meta-mcp-proxy');

    const listRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {}
      }),
    });

    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as any;
    assert.ok(Array.isArray(listJson.result.tools));
  });

  it('GET /api/v1/meta-mcp/audit should return recorded audit logs', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/meta-mcp/audit?limit=10`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.ok(Array.isArray(json.logs));
    assert.ok(json.count > 0);
  });
});
