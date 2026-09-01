import { VaultDomain, VaultSecretEntry } from './types.js';
import { decryptSecret, deriveKey, encryptSecret } from './crypto.js';

export interface AuthVaultOptions {
  masterSecret?: string;
  defaultDomain?: VaultDomain;
}

export class AuthVault {
  private readonly masterKey: Buffer;
  private readonly entries = new Map<string, VaultSecretEntry>();
  private readonly defaultDomain: VaultDomain;

  constructor(options: AuthVaultOptions = {}) {
    const master = options.masterSecret || process.env.ACR_VAULT_SECRET || 'acr-meta-mcp-default-master-key-082';
    this.masterKey = deriveKey(master);
    this.defaultDomain = options.defaultDomain || 'personal';
  }

  public storeSecret(
    refId: string,
    serverId: string,
    key: string,
    value: string,
    domain: VaultDomain = this.defaultDomain
  ): VaultSecretEntry {
    const encryptedPayload = encryptSecret(value, this.masterKey);
    const now = new Date().toISOString();

    const entry: VaultSecretEntry = {
      refId,
      serverId,
      key,
      domain,
      encryptedPayload,
      createdAt: now,
      updatedAt: now,
    };

    this.entries.set(refId, entry);
    return entry;
  }

  public getSecret(refId: string): string | null {
    const entry = this.entries.get(refId);
    if (!entry) return null;
    try {
      return decryptSecret(entry.encryptedPayload, this.masterKey);
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
        const entry = this.entries.get(v);
        if (entry) {
          if (domainAllowed && !domainAllowed.includes(entry.domain)) {
            throw new Error(`Domain violation: Secret "${k}" with domain "${entry.domain}" is not authorized in caller scope.`);
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
    return this.entries.delete(refId);
  }

  public listSecretRefs(): Array<{ refId: string; serverId: string; key: string; domain: VaultDomain }> {
    return Array.from(this.entries.values()).map((e) => ({
      refId: e.refId,
      serverId: e.serverId,
      key: e.key,
      domain: e.domain,
    }));
  }
}
