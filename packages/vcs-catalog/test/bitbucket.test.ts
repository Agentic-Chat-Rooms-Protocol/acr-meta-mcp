import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BitbucketVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
} from '../src/index.js';

describe('BitbucketVcsAdapter', () => {
  it('should format Basic auth with username and app password', async () => {
    let capturedHeaders: Record<string, string> = {};
    const adapter = new BitbucketVcsAdapter({
      username: 'acr-bot',
      token: 'app-secret-password-xyz',
      fetchFn: async (_url, init) => {
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          uuid: '{1234-uuid}',
          name: 'cloud-mesh',
          full_name: 'acr-workspace/cloud-mesh',
          description: 'Cloud fallback mesh',
          mainbranch: { name: 'main' },
          is_private: true,
          links: {
            html: { href: 'https://bitbucket.org/acr-workspace/cloud-mesh' },
            clone: [{ name: 'https', href: 'https://bitbucket.org/acr-workspace/cloud-mesh.git' }],
          },
          workspace: { slug: 'acr-workspace' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('acr-workspace', 'cloud-mesh');
    const expectedBasic = Buffer.from('acr-bot:app-secret-password-xyz').toString('base64');
    assert.equal(capturedHeaders['Authorization'], `Basic ${expectedBasic}`);
    assert.equal(repo.name, 'cloud-mesh');
    assert.equal(repo.fullName, 'acr-workspace/cloud-mesh');
    assert.equal(repo.defaultBranch, 'main');
    assert.equal(repo.isPrivate, true);
  });

  it('should list repositories in workspace', async () => {
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          values: [
            {
              uuid: '{r1}',
              name: 'repo-one',
              full_name: 'ws/repo-one',
              mainbranch: { name: 'develop' },
              is_private: false,
              workspace: { slug: 'ws' },
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repos = await adapter.listRepositories('ws');
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'repo-one');
    assert.equal(repos[0].defaultBranch, 'develop');
  });

  it('should list branches', async () => {
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          values: [
            { name: 'main', target: { hash: 'hash999' } },
            { name: 'fix/security', target: { hash: 'hash888' } },
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const branches = await adapter.listBranches('ws', 'repo-one');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[0].commitSha, 'hash999');
  });

  it('should get, list, and create pull requests with state mapping', async () => {
    let createdPayload: any = null;
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 15,
            title: createdPayload.title,
            summary: createdPayload.summary,
            state: 'OPEN',
            source: createdPayload.source,
            destination: createdPayload.destination,
            author: { display_name: 'Bitbucket Bot' },
            links: { html: { href: 'https://bitbucket.org/ws/repo-one/pull-requests/15' } },
            created_on: '2026-11-01T00:00:00Z',
            updated_on: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          values: [
            {
              id: 15,
              title: 'Add security firewall',
              state: 'MERGED',
              source: { branch: { name: 'feat/firewall' } },
              destination: { branch: { name: 'main' } },
              author: { display_name: 'Bitbucket Bot' },
              links: { html: { href: 'https://bitbucket.org/ws/repo-one/pull-requests/15' } },
              created_on: '2026-11-01T00:00:00Z',
              updated_on: '2026-11-01T00:00:00Z',
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createPullRequest('ws', 'repo-one', {
      title: 'Add security firewall',
      sourceBranch: 'feat/firewall',
      targetBranch: 'main',
    });
    assert.equal(created.number, 15);
    assert.equal(created.state, 'open');

    const list = await adapter.listPullRequests('ws', 'repo-one', 'closed');
    assert.equal(list.length, 1);
    assert.equal(list[0].state, 'merged');
  });

  it('should list commits', async () => {
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          values: [
            {
              hash: 'bbcommit456',
              message: 'Initial commit',
              author: { user: { display_name: 'Bitbucket Engineer' } },
              date: '2026-11-01T05:00:00Z',
              links: { html: { href: 'https://bitbucket.org/commit/456' } },
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('ws', 'repo-one');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'bbcommit456');
    assert.equal(commits[0].author, 'Bitbucket Engineer');
  });

  it('should get raw file content', async () => {
    const fileSource = 'package main\nfunc main() {}\n';
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async () => {
        return new Response(fileSource, { status: 200, headers: { 'content-type': 'text/plain' } });
      },
    });

    const file = await adapter.getFileContent('ws', 'repo-one', 'main.go', 'main');
    assert.equal(file.path, 'main.go');
    assert.equal(file.content, fileSource);
    assert.equal(file.size, fileSource.length);
  });

  it('should create and list issues', async () => {
    const adapter = new BitbucketVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 3,
            title: 'Memory leak in pool',
            content: { raw: 'Fix buffer allocation' },
            state: 'new',
            reporter: { display_name: 'QA' },
            created_on: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          values: [
            { id: 3, title: 'Memory leak in pool', state: 'resolved', created_on: '2026-11-01T00:00:00Z' }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createIssue('ws', 'repo-one', { title: 'Memory leak in pool' });
    assert.equal(created.number, 3);
    assert.equal(created.state, 'open');

    const issues = await adapter.listIssues('ws', 'repo-one', 'closed');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, 'closed');
  });

  it('should map errors correctly', async () => {
    const authAdapter = new BitbucketVcsAdapter({
      fetchFn: async () => new Response('Unauthorized', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError
    );

    const notFoundAdapter = new BitbucketVcsAdapter({
      fetchFn: async () => new Response('Repository not found', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError
    );

    const rateLimitAdapter = new BitbucketVcsAdapter({
      fetchFn: async () => new Response('Too many requests', { status: 429 }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError
    );
  });
});
