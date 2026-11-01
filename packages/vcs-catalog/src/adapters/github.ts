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

export class GitHubVcsAdapter extends BaseVcsAdapter {
  constructor(config: Partial<VcsProviderConfig> = {}) {
    super({ ...config, type: 'github' });
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.github.com';
  }

  protected getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github.v3+json',
    };
    if (this.config.token) {
      headers['Authorization'] = `Bearer ${this.config.token}`;
    }
    return headers;
  }

  public async getRepository(owner: string, repo: string): Promise<VcsRepository> {
    const data = await this.request<any>(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return this.mapRepository(data);
  }

  public async listRepositories(owner?: string): Promise<VcsRepository[]> {
    const endpoint = owner
      ? `/users/${encodeURIComponent(owner)}/repos?per_page=100`
      : `/user/repos?per_page=100`;
    const data = await this.request<any[]>(endpoint);
    return data.map((r) => this.mapRepository(r));
  }

  public async listBranches(owner: string, repo: string): Promise<VcsBranch[]> {
    const data = await this.request<any[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`
    );
    return data.map((b) => ({
      name: b.name,
      commitSha: b.commit?.sha || '',
      isProtected: Boolean(b.protected),
    }));
  }

  public async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const data = await this.request<any>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${prNumber}`
    );
    return this.mapPullRequest(data);
  }

  public async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsPullRequest[]> {
    const data = await this.request<any[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=100`
    );
    return data.map((pr) => this.mapPullRequest(pr));
  }

  public async createPullRequest(
    owner: string,
    repo: string,
    input: CreatePullRequestInput
  ): Promise<VcsPullRequest> {
    const payload = {
      title: input.title,
      body: input.body || '',
      head: input.sourceBranch,
      base: input.targetBranch,
      draft: input.draft ?? false,
    };
    const data = await this.request<any>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return this.mapPullRequest(data);
  }

  public async listCommits(owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]> {
    const query = branchOrSha ? `?sha=${encodeURIComponent(branchOrSha)}&per_page=100` : `?per_page=100`;
    const data = await this.request<any[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits${query}`
    );
    return data.map((c) => ({
      sha: c.sha,
      message: c.commit?.message || '',
      author: c.commit?.author?.name || c.author?.login || 'Unknown',
      date: c.commit?.author?.date || '',
      url: c.html_url,
    }));
  }

  public async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<VcsFileContent> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
    const cleanPath = path.replace(/^\/+/, '');
    const data = await this.request<any>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${cleanPath}${query}`
    );

    let rawContent = data.content || '';
    if (data.encoding === 'base64') {
      rawContent = Buffer.from(rawContent.replace(/\n/g, ''), 'base64').toString('utf-8');
    }

    return {
      path: data.path || path,
      content: rawContent,
      encoding: 'utf-8',
      size: data.size ?? rawContent.length,
      sha: data.sha,
    };
  }

  public async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<VcsIssue> {
    const payload = {
      title: input.title,
      body: input.body || '',
      labels: input.labels,
      assignees: input.assignees,
    };
    const data = await this.request<any>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return this.mapIssue(data);
  }

  public async listIssues(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsIssue[]> {
    const data = await this.request<any[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=100`
    );
    // GitHub API includes pull requests in issues endpoint; filter them out
    return data.filter((item) => !item.pull_request).map((i) => this.mapIssue(i));
  }

  private mapRepository(data: any): VcsRepository {
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name || `${data.owner?.login}/${data.name}`,
      description: data.description,
      defaultBranch: data.default_branch || 'main',
      isPrivate: Boolean(data.private),
      cloneUrl: data.clone_url || data.html_url,
      htmlUrl: data.html_url,
      owner: data.owner?.login || '',
      starsCount: data.stargazers_count,
      forksCount: data.forks_count,
    };
  }

  private mapPullRequest(data: any): VcsPullRequest {
    let state: 'open' | 'closed' | 'merged' = 'open';
    if (data.merged_at || data.merged) {
      state = 'merged';
    } else if (data.state === 'closed') {
      state = 'closed';
    }
    return {
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body,
      state,
      sourceBranch: data.head?.ref || '',
      targetBranch: data.base?.ref || '',
      author: data.user?.login || '',
      htmlUrl: data.html_url,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      mergedAt: data.merged_at || undefined,
    };
  }

  private mapIssue(data: any): VcsIssue {
    return {
      id: data.id,
      number: data.number,
      title: data.title,
      body: data.body,
      state: data.state === 'closed' ? 'closed' : 'open',
      author: data.user?.login || '',
      htmlUrl: data.html_url,
      createdAt: data.created_at,
      labels: Array.isArray(data.labels)
        ? data.labels.map((l: any) => (typeof l === 'string' ? l : l.name))
        : undefined,
    };
  }
}
