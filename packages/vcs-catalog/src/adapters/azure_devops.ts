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

export class AzureDevOpsVcsAdapter extends BaseVcsAdapter {
  public readonly organization: string;
  public readonly project: string;
  public readonly apiVersion: string;

  constructor(config: Partial<VcsProviderConfig> = {}) {
    super({ ...config, type: 'azure-devops' });
    this.organization = config.organization || 'acr-org';
    this.project = config.project || 'acr-project';
    this.apiVersion = config.apiVersion || '7.1';
  }

  protected getDefaultBaseUrl(): string {
    return 'https://dev.azure.com';
  }

  protected getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.token) {
      const user = this.config.username || '';
      const creds = Buffer.from(`${user}:${this.config.token}`).toString('base64');
      headers['Authorization'] = `Basic ${creds}`;
    }
    return headers;
  }

  private getOrgProjectPrefix(): string {
    return `/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis`;
  }

  public override async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string; version?: string }> {
    const start = Date.now();
    try {
      const url = `/${encodeURIComponent(this.organization)}/_apis/projects?api-version=${this.apiVersion}`;
      const data = await this.request<any>(url);
      return {
        ok: true,
        latencyMs: Date.now() - start,
        version: `AzureDevOps-API-${this.apiVersion}`,
      };
    } catch {
      return super.healthCheck();
    }
  }

  public async getRepository(owner: string, repo: string): Promise<VcsRepository> {
    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}?api-version=${this.apiVersion}`;
    const data = await this.request<any>(url);
    return this.mapRepository(data);
  }

  public async listRepositories(_owner?: string): Promise<VcsRepository[]> {
    const url = `${this.getOrgProjectPrefix()}/git/repositories?api-version=${this.apiVersion}`;
    const data = await this.request<any>(url);
    const values = Array.isArray(data.value) ? data.value : [];
    return values.map((r: any) => this.mapRepository(r));
  }

  public async listBranches(_owner: string, repo: string): Promise<VcsBranch[]> {
    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/refs?filter=heads/&api-version=${this.apiVersion}`;
    const data = await this.request<any>(url);
    const values = Array.isArray(data.value) ? data.value : [];
    return values.map((b: any) => ({
      name: (b.name || '').replace(/^refs\/heads\//, ''),
      commitSha: b.objectId || '',
      isProtected: false,
    }));
  }

  public async getPullRequest(_owner: string, repo: string, prNumber: number): Promise<VcsPullRequest> {
    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/pullrequests/${prNumber}?api-version=${this.apiVersion}`;
    const data = await this.request<any>(url);
    return this.mapPullRequest(data);
  }

  public async listPullRequests(
    _owner: string,
    repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsPullRequest[]> {
    let adoStatus = 'active';
    if (state === 'closed') adoStatus = 'completed';
    else if (state === 'all') adoStatus = 'all';

    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/pullrequests?searchCriteria.status=${adoStatus}&api-version=${this.apiVersion}`;
    const data = await this.request<any>(url);
    const values = Array.isArray(data.value) ? data.value : [];
    return values.map((pr: any) => this.mapPullRequest(pr));
  }

  public async createPullRequest(
    _owner: string,
    repo: string,
    input: CreatePullRequestInput
  ): Promise<VcsPullRequest> {
    const sourceRef = input.sourceBranch.startsWith('refs/heads/')
      ? input.sourceBranch
      : `refs/heads/${input.sourceBranch}`;
    const targetRef = input.targetBranch.startsWith('refs/heads/')
      ? input.targetBranch
      : `refs/heads/${input.targetBranch}`;

    const payload = {
      sourceRefName: sourceRef,
      targetRefName: targetRef,
      title: input.title,
      description: input.body || '',
      isDraft: Boolean(input.draft),
    };

    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/pullrequests?api-version=${this.apiVersion}`;
    const data = await this.request<any>(url, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return this.mapPullRequest(data);
  }

  public async listCommits(_owner: string, repo: string, branchOrSha?: string): Promise<VcsCommit[]> {
    const versionQuery = branchOrSha
      ? `&searchCriteria.itemVersion.version=${encodeURIComponent(branchOrSha)}`
      : '';
    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/commits?api-version=${this.apiVersion}${versionQuery}`;
    const data = await this.request<any>(url);
    const values = Array.isArray(data.value) ? data.value : [];
    return values.map((c: any) => ({
      sha: c.commitId,
      message: c.comment || '',
      author: c.author?.name || 'Unknown',
      date: c.author?.date || '',
      url: c.remoteUrl || c.url,
    }));
  }

  public async getFileContent(
    _owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<VcsFileContent> {
    const cleanPath = path.startsWith('/') ? path : `/${path}`;
    const targetRef = ref || 'main';
    const url = `${this.getOrgProjectPrefix()}/git/repositories/${encodeURIComponent(repo)}/items?path=${encodeURIComponent(cleanPath)}&versionDescriptor.version=${encodeURIComponent(targetRef)}&includeContent=true&api-version=${this.apiVersion}`;

    const data = await this.request<any>(url);
    const contentStr = typeof data === 'string' ? data : (data.content || JSON.stringify(data));

    return {
      path,
      content: contentStr,
      encoding: 'utf-8',
      size: Buffer.byteLength(contentStr, 'utf-8'),
    };
  }

  public async createIssue(_owner: string, _repo: string, input: CreateIssueInput): Promise<VcsIssue> {
    const url = `${this.getOrgProjectPrefix()}/wit/workitems/$Issue?api-version=${this.apiVersion}`;
    const patchDocument = [
      { op: 'add', path: '/fields/System.Title', value: input.title },
      { op: 'add', path: '/fields/System.Description', value: input.body || '' },
    ];
    if (input.labels && input.labels.length > 0) {
      patchDocument.push({ op: 'add', path: '/fields/System.Tags', value: input.labels.join('; ') });
    }

    const data = await this.request<any>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(patchDocument),
    });
    return this.mapWorkItem(data);
  }

  public async listIssues(
    _owner: string,
    _repo: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<VcsIssue[]> {
    const wiqlUrl = `${this.getOrgProjectPrefix()}/wit/wiql?api-version=${this.apiVersion}`;
    let stateCondition = '';
    if (state === 'open') stateCondition = `AND [System.State] <> 'Closed' AND [System.State] <> 'Done'`;
    else if (state === 'closed') stateCondition = `AND ([System.State] = 'Closed' OR [System.State] = 'Done')`;

    const wiqlQuery = {
      query: `SELECT [System.Id], [System.Title], [System.State], [System.CreatedDate] FROM WorkItems WHERE [System.TeamProject] = '${this.project}' AND [System.WorkItemType] = 'Issue' ${stateCondition}`,
    };

    const wiqlRes = await this.request<any>(wiqlUrl, {
      method: 'POST',
      body: JSON.stringify(wiqlQuery),
    });

    const workItems = Array.isArray(wiqlRes.workItems) ? wiqlRes.workItems : [];
    if (workItems.length === 0) return [];

    const ids = workItems.slice(0, 50).map((w: any) => w.id).join(',');
    const batchUrl = `${this.getOrgProjectPrefix()}/wit/workitems?ids=${ids}&api-version=${this.apiVersion}`;
    const batchRes = await this.request<any>(batchUrl);
    const items = Array.isArray(batchRes.value) ? batchRes.value : [];
    return items.map((w: any) => this.mapWorkItem(w));
  }

  private mapRepository(data: any): VcsRepository {
    const defaultBranch = (data.defaultBranch || 'refs/heads/main').replace(/^refs\/heads\//, '');
    return {
      id: data.id,
      name: data.name,
      fullName: `${this.project}/${data.name}`,
      description: data.description,
      defaultBranch,
      isPrivate: true,
      cloneUrl: data.remoteUrl || data.webUrl,
      htmlUrl: data.webUrl || data.remoteUrl || '',
      owner: this.project,
    };
  }

  private mapPullRequest(data: any): VcsPullRequest {
    let state: 'open' | 'closed' | 'merged' = 'open';
    const status = (data.status || '').toLowerCase();
    if (status === 'completed') {
      state = 'merged';
    } else if (status === 'abandoned') {
      state = 'closed';
    }
    return {
      id: data.pullRequestId,
      number: data.pullRequestId,
      title: data.title,
      body: data.description,
      state,
      sourceBranch: (data.sourceRefName || '').replace(/^refs\/heads\//, ''),
      targetBranch: (data.targetRefName || '').replace(/^refs\/heads\//, ''),
      author: data.createdBy?.displayName || data.createdBy?.uniqueName || '',
      htmlUrl: data.url || '',
      createdAt: data.creationDate,
      updatedAt: data.closedDate || data.creationDate,
      mergedAt: status === 'completed' ? data.closedDate : undefined,
    };
  }

  private mapWorkItem(data: any): VcsIssue {
    const fields = data.fields || {};
    const rawState = (fields['System.State'] || '').toLowerCase();
    const isClosed = rawState === 'closed' || rawState === 'done';
    const tags = fields['System.Tags']
      ? fields['System.Tags'].split(';').map((t: string) => t.trim())
      : undefined;

    return {
      id: data.id,
      number: data.id,
      title: fields['System.Title'] || '',
      body: fields['System.Description'],
      state: isClosed ? 'closed' : 'open',
      author: fields['System.CreatedBy']?.displayName || '',
      htmlUrl: data.url || '',
      createdAt: fields['System.CreatedDate'] || '',
      labels: tags,
    };
  }
}
