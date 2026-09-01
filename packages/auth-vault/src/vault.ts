import { CipherAlgorithm, VaultDomain, VaultSecretEntry, VaultStorageOptions } from './types.js';
import { AcrMultipleCiphersDb } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';

export class AuthVault {
  private readonly db: AcrMultipleCiphersDb;
  private readonly defaultDomain: VaultDomain;
  private readonly defaultCipher: CipherAlgorithm;

  constructor(options: VaultStorageOptions = {}) {
    const master =
      options.masterSecret ||
      process.env.ACR_VAULT_SECRET ||
      process.env.ACR_MASTER_SECRET ||
      'acr-meta-mcp-default-master-key-082';
    
    this.defaultCipher = options.cipher || 'aes-256-gcm';
    this.defaultDomain = options.defaultDomain || 'personal';

    this.db = new AcrMultipleCiphersDb({
      dbPath: options.dbPath || process.env.ACR_VAULT_PATH,
      masterSecret: master,
      cipher: this.defaultCipher,
      kdf: options.kdf || 'pbkdf2-sha512',
    });
  }

  public storeSecret(
    refId: string,
    serverId: string,
    key: string,
    value: string,
    domain: VaultDomain = this.defaultDomain,
    cipher: CipherAlgorithm = this.defaultCipher
  ): VaultSecretEntry {
    const keys = this.db.getKeys();
    const encryptedPayload = encryptSecret(value, keys, cipher);
    const now = new Date().toISOString();

    const entry: VaultSecretEntry = {
      refId,
      serverId,
      key,
      domain,
      algorithm: cipher,
      encryptedPayload,
      createdAt: now,
      updatedAt: now,
    };

    this.db.putEntry(entry);
    return entry;
  }

  public getSecret(refId: string): string | null {
    const entry = this.db.getEntry(refId);
    if (!entry) return null;
    try {
      return decryptSecret(entry.encryptedPayload, this.db.getKeys());
    } catch {
      return null;
    }
  }

  public resolveSecretRefs(
    refMap: Record<string, string>,
    domainAllowed?: VaultDomain[]
  ): Record<string, string> {
    const resolved: Record<string, string> = {};

    for (const [k, v] of Object.entries(refMap)) {
      if (typeof v === 'string' && v.startsWith('sec_ref_')) {
        const entry = this.db.getEntry(v);
        if (entry) {
          if (domainAllowed && !domainAllowed.includes(entry.domain)) {
            throw new Error(
              `Domain violation: Secret "${k}" with domain "${entry.domain}" is not authorized in caller scope.`
            );
          }
          const plain = this.getSecret(v);
          if (plain !== null) {
            resolved[k] = plain;
            continue;
          }
        }
      }
      resolved[k] = v;
    }

    return resolved;
  }

  public deleteSecret(refId: string): boolean {
    return this.db.deleteEntry(refId);
  }

  public listSecretRefs(): Array<{
    refId: string;
    serverId: string;
    key: string;
    domain: VaultDomain;
    algorithm: CipherAlgorithm;
  }> {
    return this.db.getAllEntries().map((e) => ({
      refId: e.refId,
      serverId: e.serverId,
      key: e.key,
      domain: e.domain,
      algorithm: e.algorithm,
    }));
  }

  public rotateMasterKey(newMasterSecret: string): void {
    this.db.rotateMasterKey(newMasterSecret);
  }

  public getDatabasePath(): string | undefined {
    return this.db.dbPath;
  }
}
