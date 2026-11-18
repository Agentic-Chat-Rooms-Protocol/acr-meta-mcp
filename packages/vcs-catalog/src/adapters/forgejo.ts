import { GiteaVcsAdapter } from './gitea.js';
import { VcsProviderConfig } from '../types.js';

export class ForgejoVcsAdapter extends GiteaVcsAdapter {
  constructor(config: Partial<VcsProviderConfig> = {}) {
    super({ ...config, type: 'forgejo' });
    (this as any).providerType = 'forgejo';
  }

  protected override getDefaultBaseUrl(): string {
    return 'https://codeberg.org/api/v1';
  }

  protected override getCommonHeaders(): Record<string, string> {
    return {
      ...super.getCommonHeaders(),
      'User-Agent': 'ACR-Meta-MCP/1.0.0 (ForgejoAdapter)',
    };
  }

  public override async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string; version?: string }> {
    const start = Date.now();
    try {
      const data = await this.request<any>('/version');
      return {
        ok: true,
        latencyMs: Date.now() - start,
        version: data.version || 'forgejo-compatible',
      };
    } catch {
      return super.healthCheck();
    }
  }
}
