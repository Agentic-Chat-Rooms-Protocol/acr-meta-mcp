import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AzureDevOpsVcsAdapter,
  VcsAuthenticationError,
  VcsNotFoundError,
  VcsRateLimitError,
} from '../src/index.js';

describe('AzureDevOpsVcsAdapter', () => {
  it('should format Basic auth with PAT and include api-version', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};

    const adapter = new AzureDevOpsVcsAdapter({
      organization: 'my-corp',
      project: 'acr-platform',
      token: 'ado-pat-token-999',
      apiVersion: '7.1',
      fetchFn: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = init?.headers as Record<string, string>;
        return new Response(JSON.stringify({
          id: 'repo-guid-1234',
          name: 'core-service',
          defaultBranch: 'refs/heads/main',
          remoteUrl: 'https://dev.azure.com/my-corp/acr-platform/_git/core-service',
          webUrl: 'https://dev.azure.com/my-corp/acr-platform/_git/core-service',
          project: { name: 'acr-platform' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repo = await adapter.getRepository('acr-platform', 'core-service');
    const expectedBasic = Buffer.from(':ado-pat-token-999').toString('base64');
    assert.equal(capturedHeaders['Authorization'], `Basic ${expectedBasic}`);
    assert.ok(capturedUrl.includes('/my-corp/acr-platform/_apis/git/repositories/core-service?api-version=7.1'));
    assert.equal(repo.name, 'core-service');
    assert.equal(repo.defaultBranch, 'main'); // stripped refs/heads/
    assert.equal(repo.owner, 'acr-platform');
  });

  it('should list repositories and branches', async () => {
    const adapter = new AzureDevOpsVcsAdapter({
      organization: 'my-corp',
      project: 'acr-platform',
      fetchFn: async (url) => {
        const u = String(url);
        if (u.includes('/refs?filter=heads/')) {
          return new Response(JSON.stringify({
            value: [
              { name: 'refs/heads/main', objectId: 'sha-main' },
              { name: 'refs/heads/feature/mcp', objectId: 'sha-mcp' },
            ]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          value: [
            { id: '1', name: 'repo-1', defaultBranch: 'refs/heads/develop', remoteUrl: 'https://ado/1' }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const repos = await adapter.listRepositories();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].name, 'repo-1');

    const branches = await adapter.listBranches('acr-platform', 'repo-1');
    assert.equal(branches.length, 2);
    assert.equal(branches[0].name, 'main');
    assert.equal(branches[1].name, 'feature/mcp');
  });

  it('should create, get, and list pull requests', async () => {
    let createdPayload: any = null;
    const adapter = new AzureDevOpsVcsAdapter({
      organization: 'my-corp',
      project: 'acr-platform',
      fetchFn: async (_url, init) => {
        if (init?.method === 'POST') {
          createdPayload = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            pullRequestId: 101,
            title: createdPayload.title,
            description: createdPayload.description,
            status: 'active',
            sourceRefName: createdPayload.sourceRefName,
            targetRefName: createdPayload.targetRefName,
            createdBy: { displayName: 'ADO Engineer' },
            creationDate: '2026-11-01T00:00:00Z',
          }), { status: 201, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({
          value: [
            {
              pullRequestId: 101,
              title: 'Add Azure DevOps adapter',
              status: 'completed',
              sourceRefName: 'refs/heads/feature/ado',
              targetRefName: 'refs/heads/main',
              createdBy: { displayName: 'ADO Engineer' },
              creationDate: '2026-11-01T00:00:00Z',
              closedDate: '2026-11-01T03:00:00Z',
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const created = await adapter.createPullRequest('acr-platform', 'core-service', {
      title: 'Add Azure DevOps adapter',
      sourceBranch: 'feature/ado',
      targetBranch: 'main',
    });
    assert.equal(created.number, 101);
    assert.equal(created.state, 'open');
    assert.equal(createdPayload.sourceRefName, 'refs/heads/feature/ado');
    assert.equal(createdPayload.targetRefName, 'refs/heads/main');

    const prs = await adapter.listPullRequests('acr-platform', 'core-service', 'closed');
    assert.equal(prs.length, 1);
    assert.equal(prs[0].state, 'merged'); // completed -> merged
  });

  it('should list commits and retrieve file content', async () => {
    const adapter = new AzureDevOpsVcsAdapter({
      organization: 'my-corp',
      project: 'acr-platform',
      fetchFn: async (url) => {
        const u = String(url);
        if (u.includes('/items?path=')) {
          return new Response('azure-pipelines.yml content', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          });
        }
        return new Response(JSON.stringify({
          value: [
            {
              commitId: 'commit-ado-1',
              comment: 'fix pipeline build',
              author: { name: 'CI Bot', date: '2026-11-01T00:00:00Z' },
            }
          ]
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const commits = await adapter.listCommits('acr-platform', 'core-service');
    assert.equal(commits.length, 1);
    assert.equal(commits[0].sha, 'commit-ado-1');

    const file = await adapter.getFileContent('acr-platform', 'core-service', 'azure-pipelines.yml');
    assert.equal(file.content, 'azure-pipelines.yml content');
  });

  it('should create and list work items (issues)', async () => {
    let createdPatch: any = null;
    const adapter = new AzureDevOpsVcsAdapter({
      organization: 'my-corp',
      project: 'acr-platform',
      fetchFn: async (url, init) => {
        const u = String(url);
        if (init?.method === 'POST' && u.includes('/wit/workitems/$Issue')) {
          createdPatch = JSON.parse(String(init.body));
          return new Response(JSON.stringify({
            id: 888,
            fields: {
              'System.Title': createdPatch[0].value,
              'System.Description': createdPatch[1].value,
              'System.State': 'Active',
              'System.CreatedBy': { displayName: 'Reporter' },
              'System.CreatedDate': '2026-11-01T00:00:00Z',
              'System.Tags': 'infra; ci',
            }
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (init?.method === 'POST' && u.includes('/wit/wiql')) {
          return new Response(JSON.stringify({
            workItems: [{ id: 888 }]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (u.includes('/wit/workitems?ids=')) {
          return new Response(JSON.stringify({
            value: [
              {
                id: 888,
                fields: {
                  'System.Title': 'Build runner slow',
                  'System.State': 'Closed',
                  'System.CreatedBy': { displayName: 'Reporter' },
                }
              }
            ]
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200 });
      },
    });

    const created = await adapter.createIssue('acr-platform', 'core-service', {
      title: 'Build runner slow',
      body: 'Investigate vm scale set',
      labels: ['infra', 'ci'],
    });
    assert.equal(created.id, 888);
    assert.equal(created.state, 'open');
    assert.deepEqual(created.labels, ['infra', 'ci']);

    const issues = await adapter.listIssues('acr-platform', 'core-service', 'closed');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].state, 'closed');
  });

  it('should map errors correctly', async () => {
    const authAdapter = new AzureDevOpsVcsAdapter({
      fetchFn: async () => new Response('Access Denied', { status: 401 }),
    });
    await assert.rejects(
      async () => authAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsAuthenticationError
    );

    const notFoundAdapter = new AzureDevOpsVcsAdapter({
      fetchFn: async () => new Response('Project does not exist', { status: 404 }),
    });
    await assert.rejects(
      async () => notFoundAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsNotFoundError
    );

    const rateLimitAdapter = new AzureDevOpsVcsAdapter({
      fetchFn: async () => new Response('Rate limited', { status: 429 }),
    });
    await assert.rejects(
      async () => rateLimitAdapter.getRepository('o', 'r'),
      (err: any) => err instanceof VcsRateLimitError
    );
  });
});
