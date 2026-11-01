import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GiteaVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
  VcsValidationError,
} from '../src/index.js';

describe('GiteaVcsAdapter', () => {
  it('should target sovereign Gitea at port 3300 by default with token auth', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const adapter = new GiteaVcsAdapter({
      token: 'edef121158c5e714608f878af97b49c920ec4b37',
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 17,
          name: 'acr-meta-mcp',
          full_name: 'ACR/acr-meta-mcp',
          description: 'ACR Meta-MCP Forward Proxy',
          default_branch: 'main',
          private: false,
          clone_url: 'http://127.0.0.1:3300/ACR/acr-meta-mcp.git',
          html_url: 'http://127.0.0.1:3300/ACR/acr-meta-mcp',
          owner: { username: 'ACR' },
          stars_count: 12,
          forks_count: 3,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('ACR', 'acr-meta-mcp');
    assert.ok(capturedUrl.startsWith('http://127.0.0.1:3300/api/v1/repos/ACR/acr-meta-mcp'));
    assert.equal(capturedHeaders['Authorization'], 'token edef121158c5e714608f878af97b49c920ec4b37');
    assert.equal(repo.name, 'acr-meta-mcp');
    assert.equal(repo.fullName, 'ACR/acr-meta-mcp');
    assert.equal(repo.owner, 'ACR');
    assert.equal(repo.starsCount, 12);
  });

  it('should list repositories with fallback to org endpoint', async () => {
    let calls: string[] = [];
    const adapter = new GiteaVcsAdapter({
      fetchFn: async (url) => {
        const u = String(url);
        calls.push(u);
        if (u.includes('/users/ACR/repos')) {
          return new Response('Not found', { status: 404 });
        }
        if (u.includes('/orgs/ACR/repos')) {
          return new Response(JSON.stringify([
            {
              id: 1,
              name: 'acr-core',
              full_name: 'ACR/acr-core',
              default_branch: 'main',
              private: false,
              owner: { login: 'ACR' },
            }
          ]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('[]', { status: 200 });
      },
    });

    const repos = await adapter.listRepositories('ACR');
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'acr-core');
    assert.ok(calls.some(c => c.includes('/orgs/ACR/repos')));
  });

  it('should list branches', async () => {
    const adapter = new GiteaVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          { name: 'main', commit: { id: 'commit-sha-gt-1' }, protected: true },
          { name: 'vri-300', commit: { id: 'commit-sha-gt-2' }, protected: false },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const branches = await adapter.listBranches('ACR', 'acr-meta-mcp');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[0].commitSha, 'commit-sha-gt-1');
    assert.equal(branches[0].isProtected, true);
  });

  it('should get, list, and create pull requests', async () => {
    let createdBody: any = null;
    const adapter = new GiteaVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          createdBody = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 101,
            number: 7,
            title: createdBody.title,
            body: createdBody.body,
            state: 'open',
            head: { ref: createdBody.head },
            base: { ref: createdBody.base },
            user: { username: 'gitea-user' },
            html_url: 'http://127.0.0.1:3300/ACR/acr-meta-mcp/pulls/7',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 101,
            number: 7,
            title: 'Implement Git VCS Catalog',
            body: 'VRI-300 complete',
            state: 'closed',
            merged: true,
            head: { ref: 'feat/vcs-catalog' },
            base: { ref: 'main' },
            user: { username: 'gitea-user' },
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T02:00:00Z',
            merged_at: '2026-11-01T02:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createPullRequest('ACR', 'acr-meta-mcp', {
      title: 'Implement Git VCS Catalog',
      body: 'VRI-300 complete',
      sourceBranch: 'feat/vcs-catalog',
      targetBranch: 'main',
    });
    assert.equal(created.number, 7);
    assert.equal(createdBody.head, 'feat/vcs-catalog');

    const prs = await adapter.listPullRequests('ACR', 'acr-meta-mcp', 'closed');
    assert.equal(prs.length, 1);
    assert.equal(prs[0].state, 'merged');
  });

  it('should list commits', async () => {
    const adapter = new GiteaVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          {
            sha: 'gitea-sha-99',
            commit: {
              message: 'chore: sync ecosystem state',
              author: { name: 'ACR Orchestrator', date: '2026-11-01T07:20:00Z' },
            },
            html_url: 'http://127.0.0.1:3300/commit/99',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('ACR', 'acr-meta-mcp');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'gitea-sha-99');
    assert.equal(commits[0].message, 'chore: sync ecosystem state');
  });

  it('should decode base64 file content', async () => {
    const sample = 'Gitea sovereign local git file';
    const b64 = Buffer.from(sample).toString('base64');
    const adapter = new GiteaVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          name: 'VERSION',
          path: 'VERSION',
          encoding: 'base64',
          content: b64,
          size: sample.length,
          sha: 'shablob11',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const file = await adapter.getFileContent('ACR', 'acr-meta-mcp', 'VERSION');
    assert.equal(file.path, 'VERSION');
    assert.equal(file.content, sample);
    assert.equal(file.encoding, 'utf-8');
  });

  it('should create and list issues', async () => {
    const adapter = new GiteaVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 301,
            number: 14,
            title: 'Sovereign cluster sync',
            body: 'Verify JetStream bridge',
            state: 'open',
            user: { username: 'dev-1' },
            labels: [{ name: 'enhancement' }],
            created_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 301,
            number: 14,
            title: 'Sovereign cluster sync',
            state: 'open',
            user: { username: 'dev-1' },
            created_at: '2026-11-01T00:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createIssue('ACR', 'acr-meta-mcp', { title: 'Sovereign cluster sync' });
    assert.equal(created.number, 14);
    assert.equal(created.state, 'open');

    const issues = await adapter.listIssues('ACR', 'acr-meta-mcp');
    assert.equal(issues.length, 1);
  });

  it('should execute health check against /version', async () => {
    const adapter = new GiteaVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({ version: '1.22.3' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    const health = await adapter.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.version, '1.22.3');
  });

  it('should map errors accurately', async () => {
    const authAdapter = new GiteaVcsAdapter({
      fetchFn: async () => new Response('Invalid token', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError
    );

    const notFoundAdapter = new GiteaVcsAdapter({
      fetchFn: async () => new Response('Repository does not exist', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError
    );

    const rateLimitAdapter = new GiteaVcsAdapter({
      fetchFn: async () => new Response('Rate limited', { status: 429 }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError
    );

    const valAdapter = new GiteaVcsAdapter({
      fetchFn: async () => new Response(JSON.stringify({ message: 'Title is empty' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      async () => valAdapter.createIssue('o', 'r', { title: '' }),
      (err: any) => err instanceof VcsValidationError
    );
  });
});
