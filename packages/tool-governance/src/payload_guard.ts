import crypto from 'node:crypto';
import { AuditLedger } from './audit_ledger.js';
import { CanaryManager } from './canary.js';
import { detectHighEntropyTokens } from './entropy.js';
import {
  EgressSanitization,
  PayloadGuardConfig,
  PostGuardScan,
  Redaction,
  RedactionMode,
  ThreatLevel,
} from './types.js';

interface Detector {
  name: string;
  pattern: RegExp;
  validate?: (value: string) => boolean;
  keepTail?: number;
  gate?: string[];
}

function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/\D/g, '').split('').map(Number);
  if (nums.length < 13) return false;
  let total = 0;
  const parity = nums.length % 2;
  for (let i = 0; i < nums.length; i++) {
    let d = nums[i];
    if (i % 2 === parity) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    total += d;
  }
  return total % 10 === 0;
}

function nhsCheck(value: string): boolean {
  const nums = value.replace(/\D/g, '').split('').map(Number);
  if (nums.length !== 10) return false;
  let total = 0;
  for (let i = 0; i < 9; i++) {
    total += nums[i] * (10 - i);
  }
  let check = 11 - (total % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === nums[9];
}

const DETECTORS: Detector[] = [
  {
    name: 'CARD',
    pattern: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: luhnCheck,
    keepTail: 4,
  },
  {
    name: 'SSN',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    gate: ['-'],
  },
  {
    name: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
  },
  {
    name: 'EMAIL',
    pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b/g,
    gate: ['@'],
  },
  {
    name: 'AWS_KEY',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    gate: ['AKIA', 'ASIA'],
  },
  {
    name: 'API_KEY',
    pattern: /\b(?:sk|pk|rk)[-_](?:live|test|proj)?[-_]?[A-Za-z0-9]{16,}\b/g,
  },
  {
    name: 'BEARER',
    pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    gate: ['ey'],
  },
  {
    name: 'MRN',
    pattern: /\b(?:MRN|mrn)[:\s#]*([A-Z0-9]{6,12})\b/g,
    gate: ['MRN', 'mrn'],
  },
  {
    name: 'NHS',
    pattern: /\b\d{3}[ -]?\d{3}[ -]?\d{4}\b/g,
    validate: nhsCheck,
  },
  {
    name: 'PHONE',
    pattern: /(?<![\d.])(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)|\d{2,4})[ -]\d{2,4}[ -]?\d{2,4}(?![\d.])|(?<![\d.])\d{3}-\d{3}-\d{4}(?![\d.])/g,
    keepTail: 4,
  },
  {
    name: 'IPV4',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    gate: ['.'],
  },
  {
    name: 'DOB',
    pattern: /\b(?:19|20)\d{2}[-/](?:0[1-9]|1[0-2])[-/](?:0[1-9]|[12]\d|3[01])\b/g,
    gate: ['19', '20'],
  },
];

const MALICIOUS_PROMPT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i, reason: 'Instruction override pattern' },
  { pattern: /ignore\s+(the\s+above|your\s+instructions|your\s+guidelines)/i, reason: 'Instruction override pattern' },
  { pattern: /disregard\s+(previous|all\s+previous|the\s+above|all\s+prior)/i, reason: 'Disregard instructions pattern' },
  { pattern: /system\s*prompt\s*reveal/i, reason: 'System prompt exfiltration' },
  { pattern: /(reveal|print|show)\s+(your\s+)?system\s+prompt/i, reason: 'System prompt exfiltration' },
  { pattern: /your\s+system\s+prompt\s+is/i, reason: 'System prompt override' },
  { pattern: /output\s+your\s+instructions/i, reason: 'Instruction exfiltration' },
  { pattern: /override\s+your\s+instructions/i, reason: 'Instruction override' },
  { pattern: /you\s+are\s+now\b/i, reason: 'Persona hijack pattern' },
  { pattern: /do\s+anything\s+now/i, reason: 'DAN jailbreak heuristic' },
  { pattern: /developer\s+mode\s+enabled/i, reason: 'Developer mode jailbreak' },
  { pattern: /drop\s+table/i, reason: 'SQL injection heuristic' },
];

const SENSITIVE_KEY_NAMES = [
  'email',
  'ip',
  'host',
  'token',
  'secret',
  'key',
  'phone',
  'password',
  'authorization',
];

