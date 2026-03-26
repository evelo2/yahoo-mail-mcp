import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, resetKnownFolders, getActionTable, registerAction } from '../../src/imap/operations.js';
import { loadSenderRules, type SenderRules } from '../../src/rules/config.js';
import { lookupSender, clearRegexCache } from '../../src/rules/engine.js';
import { initTtlStore, addTtlRecord, getExpiredRecords, getActiveRecords, getAllRecords, removeTtlRecord, removeTtlRecords, type TtlRecord } from '../../src/utils/ttl-store.js';
import { handleProcessKnownSenders, initProcessKnownSenders } from '../../src/tools/process-known-senders.js';
import { handleProcessTtlExpirations } from '../../src/tools/process-ttl-expirations.js';
import type { ImapFlow } from 'imapflow';

let mockClient: MockImapClient;
let tmpDir: string;

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(() => mockClient),
  };
});

beforeEach(() => {
  resetClientState();
  resetCustomActions();
  resetKnownFolders();
  clearRegexCache();
  tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-ttl-'));
  initTtlStore(tmpDir);
  // Register custom actions used in tests
  registerAction('bank', { moveToFolder: 'Banking', markRead: true });
  registerAction('flights', { moveToFolder: 'Flights and Airlines', markRead: true });
  registerAction('health', { moveToFolder: 'Health', markRead: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// ── lookupSender with important fields ──

describe('lookupSender — important modifier', () => {
  it('Returns important and important_ttl_days when rule has important: true', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['bank@example.com', { action: 'bank', rule_id: 'ex01', important: true, important_ttl_days: 7 }],
      ]),
      regex: [],
      configPath: '/tmp/test.json',
    };

    const result = lookupSender(rules, 'bank@example.com');
    expect(result.important).toBe(true);
    expect(result.important_ttl_days).toBe(7);
  });

  it('Does not return important fields when rule has no important flag', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['normal@example.com', { action: 'subscriptions', rule_id: 'ex02' }],
      ]),
      regex: [],
      configPath: '/tmp/test.json',
    };

    const result = lookupSender(rules, 'normal@example.com');
    expect(result.important).toBeUndefined();
    expect(result.important_ttl_days).toBeUndefined();
  });

  it('Defaults important_ttl_days to 7 when not specified', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['bank@example.com', { action: 'bank', rule_id: 'ex01', important: true }],
      ]),
      regex: [],
      configPath: '/tmp/test.json',
    };

    const result = lookupSender(rules, 'bank@example.com');
    expect(result.important).toBe(true);
    expect(result.important_ttl_days).toBe(7);
  });

  it('Regex rule with important returns important fields', () => {
    const rules: SenderRules = {
      exact: new Map(),
      regex: [{ rule_id: 'rx01', pattern: '@.*bank\\.com$', action: 'bank', important: true, important_ttl_days: 14 }],
      configPath: '/tmp/test.json',
    };

    const result = lookupSender(rules, 'alerts@my.bank.com');
    expect(result.important).toBe(true);
    expect(result.important_ttl_days).toBe(14);
  });
});

// ── TTL Store ──

