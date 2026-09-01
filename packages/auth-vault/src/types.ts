export type VaultDomain = 'personal' | 'org' | 'enterprise' | 'ephemeral';

export type CipherAlgorithm = 'aes-256-gcm' | 'chacha20-poly1305' | 'sqlcipher-v4';

export type KdfAlgorithm = 'pbkdf2-sha512' | 'scrypt';

export interface EncryptedPayload {
  algorithm?: CipherAlgorithm;
  ciphertext: string;
  iv: string;
  tag: string;
  salt?: string;
}

export interface VaultSecretEntry {
  refId: string;
  serverId: string;
  key: string;
  domain: VaultDomain;
  algorithm: CipherAlgorithm;
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
  algorithm?: CipherAlgorithm;
}

export interface VaultDbMetadata {
  magic: string; // 'ACR_MCDB_V1'
  version: number;
  cipher: CipherAlgorithm;
  kdf: KdfAlgorithm;
  kdfIterations: number;
  pageSize: number;
  salt: string;
  headerHmac: string;
  createdAt: string;
  updatedAt: string;
}

export interface VaultStorageOptions {
  dbPath?: string; // If omitted, operates in memory
  masterSecret?: string;
  cipher?: CipherAlgorithm;
  kdf?: KdfAlgorithm;
  defaultDomain?: VaultDomain;
}
