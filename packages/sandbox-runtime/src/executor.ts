import fs from 'node:fs';
import path from 'node:path';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { ExecutionResult, ProcessSpawnSpec, SandboxBoundaryAuditEvent } from './types.js';
import { getSanitizedEnvironment } from './profiles.js';

export class SandboxedProcess {
  public static readonly PROHIBITED_KERNEL_SYSCALLS = new Set([
    'SYS_IO_URING_SETUP',
    'SYS_IO_URING_ENTER',
    'SYS_IO_URING_REGISTER',
    'IO_URING_SETUP',
    'IO_URING_ENTER',
    'IO_URING_REGISTER',
    'SYS_OPEN_BY_HANDLE_AT',
    'SYS_NAME_TO_HANDLE_AT',
    'OPEN_BY_HANDLE_AT',
    'NAME_TO_HANDLE_AT',
    'SYS_PTRACE',
    'PTRACE',
    'SYS_MOUNT',
    'MOUNT',
    'SYS_UNSHARE',
    'UNSHARE',
    'SYS_SETNS',
    'SETNS',
    'SYS_BPF',
    'BPF',
    'SYS_KEXEC_LOAD',
    'KEXEC_LOAD',
  ]);

  private child: ChildProcessWithoutNullStreams | null = null;
  private isKilled = false;
  public readonly sandboxId: string;
  private readonly auditEvents: SandboxBoundaryAuditEvent[] = [];

  constructor(private readonly spec: ProcessSpawnSpec) {
    this.sandboxId = spec.sandboxId || `sbx-${spec.policy.profile}-01`;
  }

  private resolveSymlinkTarget(targetPath: string): string {
    const normalized = path.posix.normalize(targetPath.replace(/\\/g, '/'));
    const symlinkMap = this.spec.policy.symlinkMap;
    if (symlinkMap) {
      for (const [linkPrefix, resolvedDest] of Object.entries(symlinkMap)) {
        const normLink = path.posix.normalize(linkPrefix.replace(/\\/g, '/')).replace(/\/+$/, '');
        if (normalized === normLink || normalized.startsWith(normLink + '/')) {
          const suffix = normalized.slice(normLink.length);
          return path.posix.normalize((resolvedDest + suffix).replace(/\\/g, '/'));
        }
      }
    }
    try {
      if (fs.existsSync(targetPath)) {
        const real = fs.realpathSync(targetPath).replace(/\\/g, '/');
        return path.posix.normalize(real);
      }
    } catch {
      // Fallback to lexical normalization if virtual path does not exist on host disk
    }
    return normalized;
  }

  /**
   * Experiment 2 (Sandbox Execution Boundary): Enforces assigned filesystem scope,
   * symlink canonicalization (`RESOLVE_BENEATH` / `RESOLVE_NO_SYMLINKS`), and emits
   * attributable rejection evidence (`SandboxBoundaryAuditEvent`) on out-of-scope or read-only writes.
   */
  public enforceFilesystemAccess(
    targetPath: string,
    mode: 'read' | 'write' = 'read',
    nowMs = Date.now(),
    syscallOverride?: string
  ): {
    allowed: boolean;
    errorCode?: 'EACCES' | 'EROFS' | 'EXDEV';
    auditEvent?: SandboxBoundaryAuditEvent;
  } {
    const policy = this.spec.policy;
    const syscall = syscallOverride || (mode === 'write' ? 'open(O_WRONLY)' : 'open(O_RDONLY)');

    if (mode === 'write' && (policy.readOnlyFilesystem || policy.profile === 'filesystem-readonly')) {
      const auditEvent: SandboxBoundaryAuditEvent = {
        event_type: 'SANDBOX_BOUNDARY_VIOLATION',
        sandboxId: this.sandboxId,
        pid: this.child?.pid ?? null,
        profile: policy.profile,
        violationScope: 'FILESYSTEM',
        syscall,
        target: targetPath,
        action: 'BLOCKED',
        errorCode: 'EROFS',
        timestamp: new Date(nowMs).toISOString(),
      };
      this.auditEvents.push(auditEvent);
      return { allowed: false, errorCode: 'EROFS', auditEvent };
    }

    const allowedRoots = policy.allowedWorkspacePaths && policy.allowedWorkspacePaths.length > 0
      ? policy.allowedWorkspacePaths
      : ['/workspace'];

    if (policy.profile !== 'unrestricted') {
      const normalizedTarget = path.posix.normalize(targetPath.replace(/\\/g, '/'));
      const resolvedRealTarget = this.resolveSymlinkTarget(targetPath);
      const hasRawTraversal = targetPath.replace(/\\/g, '/').split('/').includes('..');

      const isPathWithinAllowed = (candidate: string) =>
        allowedRoots.some((root) => {
          const normRoot = path.posix.normalize(root.replace(/\\/g, '/')).replace(/\/+$/, '');
          return candidate === normRoot || candidate.startsWith(normRoot + '/');
        });

      const isWithinAllowed =
        !hasRawTraversal &&
        isPathWithinAllowed(normalizedTarget) &&
        isPathWithinAllowed(resolvedRealTarget);

      if (!isWithinAllowed) {
        const auditEvent: SandboxBoundaryAuditEvent = {
          event_type: 'SANDBOX_BOUNDARY_VIOLATION',
          sandboxId: this.sandboxId,
          pid: this.child?.pid ?? null,
          profile: policy.profile,
          violationScope: 'FILESYSTEM',
          syscall,
          target: resolvedRealTarget !== normalizedTarget ? `${targetPath} -> ${resolvedRealTarget}` : targetPath,
          action: 'BLOCKED',
          errorCode: 'EACCES',
          timestamp: new Date(nowMs).toISOString(),
        };
        this.auditEvents.push(auditEvent);
        return { allowed: false, errorCode: 'EACCES', auditEvent };
      }
    }

    return { allowed: true };
  }

