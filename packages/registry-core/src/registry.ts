import { ServerRegistrationRecord } from './types.js';

export class MetaMcpRegistry {
  private readonly servers = new Map<string, ServerRegistrationRecord>();

  public registerServer(
    id: string,
    data: {
      displayName?: string;
      transport: 'stdio' | 'sse' | 'streamable_http';
      sandboxProfile?: string;
      trustLevel?: 'untrusted' | 'verified' | 'internal';
      manifestFingerprint?: string;
      configSpec?: Record<string, unknown>;
      enabled?: boolean;
    }
  ): ServerRegistrationRecord {
    const now = new Date().toISOString();
    const record: ServerRegistrationRecord = {
      id,
      displayName: data.displayName || id,
      transport: data.transport,
      healthStatus: 'OFFLINE',
      enabled: data.enabled ?? true,
      quarantined: false,
      trustLevel: data.trustLevel || 'untrusted',
      sandboxProfile: data.sandboxProfile || 'no-network',
      manifestFingerprint: data.manifestFingerprint,
      toolCount: 0,
      configSpec: data.configSpec || {},
      createdAt: now,
      updatedAt: now,
    };

    this.servers.set(id, record);
    return record;
  }

  public getServer(id: string): ServerRegistrationRecord | undefined {
    return this.servers.get(id);
  }

  public listServers(): ServerRegistrationRecord[] {
    return Array.from(this.servers.values());
  }

  public toggleEnabled(id: string, enabled?: boolean): ServerRegistrationRecord {
    const server = this.servers.get(id);
    if (!server) {
      throw new Error(`Server "${id}" not found in registry.`);
    }
    server.enabled = enabled !== undefined ? enabled : !server.enabled;
    server.updatedAt = new Date().toISOString();
    return server;
  }

  public toggleQuarantine(id: string, quarantined?: boolean): ServerRegistrationRecord {
    const server = this.servers.get(id);
    if (!server) {
      throw new Error(`Server "${id}" not found in registry.`);
    }
    server.quarantined = quarantined !== undefined ? quarantined : !server.quarantined;
    server.updatedAt = new Date().toISOString();
    return server;
  }

  public updateHealth(
    id: string,
    status: ServerRegistrationRecord['healthStatus'],
    toolCount?: number,
    errorMessage?: string
  ): ServerRegistrationRecord {
    const server = this.servers.get(id);
    if (!server) {
      throw new Error(`Server "${id}" not found in registry.`);
    }
    server.healthStatus = status;
    if (toolCount !== undefined) server.toolCount = toolCount;
    if (errorMessage !== undefined) server.errorMessage = errorMessage;
    server.lastHealthCheck = new Date().toISOString();
    server.updatedAt = new Date().toISOString();
    return server;
  }

  public deleteServer(id: string): boolean {
    return this.servers.delete(id);
  }
}
