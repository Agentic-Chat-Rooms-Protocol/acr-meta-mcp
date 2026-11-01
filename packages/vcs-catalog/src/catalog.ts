import {
  IVcsCatalog,
  IVcsProviderAdapter,
  VcsError,
  VcsProviderConfig,
  VcsProviderType,
} from './types.js';
import { GitHubVcsAdapter } from './adapters/github.js';
import { GitLabVcsAdapter } from './adapters/gitlab.js';
import { BitbucketVcsAdapter } from './adapters/bitbucket.js';
import { GiteaVcsAdapter } from './adapters/gitea.js';
import { ForgejoVcsAdapter } from './adapters/forgejo.js';
import { AzureDevOpsVcsAdapter } from './adapters/azure_devops.js';
import { GiteeVcsAdapter } from './adapters/gitee.js';

export function createVcsAdapter(config: VcsProviderConfig): IVcsProviderAdapter {
  switch (config.type) {
    case 'github':
      return new GitHubVcsAdapter(config);
    case 'gitlab':
      return new GitLabVcsAdapter(config);
    case 'bitbucket':
      return new BitbucketVcsAdapter(config);
    case 'gitea':
      return new GiteaVcsAdapter(config);
    case 'forgejo':
      return new ForgejoVcsAdapter(config);
    case 'azure-devops':
      return new AzureDevOpsVcsAdapter(config);
    case 'gitee':
      return new GiteeVcsAdapter(config);
    default:
      throw new VcsError(`Unsupported VCS provider type: ${(config as any).type}`, config.type as any);
  }
}

export interface McpToolExport {
  name: string;
  originalName: string;
  serverId: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  tags?: string[];
}

export class VcsCatalog implements IVcsCatalog {
  private readonly adapters = new Map<string, IVcsProviderAdapter>();

  constructor(initialConfigs: VcsProviderConfig[] = []) {
    for (const config of initialConfigs) {
      this.registerConfig(config);
    }
  }