  /**
   * Experiment 2 (Seccomp & eBPF Syscall Boundary): Enforces kernel syscall containment,
   * unconditionally blocking `io_uring_enter`/`io_uring_setup`, `open_by_handle_at`/`name_to_handle_at`,
   * and validating `openat2` (`SYS_OPENAT2`) flags (`RESOLVE_BENEATH` & target containment).
   */
  public enforceSyscallBoundary(
    syscall: string,
    target = '',
    flags: string[] = [],
    nowMs = Date.now()
  ): {
    allowed: boolean;
    errorCode?: 'EPERM' | 'ENOSYS' | 'EACCES' | 'EROFS' | 'EXDEV' | 'ENETUNREACH';
    auditEvent?: SandboxBoundaryAuditEvent;
  } {
    const normalizedSyscall = syscall.trim().toUpperCase();
    const policy = this.spec.policy;

    if (SandboxedProcess.PROHIBITED_KERNEL_SYSCALLS.has(normalizedSyscall)) {
      const auditEvent: SandboxBoundaryAuditEvent = {
        event_type: 'SANDBOX_BOUNDARY_VIOLATION',
        sandboxId: this.sandboxId,
        pid: this.child?.pid ?? null,
        profile: policy.profile,
        violationScope: 'SYSCALL',
        syscall: normalizedSyscall,
        target: target || normalizedSyscall,
        action: 'BLOCKED',
        errorCode: 'EPERM',
        timestamp: new Date(nowMs).toISOString(),
      };
      this.auditEvents.push(auditEvent);
      return { allowed: false, errorCode: 'EPERM', auditEvent };
    }

    if (normalizedSyscall === 'SYS_OPENAT2' || normalizedSyscall === 'OPENAT2') {
      const upperFlags = flags.map((f) => f.toUpperCase());
      if (upperFlags.includes('RESOLVE_IN_ROOT')) {
        const auditEvent: SandboxBoundaryAuditEvent = {
          event_type: 'SANDBOX_BOUNDARY_VIOLATION',
          sandboxId: this.sandboxId,
          pid: this.child?.pid ?? null,
          profile: policy.profile,
          violationScope: 'SYSCALL',
          syscall: 'SYS_OPENAT2',
          target: target || 'RESOLVE_IN_ROOT',
          action: 'BLOCKED',
          errorCode: 'EPERM',
          timestamp: new Date(nowMs).toISOString(),
        };
        this.auditEvents.push(auditEvent);
        return { allowed: false, errorCode: 'EPERM', auditEvent };
      }
      return this.enforceFilesystemAccess(target || '/', 'read', nowMs, 'SYS_OPENAT2');
    }

    if (normalizedSyscall === 'SYS_OPENAT' || normalizedSyscall === 'OPENAT') {
      return this.enforceFilesystemAccess(target || '/', 'read', nowMs, 'SYS_OPENAT');
    }

    if (normalizedSyscall === 'SYS_CONNECT' || normalizedSyscall === 'CONNECT') {
      const [host, portStr] = (target || '0.0.0.0:80').split(':');
      return this.enforceNetworkEgress(host, portStr ? Number(portStr) : 80, nowMs);
    }

    return { allowed: true };
  }

