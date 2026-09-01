import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { EncryptedPayload } from './types.js';

const ALGORITHM = 'aes-256-gcm';
const DEFAULT_SALT = 'acr-meta-mcp-vault-salt-v1';

export function deriveKey(masterSecret: string, salt: string = DEFAULT_SALT): Buffer {
  return scryptSync(masterSecret, salt, 32);
}

export function encryptSecret(plainText: string, masterKey: Buffer): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag().toString('hex');

  return {
    ciphertext: encrypted,
    iv: iv.toString('hex'),
    tag,
  };
}

export function decryptSecret(payload: EncryptedPayload, masterKey: Buffer): string {
  const decipher = createDecipheriv(
    ALGORITHM,
    masterKey,
    Buffer.from(payload.iv, 'hex')
  );
  
  decipher.setAuthTag(Buffer.from(payload.tag, 'hex'));
  
  let decrypted = decipher.update(payload.ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