  public registerAdapter(adapter: IVcsProviderAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  public registerConfig(config: VcsProviderConfig): IVcsProviderAdapter {
    const adapter = createVcsAdapter(config);
    this.registerAdapter(adapter);
    return adapter;
  }

  public getAdapter(typeOrName: string): IVcsProviderAdapter | undefined {
    // 1. Direct name match
    if (this.adapters.has(typeOrName)) {
      return this.adapters.get(typeOrName);
    }
    // 2. Provider type match (first registered of that type)
    for (const adapter of this.adapters.values()) {
      if (adapter.providerType === typeOrName) {
        return adapter;
      }
    }
    return undefined;
  }

  public listAdapters(): IVcsProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  public unregisterAdapter(name: string): boolean {
    return this.adapters.delete(name);
  }

  public exportMcpTools(prefix = 'vcs'): McpToolExport[] {
    const tools: McpToolExport[] = [];

    for (const adapter of this.adapters.values()) {
      const serverId = `${prefix}-${adapter.name}`;

      tools.push(
        {
          name: `${serverId}__get_repository`,
          originalName: 'get_repository',
          serverId,
          description: `Get details and metadata of a repository from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization/workspace' },
              repo: { type: 'string', description: 'Repository name or slug' },
            },
            required: ['owner', 'repo'],
          },
          tags: ['vcs', adapter.providerType, 'repository'],
        },
        {
          name: `${serverId}__list_repositories`,
          originalName: 'list_repositories',
          serverId,
          description: `List repositories from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Optional owner, organization, or workspace filter' },
            },
          },
          tags: ['vcs', adapter.providerType, 'repository'],
        },
        {
          name: `${serverId}__list_branches`,
          originalName: 'list_branches',
          serverId,
          description: `List branches of a repository from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
            },
            required: ['owner', 'repo'],
          },
          tags: ['vcs', adapter.providerType, 'branch'],
        },
        {
          name: `${serverId}__get_pull_request`,
          originalName: 'get_pull_request',
          serverId,
          description: `Get details of a pull request / merge request from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              prNumber: { type: 'number', description: 'Pull request number or IID' },
            },
            required: ['owner', 'repo', 'prNumber'],
          },
          tags: ['vcs', adapter.providerType, 'pull-request'],
        },
        {
          name: `${serverId}__list_pull_requests`,
          originalName: 'list_pull_requests',
          serverId,
          description: `List pull requests / merge requests from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'PR state filter' },
            },
            required: ['owner', 'repo'],
          },
          tags: ['vcs', adapter.providerType, 'pull-request'],
        },
        {
          name: `${serverId}__create_pull_request`,
          originalName: 'create_pull_request',
          serverId,
          description: `Create a new pull request / merge request on ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              title: { type: 'string', description: 'Pull request title' },
              body: { type: 'string', description: 'Pull request body/description' },
              sourceBranch: { type: 'string', description: 'Source / feature branch name' },
              targetBranch: { type: 'string', description: 'Target / base branch name' },
              draft: { type: 'boolean', description: 'Whether to create as draft' },
            },
            required: ['owner', 'repo', 'title', 'sourceBranch', 'targetBranch'],
          },
          tags: ['vcs', adapter.providerType, 'pull-request', 'write'],
        },
        {
          name: `${serverId}__list_commits`,
          originalName: 'list_commits',
          serverId,
          description: `List commits of a repository or branch from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              branchOrSha: { type: 'string', description: 'Optional branch name or commit SHA' },
            },
            required: ['owner', 'repo'],
          },
          tags: ['vcs', adapter.providerType, 'commit'],
        },
        {
          name: `${serverId}__get_file_content`,
          originalName: 'get_file_content',
          serverId,
          description: `Get file content from a repository on ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              path: { type: 'string', description: 'Path to file within repository' },
              ref: { type: 'string', description: 'Optional branch name or commit SHA' },
            },
            required: ['owner', 'repo', 'path'],
          },
          tags: ['vcs', adapter.providerType, 'file'],
        },
        {
          name: `${serverId}__create_issue`,
          originalName: 'create_issue',
          serverId,
          description: `Create an issue on ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              title: { type: 'string', description: 'Issue title' },
              body: { type: 'string', description: 'Issue body/description' },
              labels: { type: 'array', items: { type: 'string' }, description: 'Issue labels' },
            },
            required: ['owner', 'repo', 'title'],
          },
          tags: ['vcs', adapter.providerType, 'issue', 'write'],
        },
        {
          name: `${serverId}__list_issues`,
          originalName: 'list_issues',
          serverId,
          description: `List issues from ${adapter.providerType} (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {
              owner: { type: 'string', description: 'Repository owner or organization' },
              repo: { type: 'string', description: 'Repository name' },
              state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Issue state filter' },
            },
            required: ['owner', 'repo'],
          },
          tags: ['vcs', adapter.providerType, 'issue'],
        },
        {
          name: `${serverId}__health_check`,
          originalName: 'health_check',
          serverId,
          description: `Check health and connectivity of ${adapter.providerType} adapter (${adapter.name})`,
          inputSchema: {
            type: 'object',
            properties: {},
          },
          tags: ['vcs', adapter.providerType, 'health'],
        }
      );
    }

    return tools;
  }

  public async dispatchMcpTool(namespacedTool: string, args: Record<string, unknown> = {}): Promise<unknown> {
    // Expected patterns:
    // 1) "vcs-<adapterName>__<action>"
    // 2) "vcs__<adapterName>__<action>"
    // 3) "<adapterName>__<action>"
    let adapterName = '';
    let action = '';

    const parts = namespacedTool.split('__');
    if (parts.length >= 3) {
      adapterName = parts[1];
      action = parts.slice(2).join('__');
    } else if (parts.length === 2) {
      const serverPart = parts[0];
      adapterName = serverPart.startsWith('vcs-')
        ? serverPart.slice(4)
        : (serverPart.startsWith('vcs__') ? serverPart.slice(5) : serverPart);
      action = parts[1];
    } else {
      throw new Error(`Invalid namespaced tool format: "${namespacedTool}". Expected format "vcs-<adapter>__<action>"`);
    }

    const adapter = this.getAdapter(adapterName);
    if (!adapter) {
      throw new Error(`VCS adapter "${adapterName}" not found in catalog. Registered: [${Array.from(this.adapters.keys()).join(', ')}]`);
    }

    const owner = (args.owner as string) || '';
    const repo = (args.repo as string) || '';

    switch (action) {
      case 'get_repository':
        return await adapter.getRepository(owner, repo);

      case 'list_repositories':
        return await adapter.listRepositories(owner || undefined);

      case 'list_branches':
        return await adapter.listBranches(owner, repo);

      case 'get_pull_request':
        return await adapter.getPullRequest(owner, repo, Number(args.prNumber));

      case 'list_pull_requests':
        return await adapter.listPullRequests(owner, repo, (args.state as any) || 'open');

      case 'create_pull_request':
        return await adapter.createPullRequest(owner, repo, {
          title: String(args.title || ''),
          body: args.body ? String(args.body) : undefined,
          sourceBranch: String(args.sourceBranch || ''),
          targetBranch: String(args.targetBranch || ''),
          draft: args.draft ? Boolean(args.draft) : undefined,
        });

      case 'list_commits':
        return await adapter.listCommits(owner, repo, args.branchOrSha ? String(args.branchOrSha) : undefined);

      case 'get_file_content':
        return await adapter.getFileContent(
          owner,
          repo,
          String(args.path || ''),
          args.ref ? String(args.ref) : undefined
        );

      case 'create_issue':
        return await adapter.createIssue(owner, repo, {
          title: String(args.title || ''),
          body: args.body ? String(args.body) : undefined,
          labels: Array.isArray(args.labels) ? (args.labels as string[]) : undefined,
        });

      case 'list_issues':
        return await adapter.listIssues(owner, repo, (args.state as any) || 'open');

      case 'health_check':
        return await adapter.healthCheck();

      default:
        throw new Error(`Unknown VCS action "${action}" on adapter "${adapterName}"`);
    }
  }
}
