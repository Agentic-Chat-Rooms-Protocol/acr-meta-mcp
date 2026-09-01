import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  pbkdf2Sync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { CipherAlgorithm, EncryptedPayload, KdfAlgorithm } from './types.js';

export const DEFAULT_SALT = 'acr-meta-mcp-vault-salt-v1';
export const DEFAULT_SQLCIPHER_ITERATIONS = 256000;

/**
 * Derives a 256-bit encryption key and HMAC key using PBKDF2-HMAC-SHA512 or Scrypt.
 */
export function deriveKey(
  masterSecret: string,
  salt: string | Buffer = DEFAULT_SALT,
  kdf: KdfAlgorithm = 'pbkdf2-sha512',
  iterations: number = DEFAULT_SQLCIPHER_ITERATIONS
): { encKey: Buffer; hmacKey: Buffer } {
  const saltBuf = typeof salt === 'string' ? Buffer.from(salt, 'utf8') : salt;

  if (kdf === 'pbkdf2-sha512') {
    // 64 bytes total: first 32 bytes for AES/ChaCha, second 32 bytes for HMAC
    const derived = pbkdf2Sync(masterSecret, saltBuf, iterations, 64, 'sha512');
    return {
      encKey: derived.subarray(0, 32),
      hmacKey: derived.subarray(32, 64),
    };
  } else {
    // Scrypt KDF fallback
    const derived = scryptSync(masterSecret, saltBuf, 64);
    return {
      encKey: derived.subarray(0, 32),
      hmacKey: derived.subarray(32, 64),
    };
  }
}

/**
 * Encrypts data using the selected cipher scheme (AES-GCM, ChaCha20-Poly1305, or SQLCipher-v4 CBC+HMAC).
 */
export function encryptSecret(
  plainText: string,
  keys: { encKey: Buffer; hmacKey: Buffer },
  algorithm: CipherAlgorithm = 'aes-256-gcm'
): EncryptedPayload {
  if (algorithm === 'chacha20-poly1305') {
    const iv = randomBytes(12); // 96-bit nonce
    const cipher = createCipheriv('chacha20-poly1305', keys.encKey, iv, {
      authTagLength: 16,
    });

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      algorithm,
      ciphertext: encrypted,
      iv: iv.toString('hex'),
      tag,
    };
  } else if (algorithm === 'sqlcipher-v4') {
    // SQLCipher mode: AES-256-CBC with HMAC-SHA512 authentication tag
    const iv = randomBytes(16); // 128-bit CBC IV
    const cipher = createCipheriv('aes-256-cbc', keys.encKey, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // HMAC over IV + Ciphertext using hmacKey
    const hmac = createHmac('sha512', keys.hmacKey);
    hmac.update(iv);
    hmac.update(Buffer.from(encrypted, 'hex'));
    const tag = hmac.digest('hex');

    return {
      algorithm,
      ciphertext: encrypted,
      iv: iv.toString('hex'),
      tag,
    };
  } else {
    // Default: AES-256-GCM (AEAD)
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keys.encKey, iv);

    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');

    return {
      algorithm: 'aes-256-gcm',
      ciphertext: encrypted,
      iv: iv.toString('hex'),
      tag,
    };
  }
}

/**
 * Decrypts data using the corresponding algorithm and keys with strict MAC / AEAD validation.
 */
export function decryptSecret(
  payload: EncryptedPayload,
  keys: { encKey: Buffer; hmacKey: Buffer }
): string {
  const algorithm = payload.algorithm || 'aes-256-gcm';

  if (algorithm === 'chacha20-poly1305') {
    const decipher = createDecipheriv(
      'chacha20-poly1305',
      keys.encKey,
      Buffer.from(payload.iv, 'hex'),
      { authTagLength: 16 }
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

    let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } else if (algorithm === 'sqlcipher-v4') {
    const iv = Buffer.from(payload.iv, 'hex');
    const ciphertextBuf = Buffer.from(payload.ciphertext, 'hex');

    // Verify HMAC-SHA512 in constant time
    const hmac = createHmac('sha512', keys.hmacKey);
    hmac.update(iv);
    hmac.update(ciphertextBuf);
    const expectedTag = hmac.digest();
    const providedTag = Buffer.from(payload.tag, 'hex');

    if (
      expectedTag.length !== providedTag.length ||
      !timingSafeEqual(expectedTag, providedTag)
    ) {
      throw new Error('SQLCipher HMAC authentication failed: Corrupt or tampered secret record.');
    }

    const decipher = createDecipheriv('aes-256-cbc', keys.encKey, iv);
    let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } else {
    // AES-256-GCM
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keys.encKey,
      Buffer.from(payload.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));

    let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
