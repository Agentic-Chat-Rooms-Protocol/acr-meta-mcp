import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../src/index.js';

describe('Policy Engine & Dual Consent', () => {
  it('should enforce server enable/disable rules', () => {
    const engine = new PolicyEngine();
    engine.setServerPolicy({
      serverId: 'test-server',
      enabled: false,
      quarantined: false,
      trustLevel: 'untrusted'
    });

    const res = engine.evaluateServerAccess({ did: 'did:key:agent1', role: 'agent' }, 'test-server');
    assert.equal(res.allowed, false);
    assert.equal(res.action, 'DENY');
  });

  it('should block quarantined server for agents but allow admins', () => {
    const engine = new PolicyEngine();
    engine.setServerPolicy({
      serverId: 'quarantined-server',
      enabled: true,
      quarantined: true,
      trustLevel: 'untrusted'
    });

    const agentRes = engine.evaluateServerAccess({ did: 'did:key:agent1', role: 'agent' }, 'quarantined-server');
    assert.equal(agentRes.allowed, false);

    const adminRes = engine.evaluateServerAccess({ did: 'did:key:admin1', role: 'admin' }, 'quarantined-server');
    assert.equal(adminRes.allowed, true);
  });

  it('should require human confirmation on sensitive tools for agents', () => {
    const engine = new PolicyEngine();
    engine.setServerPolicy({
      serverId: 'db-server',
      enabled: true,
      quarantined: false,
      trustLevel: 'verified'
    });

    engine.setToolPolicy({
      toolName: 'db-server__drop_table',
      enabled: true,
      action: 'REQUIRE_HUMAN_CONFIRMATION'
    });

    const agentRes = engine.evaluateToolCall({ did: 'did:key:agent1', role: 'agent' }, 'db-server', 'db-server__drop_table');
    assert.equal(agentRes.allowed, false);
    assert.equal(agentRes.action, 'REQUIRE_HUMAN_CONFIRMATION');
  });
});
