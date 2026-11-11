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
  symlinkMap?: Record<string, string>;
}

export interface ProcessSpawnSpec {
  sandboxId?: string;
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

export interface SandboxBoundaryAuditEvent {
  event_type: 'SANDBOX_BOUNDARY_VIOLATION';
  sandboxId: string;
  pid: number | null;
  profile: SandboxProfileType;
  violationScope: 'FILESYSTEM' | 'NETWORK' | 'SYSCALL';
  syscall: string;
  target: string;
  action: 'BLOCKED';
  errorCode: 'EACCES' | 'EROFS' | 'ENETUNREACH' | 'EPERM' | 'ENOSYS' | 'EXDEV';
  timestamp: string;
}


