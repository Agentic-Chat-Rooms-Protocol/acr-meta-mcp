import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AuthVault } from '../src/index.js';

describe('Auth Vault (Multi-Domain Credential Engine)', () => {
  it('should encrypt and decrypt secrets cleanly', () => {
    const vault = new AuthVault();
    const ref = vault.storeSecret('sec_ref_abc123', 'github-tool', 'GITHUB_TOKEN', 'secret_value_xyz', 'personal');

    assert.equal(ref.refId, 'sec_ref_abc123');
    assert.equal(ref.domain, 'personal');

    const decrypted = vault.getSecret('sec_ref_abc123');
    assert.equal(decrypted, 'secret_value_xyz');
  });

  it('should resolve secret refs into plaintext on demand with domain protection', () => {
    const vault = new AuthVault();
    vault.storeSecret('sec_ref_ent456', 'enterprise-tool', 'AUTH', 'ent_token_999', 'enterprise');

    const refMap = {
      Authorization: 'sec_ref_ent456',
      NonSecret: 'literal_value'
    };

    const resolved = vault.resolveSecretRefs(refMap, ['enterprise', 'org']);
    assert.equal(resolved.Authorization, 'ent_token_999');
    assert.equal(resolved.NonSecret, 'literal_value');

    // Fail if caller domain is not allowed
    assert.throws(() => {
      vault.resolveSecretRefs(refMap, ['personal']);
    }, /Domain violation/);
  });
});
