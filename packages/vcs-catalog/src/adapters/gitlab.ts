import { BaseVcsAdapter } from '../base_adapter.js';
import {
  CreateIssueInput,
  CreatePullRequestInput,
  VcsBranch,
  VcsCommit,
  VcsFileContent,
  VcsIssue,
  VcsProviderConfig,
  VcsPullRequest,
  VcsRepository,
} from '../types.js';

export class GitLabVcsAdapter extends BaseVcsAdapter {
  constructor(config: Partial<VcsProviderConfig> = {}) {
    super({ ...config, type: 'gitlab' });
  }

  protected getDefaultBaseUrl(): string {
    return 'https://gitlab.com/api/v4';
  }

  protected getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers['PRIVATE-TOKEN'] = this.config.token;
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    return headers;
  }

  private encodeProjectPath(owner: string, repo: string): string {
    return encodeURIComponent(`${owner}/${repo}`);
  }

  public override async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string; version?: string }> {
    const start = Date.now();
    try {
      const data = await this.request<any>('/version');
      return { ok: true, latencyMs: Date.now() - start, version: data.version };
    } catch {
      return super.healthCheck();
    }
  }

  public async getRepository(owner: string, repo: string): Promise<VcsRepository> {
    const pid = this.encodeProjectPath(owner, repo);
    const data = await this.request<any>(`/projects/${pid}`);
    return this.mapRepository(data);
  }

  public async listRepositories(owner?: string): Promise<VcsRepository[]> {
    const endpoint = owner
      ? `/groups/${encodeURIComponent(owner)}/projects?per_page=100`
      : `/projects?membership=true&per_page=100`;
    try {
      const data = await this.request<any[]>(endpoint);
      return data.map((r) => this.mapRepository(r));
    } catch (err: any) {
      if (owner) {
        // Fallback to user search if group not found
        const fallback = await this.request<any[]>(`/projects?search=${encodeURIComponent(owner)}&per_page=100`);
        return fallback.map((r) => this.mapRepository(r));
      }
      throw err;
    }
  }

  public async listBranches(owner: string, repo: string): Promise<VcsBranch[]> {
    const pid = this.encodeProjectPath(owner, repo);
    const data = await this.request<any[]>(`/projects/${pid}/repository/branches?per_page=100`);
    return data.map((b) => ({
      name: b.name,
      commitSha: b.commit?.id || '',
      isProtected: Boolean(b.protected),
    }));
  }

  public async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const pid = this.encodeProjectPath(owner, repo);
    const data = await this.request<any>(`/projects/${pid}/merge_requests/${prNumber}`);
    return this.mapMergeRequest(data);
  }

  public async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsPullRequest[]> {
    const pid = this.encodeProjectPath(owner, repo);
    const glState = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
    const data = await this.request<any[]>(`/projects/${pid}/merge_requests?state=${glState}&per_page=100`);
    return data.map((mr) => this.mapMergeRequest(mr));
  }

  public async createPullRequest(
    owner: string,
    repo: string,
    input: CreatePullRequestInput
  ): Promise<VcsPullRequest> {
    const pid = this.encodeProjectPath(owner, repo);
    const payload = {
      title: input.title,
      description: input.body || '',
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
    };
    const data = await this.request<any>(`/projects/${pid}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.mapMergeRequest(data);
  }

  public async listCommits(owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]> {
    const pid = this.encodeProjectPath(owner, repo);
    const query = branchOrSha ? `?ref_name=${encodeURIComponent(branchOrSha)}&per_page=100` : `?per_page=100`;
    const data = await this.request<any[]>(`/projects/${pid}/repository/commits${query}`);
    return data.map((c) => ({
      sha: c.id,
      message: c.message || '',
      author: c.author_name || 'Unknown',
      date: c.created_at || '',
      url: c.web_url,
    }));
  }

  public async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<VcsFileContent> {
    const pid = this.encodeProjectPath(owner, repo);
    const cleanPath = encodeURIComponent(path.replace(/^\/+/, ''));
    const targetRef = encodeURIComponent(ref || 'main');
    const data = await this.request<any>(`/projects/${pid}/repository/files/${cleanPath}?ref=${targetRef}`);

    let rawContent = data.content || '';
    if (data.encoding === 'base64') {
      rawContent = Buffer.from(rawContent, 'base64').toString('utf-8');
    }

    return {
      path: data.file_path || path,
      content: rawContent,
      encoding: 'utf-8',
      size: data.size ?? rawContent.length,
      sha: data.commit_id,
    };
  }

  public async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<VcsIssue> {
    const pid = this.encodeProjectPath(owner, repo);
    const payload = {
      title: input.title,
      description: input.body || '',
      labels: input.labels ? input.labels.join(',') : undefined,
    };
    const data = await this.request<any>(`/projects/${pid}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.mapIssue(data);
  }

  public async listIssues(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsIssue[]> {
    const pid = this.encodeProjectPath(owner, repo);
    const glState = state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all';
    const data = await this.request<any[]>(`/projects/${pid}/issues?state=${glState}&per_page=100`);
    return data.map((i) => this.mapIssue(i));
  }

  private mapRepository(data: any): VcsRepository {
    return {
      id: data.id,
      name: data.name,
      fullName: data.path_with_namespace || `${data.namespace?.name}/${data.name}`,
      description: data.description,
      defaultBranch: data.default_branch || 'main',
      isPrivate: data.visibility === 'private',
      cloneUrl: data.http_url_to_repo || data.web_url,
      htmlUrl: data.web_url,
      owner: data.namespace?.full_path || data.namespace?.name || '',
      starsCount: data.star_count,
      forksCount: data.forks_count,
    };
  }

  private mapMergeRequest(data: any): VcsPullRequest {
    let state: 'open' | 'closed' | 'merged' = 'open';
    if (data.state === 'merged') {
      state = 'merged';
    } else if (data.state === 'closed') {
      state = 'closed';
    }
    return {
      id: data.id,
      number: data.iid,
      title: data.title,
      body: data.description,
      state,
      sourceBranch: data.source_branch || '',
      targetBranch: data.target_branch || '',
      author: data.author?.username || '',
      htmlUrl: data.web_url,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      mergedAt: data.merged_at || undefined,
    };
  }

  private mapIssue(data: any): VcsIssue {
    return {
      id: data.id,
      number: data.iid,
      title: data.title,
      body: data.description,
      state: data.state === 'closed' ? 'closed' : 'open',
      author: data.author?.username || '',
      htmlUrl: data.web_url,
      createdAt: data.created_at,
      labels: Array.isArray(data.labels) ? data.labels : undefined,
    };
  }
}
