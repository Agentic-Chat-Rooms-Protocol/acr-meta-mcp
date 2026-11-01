import {
  CreateIssueInput,
  CreatePullRequestInput,
  IVcsProviderAdapter,
  VcsAuthenticationError,
  VcsBranch,
  VcsCommit,
  VcsError,
  VcsFileContent,
  VcsIssue,
  VcsNotFoundError,
  VcsProviderConfig,
  VcsProviderType,
  VcsPullRequest,
  VcsRateLimitError,
  VcsRepository,
  VcsValidationError,
} from './types.js';

export abstract class BaseVcsAdapter implements IVcsProviderAdapter {
  public readonly providerType: VcsProviderType;
  public readonly name: string;
  public readonly config: VcsProviderConfig;
  protected readonly baseUrl: string;
  protected readonly fetchFn: typeof fetch;

  constructor(config: Partial<VcsProviderConfig> & { type: VcsProviderType }) {
    this.config = { ...config, type: config.type };
    this.providerType = config.type;
    this.name = config.name || config.type;
    this.baseUrl = (config.baseUrl || this.getDefaultBaseUrl()).replace(/\/+$/, '');
    this.fetchFn = config.fetchFn || globalThis.fetch.bind(globalThis);
  }

  protected abstract getDefaultBaseUrl(): string;
  protected abstract getAuthHeaders(): Record<string, string>;

  protected getCommonHeaders(): Record<string, string> {
    return {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'ACR-Meta-MCP/0.8.2 (VcsAdapter)',
      ...this.getAuthHeaders(),
      ...(this.config.customHeaders || {}),
    };
  }

  protected buildUrl(endpoint: string): string {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
      return endpoint;
    }
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${this.baseUrl}${cleanEndpoint}`;
  }

  protected async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = this.buildUrl(endpoint);
    const headers = {
      ...this.getCommonHeaders(),
      ...(options.headers as Record<string, string> || {}),
    };

    const timeoutMs = this.config.timeoutMs || 15000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchFn(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        let parsedMessage = errorText;
        try {
          const jsonErr = JSON.parse(errorText);
          parsedMessage = jsonErr.message || jsonErr.error || jsonErr.errors?.[0]?.message || errorText;
        } catch {
          // Keep raw text
        }

        if (response.status === 401 || response.status === 403) {
          throw new VcsAuthenticationError(this.providerType, response.status, endpoint);
        }
        if (response.status === 404) {
          throw new VcsNotFoundError(this.providerType, parsedMessage || endpoint, endpoint);
        }
        if (response.status === 429) {
          let resetTime: Date | undefined;
          const retryAfter = response.headers.get('retry-after');
          const rateLimitReset = response.headers.get('x-ratelimit-reset');
          if (retryAfter) {
            resetTime = new Date(Date.now() + parseInt(retryAfter, 10) * 1000);
          } else if (rateLimitReset) {
            resetTime = new Date(parseInt(rateLimitReset, 10) * 1000);
          }
          throw new VcsRateLimitError(this.providerType, resetTime, endpoint);
        }
        if (response.status === 400 || response.status === 422) {
          throw new VcsValidationError(this.providerType, parsedMessage, endpoint);
        }

        throw new VcsError(parsedMessage || `Request failed`, this.providerType, response.status, endpoint);
      }

      if (response.status === 204) {
        return undefined as unknown as T;
      }

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }
      return (await response.text()) as unknown as T;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new VcsError(`Request timed out after ${timeoutMs}ms`, this.providerType, 408, endpoint);
      }
      if (err instanceof VcsError) {
        throw err;
      }
      throw new VcsError(err.message || 'Network request failed', this.providerType, undefined, endpoint);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  public async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string; version?: string }> {
    const start = Date.now();
    try {
      // By default test connection by listing repos or hitting root/version endpoint
      await this.listRepositories();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - start, error: err.message };
    }
  }

  public abstract getRepository(owner: string, repo: string): Promise<VcsRepository>;
  public abstract listRepositories(owner?: string): Promise<VcsRepository[]>;
  public abstract listBranches(owner: string, repo: string): Promise<VcsBranch[]>;
  public abstract getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest>;
  public abstract listPullRequests(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<VcsPullRequest[]>;
  public abstract createPullRequest(owner: string, repo: string, input: CreatePullRequestInput): Promise<VcsPullRequest>;
  public abstract listCommits(owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]>;
  public abstract getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<VcsFileContent>;
  public abstract createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<VcsIssue>;
  public abstract listIssues(owner: string, repo: string, state?: 'open' | 'closed' | 'all'): Promise<VcsIssue[]>;
}
