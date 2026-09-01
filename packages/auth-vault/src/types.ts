export type VaultDomain = 'personal' | 'org' | 'enterprise' | 'ephemeral';

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface VaultSecretEntry {
  refId: string;
  serverId: string;
  key: string;
  domain: VaultDomain;
  encryptedPayload: EncryptedPayload;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSecret {
  refId: string;
  serverId: string;
  key: string;
  domain: VaultDomain;
  value: string;
}
