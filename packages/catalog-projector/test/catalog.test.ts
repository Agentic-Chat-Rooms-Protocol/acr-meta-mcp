import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CatalogProjector, namespaceTool, denamespaceTool } from '../src/index.js';

describe('Catalog Projector (3-Tier Catalog Pipeline)', () => {
  it('should namespace and denamespace tool identifiers deterministically', () => {
    const ns = namespaceTool('gitee-server', 'create_issue');
    assert.equal(ns, 'gitee-server__create_issue');

    const { serverId, originalName } = denamespaceTool(ns);
    assert.equal(serverId, 'gitee-server');
    assert.equal(originalName, 'create_issue');
  });

  it('should transform Raw -> Policy -> Projected catalog accurately', () => {
    const rawToolsMap = {
      github: [
        { name: 'list_repos', description: 'List repositories' },
        { name: 'delete_repo', description: 'Delete repository' },
      ],
      internal_db: [
        { name: 'read_metrics', description: 'Read system metrics' }
      ]
    };

    const projector = new CatalogProjector({
      isServerEnabled: (s) => s === 'github' || s === 'internal_db',
      isServerQuarantined: () => false,
      isToolEnabled: (t) => t !== 'github__delete_repo'
    });

    const raw = projector.buildRawCatalog(rawToolsMap);
    assert.equal(raw.totalDiscovered, 3);

    const policy = projector.buildPolicyCatalog(raw);
    assert.equal(policy.totalPolicyAllowed, 2);
    assert.equal(policy.totalFiltered, 1);
    assert.ok(policy.tools.every(t => t.name !== 'github__delete_repo'));

    const projected = projector.projectForCaller(policy, {
      did: 'did:key:agent-readonly',
      role: 'guest'
    });

    // Guest should only see read/list tools
    assert.equal(projected.totalVisible, 2);
  });
});
