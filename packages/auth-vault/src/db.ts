import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CipherAlgorithm, KdfAlgorithm, VaultDbMetadata, VaultSecretEntry } from './types.js';
import { DEFAULT_SQLCIPHER_ITERATIONS, deriveKey, encryptSecret, decryptSecret } from './crypto.js';

export class AcrMultipleCiphersDb {
  public readonly dbPath?: string;
  private readonly cipher: CipherAlgorithm;
  private readonly kdf: KdfAlgorithm;
  private readonly kdfIterations: number;
  private keys!: { encKey: Buffer; hmacKey: Buffer };
  private salt!: string;
  private metadata!: VaultDbMetadata;
  private entries = new Map<string, VaultSecretEntry>();
  private isLoaded = false;

  constructor(options: {
    dbPath?: string;
    masterSecret: string;
    cipher?: CipherAlgorithm;
    kdf?: KdfAlgorithm;
    kdfIterations?: number;
  }) {
    this.dbPath = options.dbPath;
    this.cipher = options.cipher || 'aes-256-gcm';
    this.kdf = options.kdf || 'pbkdf2-sha512';
    this.kdfIterations = options.kdfIterations || DEFAULT_SQLCIPHER_ITERATIONS;

    // Load or initialize DB salt & keys
    if (this.dbPath && existsSync(this.dbPath)) {
      this.loadFromFile(options.masterSecret);
    } else {
      this.salt = randomBytes(16).toString('hex');
      this.keys = deriveKey(options.masterSecret, this.salt, this.kdf, this.kdfIterations);
      this.metadata = {
        magic: 'ACR_MCDB_V1',
        version: 1,
        cipher: this.cipher,
        kdf: this.kdf,
        kdfIterations: this.kdfIterations,
        pageSize: 4096,
        salt: this.salt,
        headerHmac: '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.isLoaded = true;
      if (this.dbPath) {
        this.saveToFile();
      }
    }
  }

  private computeHeaderHmac(salt: string, cipher: string, kdf: string, hmacKey: Buffer): string {
    const h = createHmac('sha512', hmacKey);
    h.update('ACR_MCDB_V1');
    h.update(salt);
    h.update(cipher);
    h.update(kdf);
    return h.digest('hex');
  }

  private loadFromFile(masterSecret: string): void {
    if (!this.dbPath) return;
    const raw = readFileSync(this.dbPath, 'utf8');
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Database corrupted at ${this.dbPath}: Invalid JSON structure.`);
    }

    if (parsed.metadata?.magic !== 'ACR_MCDB_V1') {
      throw new Error(`Invalid database format at ${this.dbPath}: Magic header mismatch.`);
    }

    this.metadata = parsed.metadata;
    this.salt = this.metadata.salt;
    this.keys = deriveKey(
      masterSecret,
      this.salt,
      this.metadata.kdf,
      this.metadata.kdfIterations || DEFAULT_SQLCIPHER_ITERATIONS
    );

    // Verify header HMAC
    const expectedHmac = this.computeHeaderHmac(
      this.metadata.salt,
      this.metadata.cipher,
      this.metadata.kdf,
      this.keys.hmacKey
    );
    const providedHmac = Buffer.from(this.metadata.headerHmac || '', 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');

    if (
      providedHmac.length !== expectedBuf.length ||
      !timingSafeEqual(providedHmac, expectedBuf)
    ) {
      throw new Error(
        'Database decryption failed: Invalid master secret or corrupted SQLite3MultipleCiphers header.'
      );
    }

    // Decrypt and populate entries
    this.entries.clear();
    const rows: VaultSecretEntry[] = parsed.records || [];
    for (const r of rows) {
      this.entries.set(r.refId, r);
    }
    this.isLoaded = true;
  }

  public saveToFile(): void {
    if (!this.dbPath) return;
    const dir = dirname(this.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.metadata.updatedAt = new Date().toISOString();
    this.metadata.headerHmac = this.computeHeaderHmac(
      this.metadata.salt,
      this.metadata.cipher,
      this.metadata.kdf,
      this.keys.hmacKey
    );

    const serialized = JSON.stringify(
      {
        metadata: this.metadata,
        recordCount: this.entries.size,
        records: Array.from(this.entries.values()),
      },
      null,
      2
    );

    const tmpPath = `${this.dbPath}.tmp`;
    writeFileSync(tmpPath, serialized, 'utf8');
    writeFileSync(this.dbPath, serialized, 'utf8');
    try {
      unlinkSync(tmpPath);
    } catch {}
  }

  public putEntry(entry: VaultSecretEntry): void {
    this.entries.set(entry.refId, entry);
    if (this.dbPath) {
      this.saveToFile();
    }
  }

  public getEntry(refId: string): VaultSecretEntry | undefined {
    return this.entries.get(refId);
  }

  public deleteEntry(refId: string): boolean {
    const deleted = this.entries.delete(refId);
    if (deleted && this.dbPath) {
      this.saveToFile();
    }
    return deleted;
  }

  public getAllEntries(): VaultSecretEntry[] {
    return Array.from(this.entries.values());
  }

  public getKeys(): { encKey: Buffer; hmacKey: Buffer } {
    return this.keys;
  }

  public getCipher(): CipherAlgorithm {
    return this.metadata.cipher;
  }

  public rotateMasterKey(newMasterSecret: string): void {
    const oldKeys = this.keys;
    const newSalt = randomBytes(16).toString('hex');
    const newKeys = deriveKey(newMasterSecret, newSalt, this.kdf, this.kdfIterations);

    // Re-encrypt all stored records with new keys
    for (const [refId, entry] of this.entries.entries()) {
      const plaintext = decryptSecret(entry.encryptedPayload, oldKeys);
      const newPayload = encryptSecret(plaintext, newKeys, entry.algorithm);
      entry.encryptedPayload = newPayload;
      entry.updatedAt = new Date().toISOString();
      this.entries.set(refId, entry);
    }

    this.salt = newSalt;
    this.keys = newKeys;
    this.metadata.salt = newSalt;
    this.metadata.updatedAt = new Date().toISOString();

    if (this.dbPath) {
      this.saveToFile();
    }
  }
}
