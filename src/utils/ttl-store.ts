import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './fs.js';
import { logger } from './logger.js';

export interface TtlRecord {
  uid: number;
  action: string;
  folder: string;
  arrived_at: string;    // ISO timestamp
  expires_at: string;    // ISO timestamp
}

interface TtlStoreData {
  ttl_records: TtlRecord[];
}

let storePath: string;
let records: TtlRecord[] = [];

export function initTtlStore(dataDir: string): void {
  storePath = join(dataDir, 'ttl_records.json');
  if (existsSync(storePath)) {
    try {
      const data: TtlStoreData = JSON.parse(readFileSync(storePath, 'utf-8'));
      records = data.ttl_records ?? [];
      logger.info({ count: records.length }, 'TTL store loaded');
    } catch (err) {
      logger.warn({ err }, 'Failed to load TTL store — starting fresh');
      records = [];
    }
  } else {
    records = [];
  }
}

function save(): void {
  if (!storePath) return;
  const data: TtlStoreData = { ttl_records: records };
  try {
    atomicWriteFileSync(storePath, JSON.stringify(data, null, 2) + '\n');
  } catch (err) {
    logger.error({ err }, 'Failed to save TTL store');
  }
}

/**
 * Add a TTL record for an email being held in inbox.
 */
export function addTtlRecord(record: TtlRecord): void {
  // Avoid duplicates by UID
  const existing = records.findIndex(r => r.uid === record.uid);
  if (existing !== -1) {
    records[existing] = record;
  } else {
    records.push(record);
  }
  save();
}

/**
 * Get all records whose TTL has expired (expires_at <= now).
 */
export function getExpiredRecords(now?: Date): TtlRecord[] {
  const cutoff = (now ?? new Date()).toISOString();
  return records.filter(r => r.expires_at <= cutoff);
}

/**
 * Get all active (non-expired) records.
 */
export function getActiveRecords(now?: Date): TtlRecord[] {
  const cutoff = (now ?? new Date()).toISOString();
  return records.filter(r => r.expires_at > cutoff);
}

/**
 * Get all records (for inspection).
 */
export function getAllRecords(): TtlRecord[] {
  return [...records];
}

/**
 * Remove a record by UID. Returns true if found and removed.
 */
export function removeTtlRecord(uid: number): boolean {
  const idx = records.findIndex(r => r.uid === uid);
  if (idx === -1) return false;
  records.splice(idx, 1);
  save();
  return true;
}

/**
 * Remove multiple records by UID. Returns count removed.
 */
export function removeTtlRecords(uids: number[]): number {
  const uidSet = new Set(uids);
  const before = records.length;
  records = records.filter(r => !uidSet.has(r.uid));
  const removed = before - records.length;
  if (removed > 0) save();
  return removed;
}

/**
 * Get count of active records.
 */
export function getTtlRecordCount(): number {
  return records.length;
}
