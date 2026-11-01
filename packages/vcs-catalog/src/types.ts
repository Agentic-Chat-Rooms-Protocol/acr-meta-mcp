export type VcsProviderType =
  | 'github'
  | 'gitlab'
  | 'bitbucket'
  | 'gitea'
  | 'forgejo'
  | 'azure-devops'
  | 'gitee';

export interface VcsProviderConfig {
  type: VcsProviderType;
  name?: string;
  displayName?: string;
  baseUrl?: string;
  token?: string;
  username?: string;
  organization?: string;
  project?: string;
  apiVersion?: string;
  customHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface VcsRepository {
  id: string | number;
  name: string;
  fullName: string;
  description?: string;
  defaultBranch: string;
  isPrivate: boolean;
  cloneUrl: string;
  htmlUrl: string;
  owner: string;
  starsCount?: number;
  forksCount?: number;
}

export interface VcsBranch {
  name: string;
  commitSha: string;
  isProtected: boolean;
}

export interface VcsPullRequest {
  id: string | number;
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed' | 'merged';
  sourceBranch: string;
  targetBranch: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
}

export interface VcsCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url?: string;
}

export interface VcsFileContent {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  sha?: string;
}

export interface VcsIssue {
  id: string | number;
  number: number;
  title: string;
  body?: string;
  state: 'open' | 'closed';
  author: string;
  htmlUrl: string;
  createdAt: string;
  labels?: string[];
}

export interface CreatePullRequestInput {
  title: string;
  body?: string;
  sourceBranch: string;
  targetBranch: string;
  draft?: boolean;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
}

export class VcsError extends Error {
  public readonly statusCode?: number;
  public readonly providerType: VcsProviderType;
  public readonly endpoint?: string;

  constructor(message: string, providerType: VcsProviderType, statusCode?: number, endpoint?: string) {
    super(`[${providerType.toUpperCase()}] ${message}${statusCode ? ` (HTTP ${statusCode})` : ''}`);
    this.name = 'VcsError';
    this.providerType = providerType;
    this.statusCode = statusCode;
    this.endpoint = endpoint;
  }
}

export class VcsAuthenticationError extends VcsError {
  constructor(providerType: VcsProviderType, statusCode = 401, endpoint?: string) {
    super('Authentication failed or invalid credentials provided', providerType, statusCode, endpoint);
    this.name = 'VcsAuthenticationError';
  }
}

export class VcsNotFoundError extends VcsError {
  constructor(providerType: VcsProviderType, resource: string, endpoint?: string) {
    super(`Resource not found: ${resource}`, providerType, 404, endpoint);
    this.name = 'VcsNotFoundError';
  }
}

export class VcsRateLimitError extends VcsError {
  public readonly resetTime?: Date;

  constructor(providerType: VcsProviderType, resetTime?: Date, endpoint?: string) {
    super('API rate limit exceeded', providerType, 429, endpoint);
    this.name = 'VcsRateLimitError';
    this.resetTime = resetTime;
  }
}

export class VcsValidationError extends VcsError {
  constructor(providerType: VcsProviderType, message: string, endpoint?: string) {
    super(`Validation failed: ${message}`, providerType, 400, endpoint);
    this.name = 'VcsValidationError';
  }
}

export interface IVcsProviderAdapter {
  readonly providerType: VcsProviderType;
  readonly name: string;
  readonly config: VcsProviderConfig;

  getRepository(owner: string, repo: string): Promise<VcsRepository>;
  listRepositories(owner?: string): Promise<VcsRepository[]>;
  listBranches(owner: string, repo: string): Promise<VcsBranch[]>;
  getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest>;
  listPullRequests(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<VcsPullRequest[]>;
  createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<VcsPullRequest>;
  listCommits(owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]>;
  getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<VcsFileContent>;
  createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<VcsIssue>;
  listIssues(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<VcsIssue[]>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string; version?: string }>;
}

export interface IVcsCatalog {
  registerAdapter(adapter: IVcsProviderAdapter): void;
  registerConfig(config: VcsProviderConfig): IVcsProviderAdapter;
  getAdapter(typeOrName: string): IVcsProviderAdapter | undefined;
  listAdapters(): IVcsProviderAdapter[];
  unregisterAdapter(name: string): boolean;
  exportMcpTools(prefix?: string): any[];
  dispatchMcpTool(namespacedTool: string, args: Record<string, unknown>): Promise<unknown>;
}
