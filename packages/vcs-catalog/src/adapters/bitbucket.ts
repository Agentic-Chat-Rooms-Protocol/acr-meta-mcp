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

export class BitbucketVcsAdapter extends BaseVcsAdapter {
  constructor(config: Partial<VcsProviderConfig> = {}) {
    super({ ...config, type: 'bitbucket' });
  }

  protected getDefaultBaseUrl(): string {
    return 'https://api.bitbucket.org/2.0';
  }

  protected getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.token) {
      if (this.config.username) {
        const credentials = Buffer.from(`${this.config.username}:${this.config.token}`).toString('base64');
        headers['Authorization'] = `Basic ${credentials}`;
      } else {
        headers['Authorization'] = `Bearer ${this.config.token}`;
      }
    }
    return headers;
  }

  public async getRepository(owner: string, repo: string): Promise<VcsRepository> {
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
    return this.mapRepository(data);
  }

  public async listRepositories(owner?: string): Promise<VcsRepository[]> {
    const targetWorkspace = owner || this.config.organization;
    const endpoint = targetWorkspace
      ? `/repositories/${encodeURIComponent(targetWorkspace)}?pagelen=100`
      : `/repositories?role=member&pagelen=100`;

    const data = await this.request<any>(endpoint);
    const values = Array.isArray(data.values) ? data.values : [];
    return values.map((r: any) => this.mapRepository(r));
  }

  public async listBranches(owner: string, repo: string): Promise<VcsBranch[]> {
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/refs/branches?pagelen=100`
    );
    const values = Array.isArray(data.values) ? data.values : [];
    return values.map((b: any) => ({
      name: b.name,
      commitSha: b.target?.hash || '',
      isProtected: false,
    }));
  }

  public async getPullRequest(owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pullrequests/${prNumber}`
    );
    return this.mapPullRequest(data);
  }

  public async listPullRequests(
    owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsPullRequest[]> {
    let bbState = 'OPEN';
    if (state === 'closed') bbState = 'MERGED,DECLINED';
    else if (state === 'all') bbState = 'OPEN,MERGED,DECLINED';

    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pullrequests?state=${bbState}&pagelen=100`
    );
    const values = Array.isArray(data.values) ? data.values : [];
    return values.map((pr: any) => this.mapPullRequest(pr));
  }

  public async createPullRequest(
    owner: string,
    repo: string,
    input: CreatePullRequestInput
  ): Promise<VcsPullRequest> {
    const payload = {
      title: input.title,
      summary: { raw: input.body || '' },
      source: { branch: { name: input.sourceBranch } },
      destination: { branch: { name: input.targetBranch } },
    };
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pullrequests`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );
    return this.mapPullRequest(data);
  }

  public async listCommits(owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]> {
    const query = branchOrSha ? `/${encodeURIComponent(branchOrSha)}` : '';
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits${query}?pagelen=100`
    );
    const values = Array.isArray(data.values) ? data.values : [];
    return values.map((c: any) => ({
      sha: c.hash,
      message: c.message || '',
      author: c.author?.user?.display_name || c.author?.raw || 'Unknown',
      date: c.date || '',
      url: c.links?.html?.href,
    }));
  }

  public async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<VcsFileContent> {
    const cleanPath = path.replace(/^\/+/, '');
    const commitOrRef = ref || 'HEAD';
    const text = await this.request<string>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/src/${encodeURIComponent(commitOrRef)}/${cleanPath}`
    );

    const contentStr = typeof text === 'string' ? text : JSON.stringify(text);
    return {
      path,
      content: contentStr,
      encoding: 'utf-8',
      size: Buffer.byteLength(contentStr, 'utf-8'),
    };
  }

  public async createIssue(owner: string, repo: string, input: CreateIssueInput): Promise<VcsIssue> {
    const payload = {
      title: input.title,
      content: { raw: input.body || '' },
    };
    const data = await this.request<any>(
      `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
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
    const endpoint = `/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?pagelen=100`;
    const data = await this.request<any>(endpoint);
    const values = Array.isArray(data.values) ? data.values : [];
    return values
      .map((i: any) => this.mapIssue(i))
      .filter((i: VcsIssue) => {
        if (state === 'open') return i.state === 'open';
        if (state === 'closed') return i.state === 'closed';
        return true;
      });
  }

  private mapRepository(data: any): VcsRepository {
    const cloneUrl = data.links?.clone?.find((c: any) => c.name === 'https')?.href || data.links?.html?.href || '';
    return {
      id: data.uuid || data.full_name,
      name: data.name,
      fullName: data.full_name,
      description: data.description,
      defaultBranch: data.mainbranch?.name || 'main',
      isPrivate: Boolean(data.is_private),
      cloneUrl,
      htmlUrl: data.links?.html?.href || '',
      owner: data.workspace?.slug || '',
    };
  }

  private mapPullRequest(data: any): VcsPullRequest {
    let state: 'open' | 'closed' | 'merged' = 'open';
    const rawState = (data.state || '').toUpperCase();
    if (rawState === 'MERGED') {
      state = 'merged';
    } else if (rawState === 'DECLINED' || rawState === 'SUPERSEDED') {
      state = 'closed';
    }
    return {
      id: data.id,
      number: data.id,
      title: data.title,
      body: data.summary?.raw || data.description,
      state,
      sourceBranch: data.source?.branch?.name || '',
      targetBranch: data.destination?.branch?.name || '',
      author: data.author?.display_name || data.author?.nickname || '',
      htmlUrl: data.links?.html?.href || '',
      createdAt: data.created_on,
      updatedAt: data.updated_on,
    };
  }

  private mapIssue(data: any): VcsIssue {
    const rawState = (data.state || '').toLowerCase();
    const isClosed = rawState === 'closed' || rawState === 'resolved' || rawState === 'invalid';
    return {
      id: data.id,
      number: data.id,
      title: data.title,
      body: data.content?.raw,
      state: isClosed ? 'closed' : 'open',
      author: data.reporter?.display_name || '',
      htmlUrl: data.links?.html?.href || '',
      createdAt: data.created_on,
    };
  }
}
