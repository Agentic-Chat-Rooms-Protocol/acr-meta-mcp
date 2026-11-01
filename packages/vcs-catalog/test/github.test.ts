import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
  VcsValidationError,
} from '../src/index.js';

describe('GitHubVcsAdapter', () => {
  it('should authenticate with Bearer token and Accept header', async () => {
    let capturedHeaders: Record<string, string> = {};
    const adapter = new GitHubVcsAdapter({
      token: 'ghp_mock_token_123',
      fetchFn: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 1,
          name: 'test-repo',
          full_name: 'octocat/test-repo',
          default_branch: 'main',
          private: false,
          html_url: 'https://github.com/octocat/test-repo',
          owner: { login: 'octocat' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('octocat', 'test-repo');
    assert.equal(capturedHeaders['Authorization'], 'Bearer ghp_mock_token_123');
    assert.equal(capturedHeaders['Accept'], 'application/vnd.github.v3+json');
    assert.equal(repo.name, 'test-repo');
    assert.equal(repo.fullName, 'octocat/test-repo');
    assert.equal(repo.defaultBranch, 'main');
    assert.equal(repo.isPrivate, false);
  });

  it('should list repositories for user or org', async () => {
    let requestedUrl = '';
    const adapter = new GitHubVcsAdapter({
      fetchFn: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify([
          { id: 101, name: 'repo-1', full_name: 'octo/repo-1', default_branch: 'main', private: true, owner: { login: 'octo' } },
          { id: 102, name: 'repo-2', full_name: 'octo/repo-2', default_branch: 'dev', private: false, owner: { login: 'octo' } },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repos = await adapter.listRepositories('octo');
    assert.ok(requestedUrl.includes('/users/octo/repos'));
    assert.equal(repos.length, 2);
    assert.equal(repos[0].fullName, 'octo/repo-1');
    assert.equal(repos[0].isPrivate, true);
    assert.equal(repos[1].defaultBranch, 'dev');
  });

  it('should list branches', async () => {
    const adapter = new GitHubVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          { name: 'main', commit: { sha: 'c0ffee1' }, protected: true },
          { name: 'feature/vri-300', commit: { sha: 'c0ffee2' }, protected: false },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const branches = await adapter.listBranches('octocat', 'test-repo');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[0].commitSha, 'c0ffee1');
    assert.equal(branches[0].isProtected, true);
    assert.equal(branches[1].name, 'feature/vri-300');
    assert.equal(branches[1].isProtected, false);
  });

  it('should get, list, and create pull requests', async () => {
    let createdPayload: any = null;
    const adapter = new GitHubVcsAdapter({
      fetchFn: async (url, init) => {
        const urlStr = String(url);
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 901,
            number: 42,
            title: createdPayload.title,
            body: createdPayload.body,
            state: 'open',
            head: { ref: createdPayload.head },
            base: { ref: createdPayload.base },
            user: { login: 'octocat' },
            html_url: 'https://github.com/octocat/test-repo/pull/42',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        if (urlStr.includes('/pulls/42')) {
          return new Response(JSON.stringify({
            id: 901,
            number: 42,
            title: 'Add VCS catalog',
            body: 'Closes VRI-300',
            state: 'closed',
            merged_at: '2026-11-01T01:00:00Z',
            head: { ref: 'feat/vcs' },
            base: { ref: 'main' },
            user: { login: 'octocat' },
            html_url: 'https://github.com/octocat/test-repo/pull/42',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T01:00:00Z',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 901,
            number: 42,
            title: 'Add VCS catalog',
            state: 'open',
            head: { ref: 'feat/vcs' },
            base: { ref: 'main' },
            user: { login: 'octocat' },
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    // Create
    const created = await adapter.createPullRequest('octocat', 'test-repo', {
      title: 'Add VCS catalog',
      body: 'Closes VRI-300',
      sourceBranch: 'feat/vcs',
      targetBranch: 'main',
    });
    assert.equal(created.number, 42);
    assert.equal(createdPayload.head, 'feat/vcs');
    assert.equal(createdPayload.base, 'main');

    // Get
    const pr = await adapter.getPullRequest('octocat', 'test-repo', 42);
    assert.equal(pr.number, 42);
    assert.equal(pr.state, 'merged'); // merged_at triggers merged status
    assert.equal(pr.author, 'octocat');

    // List
    const prs = await adapter.listPullRequests('octocat', 'test-repo', 'all');
    assert.equal(prs.length, 1);
  });

  it('should list commits', async () => {
    const adapter = new GitHubVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          {
            sha: 'commit123',
            commit: {
              message: 'feat: add git adapters',
              author: { name: 'ACR Agent', date: '2026-11-01T07:00:00Z' },
            },
            html_url: 'https://github.com/octocat/test-repo/commit/commit123',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('octocat', 'test-repo');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'commit123');
    assert.equal(commits[0].message, 'feat: add git adapters');
    assert.equal(commits[0].author, 'ACR Agent');
  });

  it('should decode base64 file content', async () => {
    const rawText = '# ACR Git VCS Provider Catalog\nFully tested and verified.';
    const base64Content = Buffer.from(rawText).toString('base64');

    const adapter = new GitHubVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          path: 'README.md',
          encoding: 'base64',
          content: base64Content,
          size: rawText.length,
          sha: 'blobsha456',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const file = await adapter.getFileContent('octocat', 'test-repo', 'README.md');
    assert.equal(file.path, 'README.md');
    assert.equal(file.content, rawText);
    assert.equal(file.encoding, 'utf-8');
  });

  it('should create and list issues while filtering out pull requests', async () => {
    const adapter = new GitHubVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 501,
            number: 10,
            title: 'Bug report',
            body: 'Details',
            state: 'open',
            user: { login: 'tester' },
            labels: [{ name: 'bug' }],
            created_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          { id: 501, number: 10, title: 'Bug report', state: 'open', user: { login: 'tester' }, created_at: '2026-11-01T00:00:00Z' },
          { id: 502, number: 11, title: 'A PR masquerading as issue', pull_request: {}, state: 'open', user: { login: 'tester' }, created_at: '2026-11-01T00:00:00Z' },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createIssue('octocat', 'test-repo', { title: 'Bug report', body: 'Details' });
    assert.equal(created.number, 10);
    assert.deepEqual(created.labels, ['bug']);

    const issues = await adapter.listIssues('octocat', 'test-repo');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].number, 10);
  });

  it('should handle errors: 401 auth, 404 not found, 429 rate limit, 422 validation', async () => {
    const authAdapter = new GitHubVcsAdapter({
      fetchFn: async () => new Response('Bad credentials', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError && err.statusCode === 401
    );

    const notFoundAdapter = new GitHubVcsAdapter({
      fetchFn: async () => new Response('Not Found', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError && err.statusCode === 404
    );

    const rateLimitAdapter = new GitHubVcsAdapter({
      fetchFn: async () => new Response('Rate limit exceeded', {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError && err.statusCode === 429 && err.resetTime !== undefined
    );

    const validationAdapter = new GitHubVcsAdapter({
      fetchFn: async () => new Response(JSON.stringify({ message: 'Validation Failed' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      async () => validationAdapter.createIssue('o', 'r', { title: '' }),
      (err: any) => err instanceof VcsValidationError && err.statusCode === 400
    );
  });
});
