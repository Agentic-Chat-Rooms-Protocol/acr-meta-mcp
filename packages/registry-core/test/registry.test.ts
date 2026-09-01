import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MetaMcpRegistry } from '../src/index.js';

describe('Registry Core (State Machine & Server Persistence)', () => {
  it('should register, toggle, and update server health', () => {
    const registry = new MetaMcpRegistry();
    const server = registry.registerServer('gitee-server', {
      displayName: 'Gitee Enterprise MCP',
      transport: 'sse',
      trustLevel: 'verified'
    });

    assert.equal(server.id, 'gitee-server');
    assert.equal(server.enabled, true);
    assert.equal(server.quarantined, false);
    assert.equal(server.healthStatus, 'OFFLINE');

    const toggled = registry.toggleEnabled('gitee-server', false);
    assert.equal(toggled.enabled, false);

    const quarantined = registry.toggleQuarantine('gitee-server', true);
    assert.equal(quarantined.quarantined, true);

    const updated = registry.updateHealth('gitee-server', 'ONLINE', 12);
    assert.equal(updated.healthStatus, 'ONLINE');
    assert.equal(updated.toolCount, 12);
  });
});
