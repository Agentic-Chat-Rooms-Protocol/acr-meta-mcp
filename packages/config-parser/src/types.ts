export type TransportType = 'stdio' | 'sse' | 'streamable_http';

export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RemoteServerConfig {
  url: string;
  headers?: Record<string, string>;
  transport?: 'sse' | 'streamable_http';
}

export type RawServerConfig = StdioServerConfig | RemoteServerConfig;

export interface RawMcpConfig {
  mcpServers?: Record<string, RawServerConfig>;
  $schema?: string;
}

export interface SecretRef {
  refId: string;
  key: string;
  serverId: string;
  domain: 'personal' | 'org' | 'enterprise' | 'ephemeral';
  originalValue: string;
}

export interface SanitizedServerSpec {
  serverId: string;
  displayName: string;
  transport: TransportType;
  stdioSpec?: {
    command: string;
    args: string[];
    envRefs: Record<string, string>; // env key -> sec_ref_... or literal
  };
  remoteSpec?: {
    url: string;
    headerRefs: Record<string, string>; // header name -> sec_ref_... or literal
  };
  secretRefs: SecretRef[];
}

export interface InstallManifest {
  manifestVersion: string;
  generatedAt: string;
  fingerprintSha256: string;
  servers: SanitizedServerSpec[];
  totalServers: number;
  totalSecretRefs: number;
}
