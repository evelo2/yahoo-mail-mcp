import { appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs.js';
import { logger } from './logger.js';

const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
const DEFAULT_RETENTION_DAYS = 10;

let logPath: string;
let retentionDays: number;

export interface AuditEntry {
  timestamp: string;
  uids: number[];
  action: string;
  source_folder: string;
  count: number;
  batch_id?: string;
}

/**
 * Initialize the audit log. Call once at startup.
 */
export function initAuditLog(dataDir: string): void {
  logPath = join(dataDir, 'audit.jsonl');
  retentionDays = parseInt(process.env.AUDIT_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  logger.info({ logPath, retentionDays }, 'Audit log initialized');
}

/**
 * Append an entry to the audit log. Triggers cleanup if file exceeds 1 MB.
 */
export function logAction(entry: Omit<AuditEntry, 'timestamp'>): void {
  if (!logPath) return; // not initialized

  const record: AuditEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  try {
    appendFileSync(logPath, JSON.stringify(record) + '\n', 'utf-8');
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log entry');
    return;
  }

  // Check file size and trim if over cap
  try {
    const stat = statSync(logPath);
    if (stat.size > MAX_FILE_SIZE) {
      trimAuditLog();
    }
  } catch {}
}

/**
 * Remove entries older than retention period. Rewrites the file atomically.
 */
function trimAuditLog(): void {
  if (!existsSync(logPath)) return;

  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

    const kept = lines.filter(line => {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        return entry.timestamp >= cutoff;
      } catch {
        return false; // drop malformed lines
      }
    });

    atomicWriteFileSync(logPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
    logger.info({ removed: lines.length - kept.length, kept: kept.length, retentionDays }, 'Audit log trimmed');
  } catch (err) {
    logger.error({ err }, 'Failed to trim audit log');
  }
}

/**
 * Read audit log entries, optionally filtered by date range.
 */
export function readAuditLog(options?: {
  since?: string;
  before?: string;
  action?: string;
  limit?: number;
}): AuditEntry[] {
  if (!logPath || !existsSync(logPath)) return [];

  try {
    const raw = readFileSync(logPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    let entries: AuditEntry[] = [];

    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }

    // Apply filters
    if (options?.since) {
      entries = entries.filter(e => e.timestamp >= options.since!);
    }
    if (options?.before) {
      entries = entries.filter(e => e.timestamp < options.before!);
    }
    if (options?.action) {
      entries = entries.filter(e => e.action === options.action);
    }

    // Newest first
    entries.reverse();

    if (options?.limit) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  } catch {
    return [];
  }
}
