import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthVault } from '../src/vault.js';
import { deriveKey, encryptSecret, decryptSecret } from '../src/crypto.js';

describe('Auth Vault (SQLite3MultipleCiphers & SQLCipher Engine)', () => {
  const testDbFile = join(tmpdir(), `acr_test_vault_${Date.now()}.db`);

  after(() => {
    if (existsSync(testDbFile)) {
      try {
        unlinkSync(testDbFile);
      } catch {}
    }
  });

  it('1. should encrypt and decrypt across AES-256-GCM, ChaCha20-Poly1305, and SQLCipher-v4', () => {
    const keys = deriveKey('super-master-key-007', 'test-salt-123');

    // AES-256-GCM
    const gcmPayload = encryptSecret('secret-gcm-data', keys, 'aes-256-gcm');
    assert.equal(gcmPayload.algorithm, 'aes-256-gcm');
    assert.equal(decryptSecret(gcmPayload, keys), 'secret-gcm-data');

    // ChaCha20-Poly1305
    const chachaPayload = encryptSecret('secret-chacha-data', keys, 'chacha20-poly1305');
    assert.equal(chachaPayload.algorithm, 'chacha20-poly1305');
    assert.equal(decryptSecret(chachaPayload, keys), 'secret-chacha-data');

    // SQLCipher-v4 (AES-256-CBC + HMAC-SHA512)
    const sqlcipherPayload = encryptSecret('secret-sqlcipher-data', keys, 'sqlcipher-v4');
    assert.equal(sqlcipherPayload.algorithm, 'sqlcipher-v4');
    assert.equal(decryptSecret(sqlcipherPayload, keys), 'secret-sqlcipher-data');
  });

  it('2. should persist secrets to isolated database file and reload across instances', () => {
    const vault1 = new AuthVault({
      dbPath: testDbFile,
      masterSecret: 'vault-master-passphrase-99',
      cipher: 'aes-256-gcm',
    });

    vault1.storeSecret(
      'sec_ref_context7_token',
      'context7',
      'CONTEXT7_API_KEY',
      'dynamic-ctx7-key-value',
      'personal',
      'chacha20-poly1305'
    );
    vault1.storeSecret(
      'sec_ref_gitee_token',
      'gitee-cloud',
      'GITEE_TOKEN',
      'dynamic-gitee-token-value',
      'org',
      'sqlcipher-v4'
    );

    assert.ok(existsSync(testDbFile), 'Database file should be created on disk');

    // Reopen with instance 2
    const vault2 = new AuthVault({
      dbPath: testDbFile,
      masterSecret: 'vault-master-passphrase-99',
    });

    assert.equal(vault2.getSecret('sec_ref_context7_token'), 'dynamic-ctx7-key-value');
    assert.equal(vault2.getSecret('sec_ref_gitee_token'), 'dynamic-gitee-token-value');
  });

  it('3. should reject database opening with invalid master key (tamper protection)', () => {
    assert.throws(
      () => {
        new AuthVault({
          dbPath: testDbFile,
          masterSecret: 'wrong-master-passphrase',
        });
      },
      /Database decryption failed/
    );
  });

  it('4. should rotate master key and re-encrypt all stored database records', () => {
    const vault = new AuthVault({
      dbPath: testDbFile,
      masterSecret: 'vault-master-passphrase-99',
    });

    vault.rotateMasterKey('new-stronger-passphrase-2026');

    // Reopen with new passphrase
    const reloadedVault = new AuthVault({
      dbPath: testDbFile,
      masterSecret: 'new-stronger-passphrase-2026',
    });

    assert.equal(reloadedVault.getSecret('sec_ref_context7_token'), 'dynamic-ctx7-key-value');
    assert.equal(reloadedVault.getSecret('sec_ref_gitee_token'), 'dynamic-gitee-token-value');
  });

  it('5. should enforce domain boundaries on secret resolution', () => {
    const vault = new AuthVault({
      dbPath: testDbFile,
      masterSecret: 'new-stronger-passphrase-2026',
    });

    const envMap = {
      TOKEN: 'sec_ref_gitee_token',
    };

    // Allowed for org domain
    const resolved = vault.resolveSecretRefs(envMap, ['org', 'enterprise']);
    assert.equal(resolved.TOKEN, 'dynamic-gitee-token-value');

    // Rejected if domain not in allowed scope
    assert.throws(() => {
      vault.resolveSecretRefs(envMap, ['personal']);
    }, /Domain violation/);
  });
});
