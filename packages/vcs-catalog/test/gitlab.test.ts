import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitLabVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
  VcsValidationError,
} from '../src/index.js';

describe('GitLabVcsAdapter', () => {
  it('should support self-hosted base URLs and PRIVATE-TOKEN header', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const adapter = new GitLabVcsAdapter({
      baseUrl: 'https://gitlab.enterprise.internal/api/v4',
      token: 'glpat-secret-token-xyz',
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 420,
          name: 'backend-core',
          path_with_namespace: 'acr-team/backend-core',
          description: 'Core backend service',
          default_branch: 'main',
          visibility: 'private',
          http_url_to_repo: 'https://gitlab.enterprise.internal/acr-team/backend-core.git',
          web_url: 'https://gitlab.enterprise.internal/acr-team/backend-core',
          namespace: { full_path: 'acr-team', name: 'ACR Team' },
          star_count: 5,
          forks_count: 2,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('acr-team', 'backend-core');
    assert.ok(capturedUrl.startsWith('https://gitlab.enterprise.internal/api/v4/projects/acr-team%2Fbackend-core'));
    assert.equal(capturedHeaders['PRIVATE-TOKEN'], 'glpat-secret-token-xyz');
    assert.equal(repo.name, 'backend-core');
    assert.equal(repo.fullName, 'acr-team/backend-core');
    assert.equal(repo.isPrivate, true);
    assert.equal(repo.starsCount, 5);
  });

  it('should list repositories for a group or user', async () => {
    const adapter = new GitLabVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          {
            id: 11,
            name: 'project-a',
            path_with_namespace: 'group-x/project-a',
            default_branch: 'main',
            visibility: 'public',
            web_url: 'https://gitlab.com/group-x/project-a',
            namespace: { full_path: 'group-x' },
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repos = await adapter.listRepositories('group-x');
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'project-a');
    assert.equal(repos[0].isPrivate, false);
  });

  it('should list branches', async () => {
    const adapter = new GitLabVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          { name: 'main', commit: { id: 'sha-main-123' }, protected: true },
          { name: 'feat/mr-pipeline', commit: { id: 'sha-feat-456' }, protected: false },
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const branches = await adapter.listBranches('group-x', 'project-a');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[0].commitSha, 'sha-main-123');
    assert.equal(branches[0].isProtected, true);
  });

  it('should get, list, and create merge requests', async () => {
    let createdPayload: any = null;
    const adapter = new GitLabVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 88,
            iid: 5,
            title: createdPayload.title,
            description: createdPayload.description,
            state: 'opened',
            source_branch: createdPayload.source_branch,
            target_branch: createdPayload.target_branch,
            author: { username: 'gitlab-dev' },
            web_url: 'https://gitlab.com/group-x/project-a/-/merge_requests/5',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 88,
            iid: 5,
            title: 'Refactor transport layer',
            description: 'MR description',
            state: 'merged',
            source_branch: 'refactor/transport',
            target_branch: 'main',
            author: { username: 'gitlab-dev' },
            web_url: 'https://gitlab.com/group-x/project-a/-/merge_requests/5',
            created_at: '2026-11-01T00:00:00Z',
            updated_at: '2026-11-01T01:00:00Z',
            merged_at: '2026-11-01T01:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createPullRequest('group-x', 'project-a', {
      title: 'Refactor transport layer',
      body: 'MR description',
      sourceBranch: 'refactor/transport',
      targetBranch: 'main',
    });
    assert.equal(created.number, 5);
    assert.equal(createdPayload.source_branch, 'refactor/transport');

    const mrs = await adapter.listPullRequests('group-x', 'project-a', 'all');
    assert.equal(mrs.length, 1);
    assert.equal(mrs[0].state, 'merged');
  });

  it('should list commits', async () => {
    const adapter = new GitLabVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify([
          {
            id: 'commit-gitlab-789',
            message: 'feat: add gitlab adapter support',
            author_name: 'Dev GitLab',
            created_at: '2026-11-01T07:15:00Z',
            web_url: 'https://gitlab.com/commit/789',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('group-x', 'project-a');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'commit-gitlab-789');
    assert.equal(commits[0].author, 'Dev GitLab');
  });

  it('should get file content with base64 decoding', async () => {
    const fileText = 'GitLab CI pipeline configuration';
    const b64 = Buffer.from(fileText).toString('base64');
    const adapter = new GitLabVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          file_name: '.gitlab-ci.yml',
          file_path: '.gitlab-ci.yml',
          size: fileText.length,
          encoding: 'base64',
          content: b64,
          commit_id: 'ci-commit-1',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const file = await adapter.getFileContent('group-x', 'project-a', '.gitlab-ci.yml');
    assert.equal(file.path, '.gitlab-ci.yml');
    assert.equal(file.content, fileText);
    assert.equal(file.encoding, 'utf-8');
  });

  it('should create and list issues', async () => {
    const adapter = new GitLabVcsAdapter({
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          return new Response(JSON.stringify({
            id: 201,
            iid: 12,
            title: 'Pipeline failing',
            description: 'Job timeout',
            state: 'opened',
            author: { username: 'qa-agent' },
            web_url: 'https://gitlab.com/group-x/project-a/-/issues/12',
            created_at: '2026-11-01T00:00:00Z',
            labels: ['ci', 'bug'],
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify([
          {
            id: 201,
            iid: 12,
            title: 'Pipeline failing',
            state: 'closed',
            author: { username: 'qa-agent' },
            created_at: '2026-11-01T00:00:00Z',
          }
        ]), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createIssue('group-x', 'project-a', {
      title: 'Pipeline failing',
      body: 'Job timeout',
      labels: ['ci', 'bug'],
    });
    assert.equal(created.number, 12);
    assert.equal(created.state, 'open');

    const issues = await adapter.listIssues('group-x', 'project-a', 'closed');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, 'closed');
  });

  it('should execute health check with version endpoint', async () => {
    const adapter = new GitLabVcsAdapter({
      fetchFn: async () => {
        return new Response(JSON.stringify({
          version: '17.5.1-ee',
          revision: 'abcdef123',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const health = await adapter.healthCheck();
    assert.equal(health.ok, true);
    assert.equal(health.version, '17.5.1-ee');
  });

  it('should map errors correctly', async () => {
    const authAdapter = new GitLabVcsAdapter({
      fetchFn: async () => new Response('401 Unauthorized', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError
    );

    const notFoundAdapter = new GitLabVcsAdapter({
      fetchFn: async () => new Response('404 Project Not Found', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError
    );

    const rateLimitAdapter = new GitLabVcsAdapter({
      fetchFn: async () => new Response('429 Too Many Requests', { status: 429 }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError
    );

    const validationAdapter = new GitLabVcsAdapter({
      fetchFn: async () => new Response(JSON.stringify({ message: 'Title is required' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(
      async () => validationAdapter.createIssue('o', 'r', { title: '' }),
      (err: any) => err instanceof VcsValidationError
    );
  });
});