  /**
   * Experiment 2 (Sandbox Execution Boundary): Enforces assigned network egress scope and emits
   * attributable rejection evidence (`SandboxBoundaryAuditEvent`) on prohibited egress.
   */
  public enforceNetworkEgress(
    targetHostOrIp: string,
    targetPort = 443,
    nowMs = Date.now()
  ): {
    allowed: boolean;
    errorCode?: 'ENETUNREACH' | 'EPERM';
    auditEvent?: SandboxBoundaryAuditEvent;
  } {
    const policy = this.spec.policy;
    const targetDesc = `${targetHostOrIp}:${targetPort}`;

    if (policy.profile === 'no-network') {
      const auditEvent: SandboxBoundaryAuditEvent = {
        event_type: 'SANDBOX_BOUNDARY_VIOLATION',
        sandboxId: this.sandboxId,
        pid: this.child?.pid ?? null,
        profile: policy.profile,
        violationScope: 'NETWORK',
        syscall: 'connect',
        target: targetDesc,
        action: 'BLOCKED',
        errorCode: 'ENETUNREACH',
        timestamp: new Date(nowMs).toISOString(),
      };
      this.auditEvents.push(auditEvent);
      return { allowed: false, errorCode: 'ENETUNREACH', auditEvent };
    }

    if (
      policy.profile === 'egress-allowlist' ||
      (policy.allowedEgressHosts && policy.allowedEgressHosts.length > 0)
    ) {
      const allowedHosts = (policy.allowedEgressHosts || []).map((h) => h.toLowerCase().trim());
      const normalizedHost = targetHostOrIp.toLowerCase().trim();
      if (!allowedHosts.includes(normalizedHost)) {
        const auditEvent: SandboxBoundaryAuditEvent = {
          event_type: 'SANDBOX_BOUNDARY_VIOLATION',
          sandboxId: this.sandboxId,
          pid: this.child?.pid ?? null,
          profile: policy.profile,
          violationScope: 'NETWORK',
          syscall: 'connect',
          target: targetDesc,
          action: 'BLOCKED',
          errorCode: 'EPERM',
          timestamp: new Date(nowMs).toISOString(),
        };
        this.auditEvents.push(auditEvent);
        return { allowed: false, errorCode: 'EPERM', auditEvent };
      }
    }

    return { allowed: true };
  }

  public getAuditEvents(): SandboxBoundaryAuditEvent[] {
    return [...this.auditEvents];
  }

  public spawn(): ChildProcessWithoutNullStreams {
    const env = getSanitizedEnvironment(this.spec.env, this.spec.policy);

    this.child = spawn(this.spec.command, this.spec.args, {
      env,
      cwd: this.spec.cwd || process.cwd(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return this.child;
  }

  public async executeOnce(inputPayload?: string): Promise<ExecutionResult> {
    const startTime = Date.now();
    const child = this.spawn();

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutMs = this.spec.policy.timeoutMs || 30000;
      const timer = setTimeout(() => {
        timedOut = true;
        this.kill();
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        // Memory safety guard: cap stdout at 10MB
        if (stdout.length > 10 * 1024 * 1024) {
          this.kill();
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        stderr += `\nSpawn error: ${err.message}`;
        resolve({
          stdout,
          stderr,
          exitCode: -1,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });

      if (inputPayload) {
        child.stdin.write(inputPayload);
        child.stdin.end();
      }
    });
  }

  public kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child && !this.isKilled) {
      this.isKilled = true;
      try {
        this.child.kill(signal);
      } catch {
        // Ignore kill errors if already terminated
      }
    }
  }

  public get process(): ChildProcessWithoutNullStreams | null {
    return this.child;
  }
}

