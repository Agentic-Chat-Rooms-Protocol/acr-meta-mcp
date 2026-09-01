import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSanitizedEnvironment, SandboxedProcess, DEFAULT_SANDBOX_PROFILES } from '../src/index.js';

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
});
