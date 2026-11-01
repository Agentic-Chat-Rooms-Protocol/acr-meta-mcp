import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GiteeVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
} from '../src/index.js';

describe('GiteeVcsAdapter', () => {
  it('should authenticate with token and query Gitee v5 API', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const adapter = new GiteeVcsAdapter({
      token: 'gitee_pat_secret_123',
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 777,
          name: 'agentic-bridge',
          full_name: 'oschina/agentic-bridge',
          description: 'Gitee bridge for agents',
          default_branch: 'master',
          private: false,
          html_url: 'https://gitee.com/oschina/agentic-bridge',
          owner: { login: 'oschina' },
          stargazers_count: 88,
          forks_count: 15,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('oschina', 'agentic-bridge');
    assert.ok(capturedUrl.startsWith('https://gitee.com/api/v5/repos/oschina/agentic-bridge'));
    assert.equal(capturedHeaders['Authorization'], 'token gitee_pat_secret_123');
    assert.equal(repo.name, 'agentic-bridge');
    assert.equal(repo.defaultBranch, 'master');
    assert.equal(repo.starsCount, 88);
  });

  it('should list repositories and branches', async () => {
    const adapter = new GiteeVcsAdapter({
      fetchFn: async (url) => {
        const u = String(url);
        if (u.includes('/branches')) {
          return new Response(JSON.stringify([
            { name: 'master', commit: { sha: 'sha-master-00' }, protected: true },
            { name: 'dev', commit: { sha: 'sha-dev-01' }, protected: false },
          ]), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          { id: 1, name: 'repo-one', full_name: 'oschina/repo-one', default_branch: 'master', private: false, owner: { login: 'oschina' } }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repos = await adapter.listRepositories('oschina');
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'repo-one');

    const branches = await adapter.listBranches('oschina', 'repo-one');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'master');
    assert.equal(branches[0].isProtected, true);
  });

  it('should create, get, and list pull requests', async () => {
    let createdPayload: any = null;
    const adapter = new GiteeVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 20,
            number: 3,
            title: createdPayload.title,
            body: createdPayload.body,
            state: 'open',
            head: { ref: createdPayload.head },
            base: { ref: createdPayload.base },
            user: { login: 'gitee-dev' },
            html_url: 'https://gitee.com/oschina/repo-one/pulls/3',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 20,
            number: 3,
            title: 'Fix issue #1',
            state: 'closed',
            merged_at: '2026-11-01T02:00:00Z',
            head: { ref: 'patch-1' },
            base: { ref: 'master' },
            user: { login: 'gitee-dev' },
            html_url: 'https://gitee.com/oschina/repo-one/pulls/3',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T02:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createPullRequest('oschina', 'repo-one', {
      title: 'Fix issue #1',
      sourceBranch: 'patch-1',
      targetBranch: 'master',
    });
    assert.equal(created.number, 3);
    assert.equal(created.state, 'open');

    const prs = await adapter.listPullRequests('oschina', 'repo-one', 'closed');
    assert.equal(prs.length, 1);
    assert.equal(prs[0].state, 'merged'); // merged_at triggers merged
  });

  it('should list commits and get file contents', async () => {
    const rawContent = 'Gitee content string';
    const b64 = Buffer.from(rawContent).toString('base64');
    const adapter = new GiteeVcsAdapter({
      fetchFn: async (url) => {
        const u = String(url);
        if (u.includes('/contents/')) {
          return new Response(JSON.stringify({
            name: 'index.js',
            path: 'index.js',
            encoding: 'base64',
            content: b64,
            size: rawContent.length,
            sha: 'sha-blob-gitee',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            sha: 'commit-gitee-1',
            commit: {
              message: 'init gitee repo',
              author: { name: 'Gitee Author', date: '2026-11-01T00:00:00Z' },
            },
            html_url: 'https://gitee.com/commit/1',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('oschina', 'repo-one');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'commit-gitee-1');

    const file = await adapter.getFileContent('oschina', 'repo-one', 'index.js');
    assert.equal(file.content, rawContent);
  });

  it('should create and list issues', async () => {
    const adapter = new GiteeVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 99,
            number: 1,
            title: 'Bug in parsing',
            body: 'Stack trace',
            state: 'open',
            user: { name: 'User1' },
            created_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          { id: 99, number: 1, title: 'Bug in parsing', state: 'closed', user: { name: 'User1' }, created_at: '2026-11-01T00:00:00Z' }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createIssue('oschina', 'repo-one', { title: 'Bug in parsing' });
    assert.equal(created.number, 1);
    assert.equal(created.state, 'open');

    const issues = await adapter.listIssues('oschina', 'repo-one', 'closed');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, 'closed');
  });

  it('should map errors correctly', async () => {
    const authAdapter = new GiteeVcsAdapter({
      fetchFn: async () => new Response('Unauthorized', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError
    );

    const notFoundAdapter = new GiteeVcsAdapter({
      fetchFn: async () => new Response('Resource Not Found', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError
    );

    const rateLimitAdapter = new GiteeVcsAdapter({
      fetchFn: async () => new Response('Rate Limit', { status: 429 }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError
    );
  });
});
