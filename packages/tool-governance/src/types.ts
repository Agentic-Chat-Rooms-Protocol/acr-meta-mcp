export type ThreatLevel = 'clean' | 'suspicious' | 'malicious';

export interface PostGuardScan {
  level: ThreatLevel;
  reasons: string[];
}

export type RedactionMode = 'mask' | 'hash' | 'partial';

export interface Redaction {
  entity: string;
  start: number;
  end: number;
  token: string;
}

export interface EgressSanitization {
  redacted_keys_count: number;
  sanitized_payload: any;
  redactions: Redaction[];
}

export interface PayloadGuardConfig {
  redactionMode?: RedactionMode;
  secret?: string;
  blockOn?: string[];
  failClosed?: boolean;
  entropyThreshold?: number;
  activeCanaries?: Set<string>;
  auditLogPath?: string;
}

export interface AuditLogEntry {
  ts: string;
  seq: number;
  event: string;
  host: string;
  prev: string;
  hash: string;
  details?: Record<string, any>;
}