/**
 * Enterprise PayloadGuard: Heuristic Prompt Injection Firewall,
 * Recursive PII Scrubber, Shannon Entropy Analyzer, and Canary Detector.
 */
export class PayloadGuard {
  public readonly mode: RedactionMode;
  public readonly secret: Buffer;
  public readonly blockOn: Set<string>;
  public readonly failClosed: boolean;
  public readonly entropyThreshold: number;
  public readonly canaries: CanaryManager;
  public readonly audit: AuditLedger;

  private readonly gateRegex = /[\d@]/;
  private readonly zeroWidthRegex = /[\u200B-\u200D\uFEFF]/;

  constructor(config: PayloadGuardConfig = {}) {
    this.mode = config.redactionMode || 'mask';
    this.secret = Buffer.from(
      config.secret || process.env.ACR_PAYLOAD_GUARD_SECRET || crypto.randomBytes(32).toString('hex')
    );
    this.blockOn = new Set(config.blockOn || []);
    this.failClosed = config.failClosed ?? true;
    this.entropyThreshold = config.entropyThreshold ?? 4.8;
    this.canaries = new CanaryManager();
    if (config.activeCanaries) {
      for (const c of config.activeCanaries) {
        this.canaries.registerCanary(c);
      }
    }
    this.audit = new AuditLedger(config.auditLogPath);
  }

  private generateToken(entity: string, value: string, keepTail = 0): string {
    if (this.mode === 'mask') {
      return `<${entity}>`;
    }
    if (this.mode === 'hash') {
      const hmac = crypto.createHmac('sha256', this.secret).update(value).digest('hex').substring(0, 8);
      return `<${entity}:${hmac}>`;
    }
    if (this.mode === 'partial' && keepTail > 0) {
      const alphanumeric = value.replace(/[^a-zA-Z0-9]/g, '');
      const tail = alphanumeric.slice(-keepTail);
      return `<${entity}:****${tail}>`;
    }
    return `<${entity}>`;
  }

