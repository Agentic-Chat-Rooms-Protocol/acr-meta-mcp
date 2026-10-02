import crypto from 'node:crypto';

/**
 * Canary token generator and leak detector.
 * Generates tamper-resistant tracking tokens to place inside system prompts
 * or confidential contexts, and checks incoming/outgoing payloads for leakage.
 */
export class CanaryManager {
  private readonly activeCanaries = new Set<string>();

  public generateCanary(prefix = 'ACR_CANARY'): string {
    const randomHex = crypto.randomBytes(16).toString('hex');
    const token = `${prefix}_${randomHex}`;
    this.activeCanaries.add(token);
    return token;
  }

  public registerCanary(token: string): void {
    if (token && typeof token === 'string') {
      this.activeCanaries.add(token);
    }
  }

  public revokeCanary(token: string): boolean {
    return this.activeCanaries.delete(token);
  }

  public detectLeakedCanaries(text: string): string[] {
    if (!text || this.activeCanaries.size === 0) {
      return [];
    }

    const leaked: string[] = [];
    for (const canary of this.activeCanaries) {
      if (text.includes(canary)) {
        leaked.push(canary);
      }
    }

    return leaked;
  }

  public get count(): number {
    return this.activeCanaries.size;
  }
}
