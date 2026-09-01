export type ServerHealthStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED' | 'ERROR';
export type TrustLevel = 'untrusted' | 'verified' | 'internal';

export interface ServerRegistrationRecord {
  id: string;
  displayName: string;
  transport: 'stdio' | 'sse' | 'streamable_http';
  healthStatus: ServerHealthStatus;
  enabled: boolean;
  quarantined: boolean;
  trustLevel: TrustLevel;
  sandboxProfile: string;
  manifestFingerprint?: string;
  toolCount: number;
  configSpec: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  lastHealthCheck?: string;
  errorMessage?: string;
}

export interface IRegistryStore {
  save(record: ServerRegistrationRecord): Promise<void>;
  get(id: string): Promise<ServerRegistrationRecord | null>;
  list(): Promise<ServerRegistrationRecord[]>;
  delete(id: string): Promise<boolean>;
}
