export type SandboxProfileType =
  | 'no-network'
  | 'egress-allowlist'
  | 'filesystem-readonly'
  | 'workspace-scoped'
  | 'unrestricted';

export interface SandboxPolicyConfig {
  profile: SandboxProfileType;
  allowedEgressHosts?: string[];
  maxMemoryMb?: number;
  timeoutMs?: number;
  readOnlyFilesystem?: boolean;
  allowedWorkspacePaths?: string[];
}

export interface ProcessSpawnSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  policy: SandboxPolicyConfig;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}
