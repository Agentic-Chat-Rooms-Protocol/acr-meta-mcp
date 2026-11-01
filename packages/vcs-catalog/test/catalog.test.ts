import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createVcsAdapter,
  VcsCatalog,
  GitHubVcsAdapter,
  GitLabVcsAdapter,
  BitbucketVcsAdapter,
  GiteaVcsAdapter,
  ForgejoVcsAdapter,
  AzureDevOpsVcsAdapter,
  GiteeVcsAdapter,
  VcsError,
} from '../src/index.js';

describe('VcsCatalog & Provider Factory', () => {
  it('createVcsAdapter should instantiate all 7 provider types accurately', () => {
    const gh = createVcsAdapter({ type: 'github' });
    assert.ok(gh instanceof GitHubVcsAdapter);
    assert.equal(gh.providerType, 'github');

    const gl = createVcsAdapter({ type: 'gitlab' });
    assert.ok(gl instanceof GitLabVcsAdapter);
    assert.equal(gl.providerType, 'gitlab');

    const bb = createVcsAdapter({ type: 'bitbucket' });
    assert.ok(bb instanceof BitbucketVcsAdapter);
    assert.equal(bb.providerType, 'bitbucket');

    const gt = createVcsAdapter({ type: 'gitea' });
    assert.ok(gt instanceof GiteaVcsAdapter);
    assert.equal(gt.providerType, 'gitea');

    const fj = createVcsAdapter({ type: 'forgejo' });
    assert.ok(fj instanceof ForgejoVcsAdapter);
    assert.equal(fj.providerType, 'forgejo');

    const ado = createVcsAdapter({ type: 'azure-devops' });
    assert.ok(ado instanceof AzureDevOpsVcsAdapter);
    assert.equal(ado.providerType, 'azure-devops');

    const ge = createVcsAdapter({ type: 'gitee' });
    assert.ok(ge instanceof GiteeVcsAdapter);
    assert.equal(ge.providerType, 'gitee');
  });

  it('createVcsAdapter should throw on unsupported provider type', () => {
    assert.throws(
      () => createVcsAdapter({ type: 'svn-unsupported' as any }),
      (err: any) => err instanceof VcsError && err.message.includes('Unsupported VCS provider')
    );
  });

  it('VcsCatalog should register, discover, list, and unregister adapters', () => {
    const catalog = new VcsCatalog();

    // Register via config
    const gh = catalog.registerConfig({
      type: 'github',
      name: 'github-enterprise',
      baseUrl: 'https://github.corp.internal/api/v3',
    });
    assert.equal(gh.name, 'github-enterprise');

    // Register via instance
    const localGitea = new GiteaVcsAdapter({
      name: 'sovereign-gitea',
      baseUrl: 'http://127.0.0.1:3300/api/v1',
    });
    catalog.registerAdapter(localGitea);

    // List
    const all = catalog.listAdapters();
    assert.equal(all.length, 2);

    // Lookup by exact name
    const foundByName = catalog.getAdapter('github-enterprise');
    assert.ok(foundByName);
    assert.equal(foundByName.name, 'github-enterprise');

    // Lookup by provider type
    const foundByType = catalog.getAdapter('gitea');
    assert.ok(foundByType);
    assert.equal(foundByType.name, 'sovereign-gitea');

    // Unregister
    const deleted = catalog.unregisterAdapter('github-enterprise');
    assert.equal(deleted, true);
    assert.equal(catalog.listAdapters().length, 1);
    assert.equal(catalog.getAdapter('github-enterprise'), undefined);
  });

  it('VcsCatalog should export rich MCP Tool schemas with parameters and tags', () => {
    const catalog = new VcsCatalog([
      { type: 'github', name: 'github' },
      { type: 'gitlab', name: 'gitlab' },
      { type: 'bitbucket', name: 'bitbucket' },
      { type: 'gitea', name: 'gitea' },
      { type: 'forgejo', name: 'forgejo' },
      { type: 'azure-devops', name: 'azure-devops' },
      { type: 'gitee', name: 'gitee' },
    ]);

    const tools = catalog.exportMcpTools('vcs');
    // 7 adapters * 11 tools each = 77 tools
    assert.equal(tools.length, 77);

    // Verify schema structure of a tool
    const getRepoTool = tools.find(t => t.name === 'vcs-github__get_repository');
    assert.ok(getRepoTool);
    assert.equal(getRepoTool.serverId, 'vcs-github');
    assert.equal(getRepoTool.inputSchema.type, 'object');
    assert.ok(getRepoTool.inputSchema.properties.owner);
    assert.ok(getRepoTool.inputSchema.properties.repo);
    assert.deepEqual(getRepoTool.inputSchema.required, ['owner', 'repo']);
    assert.ok(getRepoTool.tags?.includes('github'));

    const createPrTool = tools.find(t => t.name === 'vcs-gitlab__create_pull_request');
    assert.ok(createPrTool);
    assert.ok(createPrTool.inputSchema.properties.sourceBranch);
    assert.ok(createPrTool.inputSchema.properties.targetBranch);
    assert.ok(createPrTool.tags?.includes('write'));
  });

  it('VcsCatalog should dispatch MCP tool execution to correct adapter and action', async () => {
    const mockGh = new GitHubVcsAdapter({
      name: 'github',
      fetchFn: async () => new Response(JSON.stringify({
        id: 1,
        name: 'test-repo',
        full_name: 'org/test-repo',
        default_branch: 'main',
        private: false,
        owner: { login: 'org' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const mockGl = new GitLabVcsAdapter({
      name: 'gitlab',
      fetchFn: async () => new Response(JSON.stringify({
        id: 2,
        iid: 10,
        title: 'New MR',
        description: 'MR description',
        state: 'opened',
        source_branch: 'feat',
        target_branch: 'main',
        author: { username: 'dev' },
        web_url: 'https://gitlab.com/mr/10',
        created_at: '2026-11-01T00:00:00Z',
        updated_at: '2026-11-01T00:00:00Z',
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });

    const catalog = new VcsCatalog();
    catalog.registerAdapter(mockGh);
    catalog.registerAdapter(mockGl);

    // 1. Dispatch get_repository on github
    const repoResult = (await catalog.dispatchMcpTool('vcs__github__get_repository', {
      owner: 'org',
      repo: 'test-repo',
    })) as any;
    assert.equal(repoResult.name, 'test-repo');
    assert.equal(repoResult.fullName, 'org/test-repo');

    // 2. Dispatch create_pull_request on gitlab
    const mrResult = (await catalog.dispatchMcpTool('vcs__gitlab__create_pull_request', {
      owner: 'org',
      repo: 'test-repo',
      title: 'New MR',
      sourceBranch: 'feat',
      targetBranch: 'main',
    })) as any;
    assert.equal(mrResult.number, 10);
    assert.equal(mrResult.title, 'New MR');

    // 3. Dispatch to non-existent adapter
    await assert.rejects(
      async () => catalog.dispatchMcpTool('vcs__unknown__get_repository', { owner: 'o', repo: 'r' }),
      (err: any) => err.message.includes('VCS adapter "unknown" not found')
    );

    // 4. Dispatch unknown action
    await assert.rejects(
      async () => catalog.dispatchMcpTool('vcs__github__unknown_action', { owner: 'o', repo: 'r' }),
      (err: any) => err.message.includes('Unknown VCS action "unknown_action"')
    );
  });
});
