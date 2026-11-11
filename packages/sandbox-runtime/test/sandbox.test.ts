import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSanitizedEnvironment, SandboxedProcess, DEFAULT_SANDBOX_PROFILES } from '../src/index.js';
import { HttpMcpAdapter } from '../../transport-bridge/src/index.js';

describe('Sandbox Runtime (Containment Engine)', () => {
  it('should scrub dangerous host env vars from execution environment', () => {
    const rawEnv = {
      ACR_MOAT_SECRET: 'leaked_moat_secret',
      CUSTOM_SAFE_VAR: 'hello_world'
    };

    const sanitized = getSanitizedEnvironment(rawEnv, DEFAULT_SANDBOX_PROFILES['no-network']);
    assert.equal(sanitized.ACR_MOAT_SECRET, undefined);
    assert.equal(sanitized.CUSTOM_SAFE_VAR, 'hello_world');
    assert.equal(sanitized.ACR_SANDBOX_PROFILE, 'no-network');
    assert.equal(sanitized.HTTP_PROXY, 'http://0.0.0.0:0');
  });

  it('should execute node inline command safely and return stdout', async () => {
    const sandbox = new SandboxedProcess({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify({ status: "ok" }))'],
      env: {},
      policy: DEFAULT_SANDBOX_PROFILES['workspace-scoped']
    });

    const res = await sandbox.executeOnce();
    assert.equal(res.exitCode, 0);
    assert.equal(res.timedOut, false);
    const parsed = JSON.parse(res.stdout.trim());
    assert.equal(parsed.status, 'ok');
  });

  it('Experiment 2 (Sandbox Execution Boundary): blocks out-of-scope filesystem & network access with attributable rejection evidence', () => {
    const sandbox = new SandboxedProcess({
      sandboxId: 'sbx-exp2-001',
      command: process.execPath,
      args: ['-v'],
      env: {},
      policy: {
        profile: 'no-network',
        allowedWorkspacePaths: ['/workspace/tenant-a'],
        readOnlyFilesystem: false,
      },
    });

    // 1. In-scope filesystem access succeeds
    const validFs = sandbox.enforceFilesystemAccess('/workspace/tenant-a/src/index.ts', 'write');
    assert.equal(validFs.allowed, true);

    // 2. Out-of-scope filesystem escape (/etc/shadow and path traversal) blocked with EACCES + attributable audit event
    const escapedFs = sandbox.enforceFilesystemAccess('/etc/shadow', 'read');
    assert.equal(escapedFs.allowed, false);
    assert.equal(escapedFs.errorCode, 'EACCES');
    assert.equal(escapedFs.auditEvent?.sandboxId, 'sbx-exp2-001');
    assert.equal(escapedFs.auditEvent?.violationScope, 'FILESYSTEM');
    assert.equal(escapedFs.auditEvent?.action, 'BLOCKED');

    const traversalFs = sandbox.enforceFilesystemAccess('/workspace/tenant-a/../../etc/passwd', 'read');
    assert.equal(traversalFs.allowed, false);
    assert.equal(traversalFs.errorCode, 'EACCES');

    // 3. Prohibited network egress under no-network profile blocked with ENETUNREACH + attributable audit event
    const netAttempt = sandbox.enforceNetworkEgress('169.254.169.254', 80);
    assert.equal(netAttempt.allowed, false);
    assert.equal(netAttempt.errorCode, 'ENETUNREACH');
    assert.equal(netAttempt.auditEvent?.sandboxId, 'sbx-exp2-001');
    assert.equal(netAttempt.auditEvent?.violationScope, 'NETWORK');
    assert.equal(netAttempt.auditEvent?.syscall, 'connect');
    assert.equal(netAttempt.auditEvent?.action, 'BLOCKED');

    // 4. Prohibited syscalls (SYS_IO_URING_ENTER, SYS_OPENAT2 with RESOLVE_IN_ROOT) blocked with EPERM + audit event
    const uringAttempt = sandbox.enforceSyscallBoundary('SYS_IO_URING_ENTER', '/etc/shadow');
    assert.equal(uringAttempt.allowed, false);
    assert.equal(uringAttempt.errorCode, 'EPERM');
    assert.equal(uringAttempt.auditEvent?.violationScope, 'SYSCALL');

    const openat2Attempt = sandbox.enforceSyscallBoundary('SYS_OPENAT2', '/workspace/tenant-a/file', ['RESOLVE_IN_ROOT']);
    assert.equal(openat2Attempt.allowed, false);
    assert.equal(openat2Attempt.errorCode, 'EPERM');

    assert.equal(sandbox.getAuditEvents().length, 5);
  });

  it('Experiment 1 (MCP Integration Cancellation During Transport Interruption): reports truthful OUTCOME_UNKNOWN with zero silent retries', async () => {
    let remoteInvocationCount = 0;
    const abortController = new AbortController();

    const adapter = new HttpMcpAdapter({
      url: 'https://mcp.example.com/rpc',
      transportSendFn: async (_req, signal) => {
        remoteInvocationCount += 1;
        // Simulate in-flight transport interruption while caller cancels the tool call
        return await new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new Error('ECONNRESET: transport stream interrupted during cancellation'));
            },
            { once: true }
          );
          setTimeout(() => {
            abortController.abort('user_cancelled_mid_flight');
          }, 10);
        });
      },
    });

    await adapter.connect();
    const outcome = await adapter.callToolWithSignal(
      'github.merge_pull_request',
      { pull_number: 42 },
      {
        signal: abortController.signal,
        requestId: 'req-cancel-exp1',
        cancelReason: 'Operator cancelled tool call during transport interruption',
      }
    );

    // Required result: truthful OUTCOME_UNKNOWN state, notifications/cancelled emitted, and NO silent retry!
    assert.equal(outcome.status, 'OUTCOME_UNKNOWN');
    assert.equal(outcome.retryAttempted, false);
    assert.equal(outcome.attemptCount, 1);
    assert.equal(remoteInvocationCount, 1, 'Must never silently retry a potentially completed side effect');
    assert.equal(outcome.cancellationSent, true);

    const notifications = adapter.getEmittedNotifications();
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].method, 'notifications/cancelled');
    assert.equal(notifications[0].params.requestId, 'req-cancel-exp1');
  });
});

