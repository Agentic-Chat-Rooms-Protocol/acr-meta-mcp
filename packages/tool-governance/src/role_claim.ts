/**
 * RFC-0019 / Deep Moat: 10-Bit Capability Bitmask & Verified External Role Claims
 *
 * Implements HMAC-SHA256 verified role claims with cryptographic expiration,
 * constant-time verification, and fail-closed fallback to least-privilege Role::Agent.
 *
 * Invariant: Zero emoji.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 10-bit Capability Bitmask flags
 */
export const Caps = {
  READ: 1 << 0,         // 0x0001
  POST: 1 << 1,         // 0x0002
  CREATE_BOARD: 1 << 2, // 0x0004
  EDIT_OWN: 1 << 3,     // 0x0008
  MODERATE: 1 << 4,     // 0x0010
  FEDERATE: 1 << 5,     // 0x0020
  PLUGINS: 1 << 6,      // 0x0040
  MARKETPLACE: 1 << 7,  // 0x0080
  SYSOP: 1 << 8,        // 0x0100
  MCP_EGRESS: 1 << 9,   // 0x0200
  ALL_CAPS: 0x03ff,     // 0x03FF
} as const;

export type Role = 'guest' | 'agent' | 'moderator' | 'federator' | 'sysop';

export const ROLE_CAPS: Record<Role, number> = {
  guest: Caps.READ,
  agent: Caps.READ | Caps.POST | Caps.EDIT_OWN | Caps.PLUGINS | Caps.MARKETPLACE | Caps.MCP_EGRESS, // 0x02CB
  moderator: Caps.READ | Caps.POST | Caps.EDIT_OWN | Caps.PLUGINS | Caps.MARKETPLACE | Caps.MCP_EGRESS | Caps.MODERATE | Caps.CREATE_BOARD, // 0x02DF
  federator: Caps.READ | Caps.POST | Caps.EDIT_OWN | Caps.PLUGINS | Caps.MARKETPLACE | Caps.MCP_EGRESS | Caps.MODERATE | Caps.CREATE_BOARD | Caps.FEDERATE, // 0x02FF
  sysop: Caps.ALL_CAPS, // 0x03FF
};

export interface RoleClaim {
  role: Role;
  exp: number; // Unix epoch seconds
  sig_hex: string;
}

export interface VerificationResult {
  valid: boolean;
  role: Role;
  caps: number;
  reason?: string;
}

/**
 * Generates an HMAC-SHA256 signature for a role and expiration timestamp.
 * Canonical payload: "{role}:{exp}"
 */
export function signRoleClaim(secret: string, role: Role, expSeconds: number): string {
  const payload = `${role}:${expSeconds}`;
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Validates an external role claim against a shared secret and expiration time.
 * Falls back to Role::Agent on any failure, expired token, or invalid signature.
 */
export function verifyRoleClaim(
  secret: string,
  claimedRole: string,
  expSeconds: number,
  sigHex: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): VerificationResult {
  // Canonical fallback
  const fallbackRole: Role = 'agent';
  const fallbackCaps = ROLE_CAPS[fallbackRole];

  // 1. Validate expiration freshness
  if (!expSeconds || expSeconds <= nowSeconds) {
    return {
      valid: false,
      role: fallbackRole,
      caps: fallbackCaps,
      reason: `Role claim expired (exp: ${expSeconds}, now: ${nowSeconds})`,
    };
  }

  // 2. Validate role is recognized
  const normalizedRole = claimedRole.toLowerCase() as Role;
  if (!ROLE_CAPS[normalizedRole]) {
    return {
      valid: false,
      role: fallbackRole,
      caps: fallbackCaps,
      reason: `Unknown role: ${claimedRole}`,
    };
  }

  // 3. Recompute canonical HMAC
  const expectedSig = signRoleClaim(secret, normalizedRole, expSeconds);

  // 4. Constant-time signature comparison
  try {
    const bufA = Buffer.from(sigHex, 'hex');
    const bufB = Buffer.from(expectedSig, 'hex');

    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      return {
        valid: false,
        role: fallbackRole,
        caps: fallbackCaps,
        reason: 'Invalid cryptographic signature',
      };
    }
  } catch {
    return {
      valid: false,
      role: fallbackRole,
      caps: fallbackCaps,
      reason: 'Malformed signature format',
    };
  }

  // 5. Successfully authenticated
  return {
    valid: true,
    role: normalizedRole,
    caps: ROLE_CAPS[normalizedRole],
  };
}

/**
 * External Role Claim Bridge for host integration.
 */
export class RoleClaimBridge {
  constructor(private readonly sharedSecret: string) {}

  public issueClaim(role: Role, ttlSeconds = 3600, nowSeconds = Math.floor(Date.now() / 1000)): RoleClaim {
    const exp = nowSeconds + ttlSeconds;
    const sig_hex = signRoleClaim(this.sharedSecret, role, exp);
    return { role, exp, sig_hex };
  }

  public verify(claim: { role: string; exp: number; sig_hex: string }, nowSeconds?: number): VerificationResult {
    return verifyRoleClaim(this.sharedSecret, claim.role, claim.exp, claim.sig_hex, nowSeconds);
  }

  public hasCapability(caps: number, capFlag: number): boolean {
    return (caps & capFlag) === capFlag;
  }
}
