import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Caps,
  ROLE_CAPS,
  signRoleClaim,
  verifyRoleClaim,
  RoleClaimBridge,
} from '../src/role_claim.js';

describe('RoleClaim: 10-Bit Capability Bitmask & HMAC-SHA256 Role Claims', () => {
  const secret = 'enterprise-host-shared-secret-1234567890';

  it('defines monotonic 10-bit capability bitmasks', () => {
    assert.equal(Caps.READ, 0x0001);
    assert.equal(Caps.POST, 0x0002);
    assert.equal(Caps.CREATE_BOARD, 0x0004);
    assert.equal(Caps.EDIT_OWN, 0x0008);
    assert.equal(Caps.MODERATE, 0x0010);
    assert.equal(Caps.FEDERATE, 0x0020);
    assert.equal(Caps.PLUGINS, 0x0040);
    assert.equal(Caps.MARKETPLACE, 0x0080);
    assert.equal(Caps.SYSOP, 0x0100);
    assert.equal(Caps.MCP_EGRESS, 0x0200);
    assert.equal(Caps.ALL_CAPS, 0x03ff);

    // Guest has READ only
    assert.equal(ROLE_CAPS.guest, 0x0001);
    // Agent has READ | POST | EDIT_OWN | PLUGINS | MARKETPLACE | MCP_EGRESS (0x02CB)
    assert.equal(ROLE_CAPS.agent, 0x02cb);
    // Moderator adds MODERATE | CREATE_BOARD (0x02DF)
    assert.equal(ROLE_CAPS.moderator, 0x02df);
    // Federator adds FEDERATE (0x02FF)
    assert.equal(ROLE_CAPS.federator, 0x02ff);
    // Sysop has all 10 bits (0x03FF)
    assert.equal(ROLE_CAPS.sysop, 0x03ff);
  });

  it('verifies legitimate role claim and grants elevated capabilities', () => {
    const now = 1000000;
    const exp = now + 3600; // 1 hour validity
    const sig = signRoleClaim(secret, 'moderator', exp);

    const res = verifyRoleClaim(secret, 'moderator', exp, sig, now);
    assert.equal(res.valid, true);
    assert.equal(res.role, 'moderator');
    assert.equal(res.caps, ROLE_CAPS.moderator);
  });

  it('fails closed to Role::Agent when signature is tampered', () => {
    const now = 1000000;
    const exp = now + 3600;
    // Sign for agent but claim sysop
    const sigAgent = signRoleClaim(secret, 'agent', exp);

    const res = verifyRoleClaim(secret, 'sysop', exp, sigAgent, now);
    assert.equal(res.valid, false);
    assert.equal(res.role, 'agent'); // Fallback
    assert.equal(res.caps, ROLE_CAPS.agent);
    assert.match(res.reason!, /Invalid cryptographic signature/);
  });

  it('fails closed to Role::Agent when token is expired', () => {
    const now = 1000000;
    const exp = now - 10; // Expired 10 seconds ago
    const sig = signRoleClaim(secret, 'sysop', exp);

    const res = verifyRoleClaim(secret, 'sysop', exp, sig, now);
    assert.equal(res.valid, false);
    assert.equal(res.role, 'agent');
    assert.equal(res.caps, ROLE_CAPS.agent);
    assert.match(res.reason!, /Role claim expired/);
  });

  it('fails closed on unknown or invalid role strings', () => {
    const now = 1000000;
    const exp = now + 3600;
    const sig = signRoleClaim(secret, 'superadmin' as any, exp);

    const res = verifyRoleClaim(secret, 'superadmin', exp, sig, now);
    assert.equal(res.valid, false);
    assert.equal(res.role, 'agent');
    assert.equal(res.caps, ROLE_CAPS.agent);
    assert.match(res.reason!, /Unknown role/);
  });

  it('operates via RoleClaimBridge wrapper', () => {
    const bridge = new RoleClaimBridge(secret);
    const now = 2000000;

    const claim = bridge.issueClaim('sysop', 1800, now);
    assert.equal(claim.role, 'sysop');
    assert.equal(claim.exp, now + 1800);

    const verified = bridge.verify(claim, now + 100);
    assert.equal(verified.valid, true);
    assert.equal(verified.role, 'sysop');
    assert.equal(bridge.hasCapability(verified.caps, Caps.SYSOP), true);
    assert.equal(bridge.hasCapability(verified.caps, Caps.MODERATE), true);
  });

  it('tolerates bounded clock skew when configured', () => {
    const now = 1000000;
    const exp = now - 50; // Expired 50 seconds ago according to host clock
    const sig = signRoleClaim(secret, 'moderator', exp);

    // Without skew tolerance: rejected as expired
    const strictRes = verifyRoleClaim(secret, 'moderator', exp, sig, now);
    assert.equal(strictRes.valid, false);

    // With 60 seconds skew tolerance: accepted
    const skewRes = verifyRoleClaim(secret, 'moderator', exp, sig, now, { clockSkewToleranceSeconds: 60 });
    assert.equal(skewRes.valid, true);
    assert.equal(skewRes.role, 'moderator');

    // Beyond skew tolerance (e.g. 50s expired vs 30s tolerance): rejected
    const expiredRes = verifyRoleClaim(secret, 'moderator', exp, sig, now, { clockSkewToleranceSeconds: 30 });
    assert.equal(expiredRes.valid, false);
  });
});
