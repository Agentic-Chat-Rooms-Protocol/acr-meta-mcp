export interface AuditLogEntry {
  id: string;
  timestamp: string;
  eventType: 'CONFIG_IMPORT' | 'SERVER_TOGGLE' | 'SERVER_QUARANTINE' | 'TOOL_CALL' | 'POLICY_VIOLATION' | 'AUTH_ACCESS';
  actorDid: string;
  serverId?: string;
  toolName?: string;
  status: 'SUCCESS' | 'DENIED' | 'ERROR' | 'CONFIRMATION_REQUIRED';
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export class AuditLogger {
  private readonly logs: AuditLogEntry[] = [];
  private readonly maxLogs: number;

  constructor(maxLogs = 1000) {
    this.maxLogs = maxLogs;
  }

  public record(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): AuditLogEntry {
    const fullEntry: AuditLogEntry = {
      id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    this.logs.unshift(fullEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }

    return fullEntry;
  }

  public getRecent(limit = 50): AuditLogEntry[] {
    return this.logs.slice(0, limit);
  }

  public filter(predicate: (e: AuditLogEntry) => boolean): AuditLogEntry[] {
    return this.logs.filter(predicate);
  }
}
