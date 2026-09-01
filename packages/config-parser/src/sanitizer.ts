import { createHash, randomBytes } from 'node:crypto';
import { SecretRef } from './types.js';

const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /key/i,
  /password/i,
  /auth/i,
  /bearer/i,
  /credential/i,
  /api[_-]?key/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function sanitizeEnvAndHeaders(
  serverId: string,
  envOrHeaders: Record<string, string> | undefined,
  defaultDomain: 'personal' | 'org' | 'enterprise' | 'ephemeral' = 'personal'
): { sanitized: Record<string, string>; secretRefs: SecretRef[] } {
  if (!envOrHeaders) {
    return { sanitized: {}, secretRefs: [] };
  }

  const sanitized: Record<string, string> = {};
  const secretRefs: SecretRef[] = [];

  for (const [k, v] of Object.entries(envOrHeaders)) {
    if (isSensitiveKey(k) || (typeof v === 'string' && v.length > 24 && /^[a-zA-Z0-9_\-\.]+$/.test(v))) {
      const hash = createHash('sha256').update(`${serverId}:${k}:${v}`).digest('hex').slice(0, 12);
      const refId = `sec_ref_${hash}`;
      sanitized[k] = refId;
      secretRefs.push({
        refId,
        key: k,
        serverId,
        domain: defaultDomain,
        originalValue: v,
      });
    } else {
      sanitized[k] = v;
    }
  }

  return { sanitized, secretRefs };
}
