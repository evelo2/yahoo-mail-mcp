import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFileSync, rotateBackups } from '../../src/utils/fs.js';
import { initAuditLog, logAction, readAuditLog } from '../../src/utils/audit-log.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-data-'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// ── Atomic writes ──

describe('atomicWriteFileSync', () => {
  it('writes file content correctly', () => {
    const file = join(tmpDir, 'test.json');
    atomicWriteFileSync(file, '{"hello": "world"}\n');
    expect(readFileSync(file, 'utf-8')).toBe('{"hello": "world"}\n');
  });

  it('overwrites existing file atomically', () => {
    const file = join(tmpDir, 'test.json');
    writeFileSync(file, 'original', 'utf-8');
    atomicWriteFileSync(file, 'updated');
    expect(readFileSync(file, 'utf-8')).toBe('updated');
  });

  it('does not leave temp files on success', () => {
    const file = join(tmpDir, 'test.json');
    atomicWriteFileSync(file, 'data');
    const files = require('node:fs').readdirSync(tmpDir);
    expect(files).toEqual(['test.json']);
  });
});

// ── Backup rotation ──

describe('rotateBackups', () => {
  it('creates .bak.1 from current file', () => {
    const file = join(tmpDir, 'rules.json');
    writeFileSync(file, 'version1', 'utf-8');
    rotateBackups(file, 5);
    expect(readFileSync(join(tmpDir, 'rules.json.bak.1'), 'utf-8')).toBe('version1');
  });

  it('shifts existing backups up', () => {
    const file = join(tmpDir, 'rules.json');
    writeFileSync(file, 'v1', 'utf-8');
    rotateBackups(file, 5);
    writeFileSync(file, 'v2', 'utf-8');
    rotateBackups(file, 5);
    writeFileSync(file, 'v3', 'utf-8');
    rotateBackups(file, 5);

    expect(readFileSync(join(tmpDir, 'rules.json.bak.1'), 'utf-8')).toBe('v3');
    expect(readFileSync(join(tmpDir, 'rules.json.bak.2'), 'utf-8')).toBe('v2');
    expect(readFileSync(join(tmpDir, 'rules.json.bak.3'), 'utf-8')).toBe('v1');
  });

  it('deletes oldest when exceeding keep count', () => {
    const file = join(tmpDir, 'rules.json');
    for (let i = 1; i <= 7; i++) {
      writeFileSync(file, `v${i}`, 'utf-8');
      rotateBackups(file, 3);
    }

    expect(existsSync(join(tmpDir, 'rules.json.bak.1'))).toBe(true);
    expect(existsSync(join(tmpDir, 'rules.json.bak.2'))).toBe(true);
    expect(existsSync(join(tmpDir, 'rules.json.bak.3'))).toBe(true);
    expect(existsSync(join(tmpDir, 'rules.json.bak.4'))).toBe(false);

    // Most recent backup should be v7
    expect(readFileSync(join(tmpDir, 'rules.json.bak.1'), 'utf-8')).toBe('v7');
  });

  it('does nothing if file does not exist', () => {
    const file = join(tmpDir, 'nonexistent.json');
    rotateBackups(file, 5); // should not throw
    expect(existsSync(join(tmpDir, 'nonexistent.json.bak.1'))).toBe(false);
  });
});

// ── Audit log ──

describe('Audit log', () => {
  beforeEach(() => {
    initAuditLog(tmpDir);
  });

  it('logs an action entry as JSONL', () => {
    logAction({ uids: [100, 101], action: 'delete', source_folder: 'INBOX', count: 2 });

    const logFile = join(tmpDir, 'audit.jsonl');
    expect(existsSync(logFile)).toBe(true);

    const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.uids).toEqual([100, 101]);
    expect(entry.action).toBe('delete');
    expect(entry.source_folder).toBe('INBOX');
    expect(entry.count).toBe(2);
    expect(entry.timestamp).toEqual(expect.any(String));
  });

  it('appends multiple entries', () => {
    logAction({ uids: [100], action: 'delete', source_folder: 'INBOX', count: 1 });
    logAction({ uids: [200], action: 'subscriptions', source_folder: 'INBOX', count: 1 });
    logAction({ uids: [300], action: 'invoice', source_folder: 'Telus', count: 1, batch_id: 'abc123' });

    const logFile = join(tmpDir, 'audit.jsonl');
    const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(3);
  });

  it('readAuditLog returns entries newest first', () => {
    logAction({ uids: [100], action: 'delete', source_folder: 'INBOX', count: 1 });
    logAction({ uids: [200], action: 'subscriptions', source_folder: 'INBOX', count: 1 });

    const entries = readAuditLog();
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe('subscriptions'); // newest first
    expect(entries[1].action).toBe('delete');
  });

  it('readAuditLog filters by action', () => {
    logAction({ uids: [100], action: 'delete', source_folder: 'INBOX', count: 1 });
    logAction({ uids: [200], action: 'subscriptions', source_folder: 'INBOX', count: 1 });

    const entries = readAuditLog({ action: 'delete' });
    expect(entries).toHaveLength(1);
    expect(entries[0].action).toBe('delete');
  });

  it('readAuditLog respects limit', () => {
    for (let i = 0; i < 10; i++) {
      logAction({ uids: [i], action: 'delete', source_folder: 'INBOX', count: 1 });
    }

    const entries = readAuditLog({ limit: 3 });
    expect(entries).toHaveLength(3);
  });

  it('readAuditLog returns empty array when no log exists', () => {
    // Use a fresh dir with no log file
    const freshDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-audit-empty-'));
    initAuditLog(freshDir);
    const entries = readAuditLog();
    expect(entries).toEqual([]);
    try { rmSync(freshDir, { recursive: true }); } catch {}
  });

  it('includes batch_id when provided', () => {
    logAction({ uids: [100, 101, 102], action: 'delete', source_folder: 'Telus', count: 3, batch_id: 'b1c2d3e4' });

    const entries = readAuditLog();
    expect(entries[0].batch_id).toBe('b1c2d3e4');
  });
});
