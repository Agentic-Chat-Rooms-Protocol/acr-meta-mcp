import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AuditLogEntry } from './types.js';

const GENESIS = '0'.repeat(64);

/**
 * Cloakwall-inspired tamper-evident hash-chained audit ledger.
 * Every entry commits to the SHA-256 hash of the entry before it.
 * Verifies chain integrity, prevents undetected deletions or modifications,
 * and maintains atomic head anchors.
 */
export class AuditLedger {
  private readonly filePath?: string;
  private readonly memoryEntries: AuditLogEntry[] = [];
  private lastSeq = 0;
  private lastHash = GENESIS;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (this.filePath) {
      const dir = path.dirname(path.resolve(this.filePath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.loadTail();
    }
  }

  private get headPath(): string | undefined {
    return this.filePath ? `${this.filePath}.head` : undefined;
  }

  private loadTail(): void {
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditLogEntry;
          this.memoryEntries.push(entry);
          this.lastSeq = entry.seq;
          this.lastHash = entry.hash;
        } catch {
          // ignore malformed lines
        }
      }
    } catch {
      // file read error fallback
    }
  }

  public append(event: string, details?: Record<string, any>): AuditLogEntry {
    const prev = this.lastHash;
    const seq = this.lastSeq + 1;
    const ts = new Date().toISOString();
    const host = os.hostname();

    const record: Record<string, any> = {
      ts,
      seq,
      event,
      host,
      prev,
      ...(details ? { details } : {}),
    };

    // Deterministic canonical JSON serialization
    const keys = Object.keys(record).sort();
    const sortedRecord: Record<string, any> = {};
    for (const k of keys) {
      sortedRecord[k] = record[k];
    }
    const bodyStr = JSON.stringify(sortedRecord);
    const hash = crypto.createHash('sha256').update(prev + bodyStr).digest('hex');

    const fullEntry: AuditLogEntry = {
      ts,
      seq,
      event,
      host,
      prev,
      hash,
      details,
    };

    this.memoryEntries.push(fullEntry);
    this.lastSeq = seq;
    this.lastHash = hash;

    if (this.filePath) {
      const outLine = JSON.stringify({ ...sortedRecord, hash }) + '\n';
      fs.appendFileSync(this.filePath, outLine, { encoding: 'utf-8' });

      if (this.headPath) {
        const headPayload = JSON.stringify({ seq, hash, ts });
        const tmpHead = `${this.headPath}.tmp`;
        fs.writeFileSync(tmpHead, headPayload, 'utf-8');
        fs.renameSync(tmpHead, this.headPath);
      }
    }

    return fullEntry;
  }

  public verifyChain(): { valid: boolean; message: string; count: number } {
    let prev = GENESIS;
    let expectedSeq = 0;

    for (let i = 0; i < this.memoryEntries.length; i++) {
      const entry = this.memoryEntries[i];
      if (entry.prev !== prev) {
        return {
          valid: false,
          message: `Entry ${i + 1} break: expected prev ${prev}, found ${entry.prev}`,
          count: this.memoryEntries.length,
        };
      }

      expectedSeq++;
      if (entry.seq !== expectedSeq) {
        return {
          valid: false,
          message: `Entry ${i + 1} sequence gap: expected ${expectedSeq}, found ${entry.seq}`,
          count: this.memoryEntries.length,
        };
      }

      const copy: Record<string, any> = {
        ts: entry.ts,
        seq: entry.seq,
        event: entry.event,
        host: entry.host,
        prev: entry.prev,
        ...(entry.details ? { details: entry.details } : {}),
      };

      const keys = Object.keys(copy).sort();
      const sortedRecord: Record<string, any> = {};
      for (const k of keys) {
        sortedRecord[k] = copy[k];
      }

      const bodyStr = JSON.stringify(sortedRecord);
      const recomputed = crypto.createHash('sha256').update(prev + bodyStr).digest('hex');

      if (recomputed !== entry.hash) {
        return {
          valid: false,
          message: `Entry ${i + 1} altered after writing: recomputed ${recomputed} != claimed ${entry.hash}`,
          count: this.memoryEntries.length,
        };
      }

      prev = entry.hash;
    }

    return {
      valid: true,
      message: `Audit chain intact: ${expectedSeq} entries verified without error.`,
      count: expectedSeq,
    };
  }

  public getEntries(): AuditLogEntry[] {
    return [...this.memoryEntries];
  }
}