  public redactText(text: string): { text: string; redactions: Redaction[] } {
    if (!text || typeof text !== 'string') {
      return { text: '', redactions: [] };
    }

    if (!this.gateRegex.test(text)) {
      return { text, redactions: [] };
    }

    interface MatchSpan {
      start: number;
      end: number;
      det: Detector;
      value: string;
    }

    const spans: MatchSpan[] = [];

    for (const det of DETECTORS) {
      if (det.gate && !det.gate.some((g) => text.includes(g))) {
        continue;
      }

      det.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = det.pattern.exec(text)) !== null) {
        const val = m[0];
        if (det.validate && !det.validate(val)) {
          continue;
        }
        spans.push({
          start: m.index,
          end: m.index + val.length,
          det,
          value: val,
        });
      }
    }

    if (spans.length === 0) {
      return { text, redactions: [] };
    }

    // Earliest start wins, longer match tiebreaks
    spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

    const parts: string[] = [];
    const redactions: Redaction[] = [];
    let cursor = 0;

    for (const span of spans) {
      if (span.start < cursor) {
        continue; // overlapping match
      }

      const token = this.generateToken(span.det.name, span.value, span.det.keepTail || 0);
      parts.push(text.slice(cursor, span.start));
      parts.push(token);
      redactions.push({
        entity: span.det.name,
        start: span.start,
        end: span.end,
        token,
      });
      cursor = span.end;
    }

    parts.push(text.slice(cursor));
    return {
      text: parts.join(''),
      redactions,
    };
  }

  public scan(payload: any): PostGuardScan {
    const reasons: string[] = [];
    const textBlob = this.extractTextBlob(payload);

    // 1. Canary leak detection
    const leakedCanaries = this.canaries.detectLeakedCanaries(textBlob);
    if (leakedCanaries.length > 0) {
      reasons.push(`Canary token exfiltration detected (${leakedCanaries.length} token leaked)`);
    }

    // 2. Malicious prompt patterns
    for (const rule of MALICIOUS_PROMPT_PATTERNS) {
      if (rule.pattern.test(textBlob)) {
        reasons.push(rule.reason);
      }
    }

    // 3. Block-on entities check
    if (this.blockOn.size > 0) {
      const { redactions } = this.redactText(textBlob);
      for (const r of redactions) {
        if (this.blockOn.has(r.entity)) {
          reasons.push(`Forbidden entity "${r.entity}" detected in payload`);
        }
      }
    }

    // 4. Steganography detection (zero-width characters)
    if (this.zeroWidthRegex.test(textBlob)) {
      reasons.push('Zero-width unicode steganography characters detected');
    }

    // If any malicious condition is triggered, return MALICIOUS immediately
    if (reasons.length > 0) {
      this.audit.append('guard.scan_malicious', { reasons, sampleLength: textBlob.length });
      return {
        level: 'malicious',
        reasons,
      };
    }

    // 5. Suspicious heuristics
    const lc = textBlob.toLowerCase();
    const urlMatches = (lc.match(/https?:\/\//g) || []).length;
    if (urlMatches > 5) {
      reasons.push('URL flood detected (>5 links)');
    }

    // 6. Long opaque token check
    const tokens = textBlob.split(/\s+/);
    for (const t of tokens) {
      if (t.length > 400) {
        reasons.push('Long opaque token (>400 chars)');
        break;
      }
    }

    // 7. Shannon entropy analysis
    const entropyResult = detectHighEntropyTokens(textBlob, 32, this.entropyThreshold);
    if (entropyResult.found) {
      reasons.push(`High Shannon entropy token detected (> ${this.entropyThreshold})`);
    }

    if (reasons.length > 0) {
      this.audit.append('guard.scan_suspicious', { reasons });
      return {
        level: 'suspicious',
        reasons,
      };
    }

    return {
      level: 'clean',
      reasons: [],
    };
  }

  public sanitize(payload: any): EgressSanitization {
    let redactedKeysCount = 0;
    const allRedactions: Redaction[] = [];

    const sanitizeRecursive = (val: any): any => {
      if (val === null || val === undefined) {
        return val;
      }

      if (typeof val === 'string') {
        // Try parsing nested JSON string (common in tool call arguments)
        if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
          try {
            const parsed = JSON.parse(val);
            const sanitizedNested = sanitizeRecursive(parsed);
            return JSON.stringify(sanitizedNested);
          } catch {
            // not valid JSON, treat as standard string
          }
        }

        const { text, redactions } = this.redactText(val);
        if (redactions.length > 0) {
          allRedactions.push(...redactions);
          redactedKeysCount += redactions.length;
        }
        return text;
      }

      if (Array.isArray(val)) {
        return val.map((item) => sanitizeRecursive(item));
      }

      if (typeof val === 'object') {
        const out: Record<string, any> = {};
        for (const [k, v] of Object.entries(val)) {
          const lk = k.toLowerCase();
          const isSensitive = SENSITIVE_KEY_NAMES.some((s) => lk.includes(s));
          if (isSensitive) {
            out[k] = '[redacted]';
            redactedKeysCount++;
          } else {
            out[k] = sanitizeRecursive(v);
          }
        }
        return out;
      }

      return val;
    };

    const sanitizedPayload = sanitizeRecursive(payload);
    this.audit.append('guard.sanitized', {
      redactedCount: redactedKeysCount,
      entitiesFound: allRedactions.map((r) => r.entity),
    });

    return {
      redacted_keys_count: redactedKeysCount,
      sanitized_payload: sanitizedPayload,
      redactions: allRedactions,
    };
  }

  public guardToolCall(
    toolName: string,
    args: Record<string, any>
  ): { allowed: boolean; scan: PostGuardScan; sanitizedArgs: Record<string, any> } {
    const scan = this.scan({ toolName, args });
    if (scan.level === 'malicious') {
      this.audit.append('guard.tool_blocked', {
        toolName,
        reasons: scan.reasons,
      });
      return {
        allowed: false,
        scan,
        sanitizedArgs: args,
      };
    }

    const { sanitized_payload } = this.sanitize(args);
    return {
      allowed: true,
      scan,
      sanitizedArgs: sanitized_payload,
    };
  }

  private extractTextBlob(val: any): string {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    if (Array.isArray(val)) {
      return val.map((item) => this.extractTextBlob(item)).join(' ');
    }
    if (typeof val === 'object') {
      return Object.values(val)
        .map((v) => this.extractTextBlob(v))
        .join(' ');
    }
    return '';
  }
}