describe('TTL Store', () => {
  it('addTtlRecord stores a record', () => {
    addTtlRecord({
      uid: 100,
      action: 'bank',
      folder: 'Banking',
      arrived_at: '2026-03-20T12:00:00.000Z',
      expires_at: '2026-03-27T12:00:00.000Z',
    });

    expect(getAllRecords()).toHaveLength(1);
    expect(getAllRecords()[0].uid).toBe(100);
  });

  it('Deduplicates by UID (update on conflict)', () => {
    addTtlRecord({ uid: 100, action: 'bank', folder: 'Banking', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-27T12:00:00Z' });
    addTtlRecord({ uid: 100, action: 'flights', folder: 'Flights', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-04-03T12:00:00Z' });

    expect(getAllRecords()).toHaveLength(1);
    expect(getAllRecords()[0].action).toBe('flights');
  });

  it('getExpiredRecords returns only records past expiry', () => {
    const now = new Date('2026-03-25T12:00:00Z');
    addTtlRecord({ uid: 100, action: 'bank', folder: 'Banking', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-24T12:00:00Z' }); // expired
    addTtlRecord({ uid: 101, action: 'flights', folder: 'Flights', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-30T12:00:00Z' }); // active

    const expired = getExpiredRecords(now);
    expect(expired).toHaveLength(1);
    expect(expired[0].uid).toBe(100);

    const active = getActiveRecords(now);
    expect(active).toHaveLength(1);
    expect(active[0].uid).toBe(101);
  });

  it('removeTtlRecord removes by UID', () => {
    addTtlRecord({ uid: 100, action: 'bank', folder: 'Banking', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-27T12:00:00Z' });
    expect(removeTtlRecord(100)).toBe(true);
    expect(getAllRecords()).toHaveLength(0);
    expect(removeTtlRecord(100)).toBe(false); // already removed
  });

  it('removeTtlRecords removes multiple', () => {
    addTtlRecord({ uid: 100, action: 'bank', folder: 'Banking', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-27T12:00:00Z' });
    addTtlRecord({ uid: 101, action: 'flights', folder: 'Flights', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-03-30T12:00:00Z' });
    addTtlRecord({ uid: 102, action: 'health', folder: 'Health', arrived_at: '2026-03-20T12:00:00Z', expires_at: '2026-04-03T12:00:00Z' });

    const removed = removeTtlRecords([100, 102]);
    expect(removed).toBe(2);
    expect(getAllRecords()).toHaveLength(1);
    expect(getAllRecords()[0].uid).toBe(101);
  });
});

// ── process_known_senders with important ──

describe('process_known_senders — important hold', () => {
  it('Holds important emails in inbox (flagged) instead of routing', async () => {
    const rules: SenderRules = {
      exact: new Map([
        ['bank@example.com', { action: 'bank', rule_id: 'ex01', important: true, important_ttl_days: 7 }],
        ['newsletter@example.com', { action: 'subscriptions', rule_id: 'ex02' }],
      ]),
      regex: [],
      configPath: join(tmpDir, 'rules.json'),
    };
    writeFileSync(rules.configPath, '{}');
    initProcessKnownSenders(rules);

    mockClient = createMockImapClient([
      createMockMessage({ uid: 200, from_address: 'bank@example.com', subject: 'Statement', date: new Date('2026-03-20T12:00:00Z') }),
      createMockMessage({ uid: 201, from_address: 'newsletter@example.com', subject: 'Weekly digest' }),
    ]);

    const result = await handleProcessKnownSenders({});

    // Newsletter should be processed normally
    expect(result.known_processed).toBe(1);
    expect(result.actions_summary['subscriptions']).toBe(1);

    // Bank email should be held, not processed
    expect(result.important_held).toBe(1);
    expect(result.actions_summary['important_held']).toBe(1);

    // TTL record should exist
    const records = getAllRecords();
    expect(records).toHaveLength(1);
    expect(records[0].uid).toBe(200);
    expect(records[0].action).toBe('bank');
  });

  it('Non-important rules behave unchanged', async () => {
    const rules: SenderRules = {
      exact: new Map([
        ['shop@example.com', { action: 'subscriptions', rule_id: 'ex03' }],
      ]),
      regex: [],
      configPath: join(tmpDir, 'rules.json'),
    };
    writeFileSync(rules.configPath, '{}');
    initProcessKnownSenders(rules);

    mockClient = createMockImapClient([
      createMockMessage({ uid: 300, from_address: 'shop@example.com', subject: 'Sale' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(1);
    expect(result.important_held).toBe(0);
    expect(getAllRecords()).toHaveLength(0);
  });
});

// ── process_ttl_expirations ──

describe('process_ttl_expirations', () => {
  it('Moves expired emails to their action folders', async () => {
    // Add an expired TTL record
    addTtlRecord({
      uid: 500,
      action: 'bank',
      folder: 'Banking',
      arrived_at: '2026-03-10T12:00:00Z',
      expires_at: '2026-03-17T12:00:00Z', // expired (before now)
    });

    mockClient = createMockImapClient([
      createMockMessage({ uid: 500, from_address: 'bank@example.com', subject: 'Old statement' }),
    ]);

    const result = await handleProcessTtlExpirations();

    expect(result.checked).toBe(1);
    expect(result.moved).toBe(1);
    expect(result.orphaned).toBe(0);

    // Record should be removed from store
    expect(getAllRecords()).toHaveLength(0);
  });

  it('Does not move emails whose TTL has not expired', async () => {
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    addTtlRecord({
      uid: 600,
      action: 'bank',
      folder: 'Banking',
      arrived_at: new Date().toISOString(),
      expires_at: futureDate,
    });

    mockClient = createMockImapClient([
      createMockMessage({ uid: 600, from_address: 'bank@example.com', subject: 'Recent' }),
    ]);

    const result = await handleProcessTtlExpirations();

    expect(result.checked).toBe(0);
    expect(result.moved).toBe(0);
    // Record still exists
    expect(getAllRecords()).toHaveLength(1);
  });

  it('Handles orphaned records (email manually moved)', async () => {
    addTtlRecord({
      uid: 700,
      action: 'bank',
      folder: 'Banking',
      arrived_at: '2026-03-10T12:00:00Z',
      expires_at: '2026-03-17T12:00:00Z', // expired
    });

    // Empty inbox — email was manually moved elsewhere
    mockClient = createMockImapClient([]);

    const result = await handleProcessTtlExpirations();

    expect(result.checked).toBe(1);
    expect(result.moved).toBe(0);
    expect(result.orphaned).toBe(1);

    // Record should be pruned
    expect(getAllRecords()).toHaveLength(0);
  });

  it('Returns zeros when no TTL records exist', async () => {
    mockClient = createMockImapClient([]);
    const result = await handleProcessTtlExpirations();

    expect(result.checked).toBe(0);
    expect(result.moved).toBe(0);
    expect(result.orphaned).toBe(0);
  });
});

// ── list_rules with important fields ──

describe('list_rules — important fields', () => {
  it('Shows important and important_ttl_days in rule results', async () => {
    const { handleListRules, initListRules } = await import('../../src/tools/list-rules.js');
    const rules: SenderRules = {
      exact: new Map([
        ['bank@example.com', { action: 'bank', rule_id: 'ex01', important: true, important_ttl_days: 7 }],
        ['shop@example.com', { action: 'subscriptions', rule_id: 'ex02' }],
      ]),
      regex: [],
      configPath: '/tmp/test.json',
    };
    initListRules(rules);

    const result = await handleListRules({});

    const bankRule = result.results.find((r: any) => r.email_address === 'bank@example.com');
    expect(bankRule!.important).toBe(true);
    expect(bankRule!.important_ttl_days).toBe(7);

    const shopRule = result.results.find((r: any) => r.email_address === 'shop@example.com');
    expect(shopRule!.important).toBeUndefined();
  });
});
