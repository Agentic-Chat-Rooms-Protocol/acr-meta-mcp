import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ForgejoVcsAdapter } from '../src/index.js';

describe('ForgejoVcsAdapter', () => {
  it('should use Codeberg by default and include Forgejo User-Agent', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const adapter = new ForgejoVcsAdapter({
      token: 'forgejo-secret-token-77',
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 55,
          name: 'forgejo-project',
          full_name: 'community/forgejo-project',
          default_branch: 'main',
          private: false,
          html_url: 'https://codeberg.org/community/forgejo-project',
          owner: { username: 'community' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('community', 'forgejo-project');
    assert.ok(capturedUrl.startsWith('https://codeberg.org/api/v1/repos/community/forgejo-project'));
    assert.equal(capturedHeaders['Authorization'], 'token forgejo-secret-token-77');
    assert.equal(capturedHeaders['User-Agent'], 'ACR-Meta-MCP/1.0.0 (ForgejoAdapter)');
    assert.equal(adapter.providerType, 'forgejo');
    assert.equal(repo.name, 'forgejo-project');
  });

  it('should execute healthCheck and return Forgejo version', async () => {
    const adapter = new ForgejoVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({ version: '7.0.4-forgejo' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const health = await adapter.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.version, '7.0.4-forgejo');
  });

  it('should handle PR operations seamlessly', async () => {
    const adapter = new ForgejoVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          {
            id: 200,
            number: 1,
            title: 'Federation support',
            state: 'open',
            head: { ref: 'federation' },
            base: { ref: 'main' },
            user: { username: 'forgejo-user' },
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const prs = await adapter.listPullRequests('community', 'forgejo-project');
    assert.equal(prs.length, 1);
    assert.equal(prs[0].title, 'Federation support');
  });
});
