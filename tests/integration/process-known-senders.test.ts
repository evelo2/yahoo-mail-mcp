import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, registerAction, resetKnownFolders } from '../../src/imap/operations.js';
import { handleProcessKnownSenders, initProcessKnownSenders } from '../../src/tools/process-known-senders.js';
import type { SenderRules } from '../../src/rules/config.js';

let mockClient: MockImapClient;

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
});

describe('Test Suite 11: process_known_senders', () => {
  const rules: SenderRules = {
    exact: new Map([
      ['fossil@email.fossil.com', { action: 'subscriptions', rule_id: 'test0001' }],
      ['ubereats@uber.com', { action: 'delete', rule_id: 'test0002' }],
      ['orders@starbucks.com', { action: 'invoice', rule_id: 'test0003' }],
      ['boss@news.hugoboss.com', { action: 'news', rule_id: 'test0004' }],
    ]),
    regex: [],
    configPath: '/tmp/test-rules.json',
  };

  beforeEach(() => {
    initProcessKnownSenders(rules);
  });

  it('11.1 — Processes known senders and skips unknown', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 100, from_address: 'fossil@email.fossil.com', subject: 'Spring Collection' }),
      createMockMessage({ uid: 101, from_address: 'ubereats@uber.com', subject: 'Your order' }),
      createMockMessage({ uid: 102, from_address: 'unknown@mystery.com', subject: 'Check this' }),
      createMockMessage({ uid: 103, from_address: 'orders@starbucks.com', subject: 'Receipt' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.total_fetched).toBe(4);
    expect(result.known_processed).toBe(3);
    expect(result.known_filtered_out).toBe(0);
    expect(result.unknown_skipped).toBe(1);
    expect(result.actions_filter).toBeNull();
    expect(result.errors).toBe(0);

    // actions_summary shows counts per action
    expect(result.actions_summary).toEqual({
      subscriptions: 1,
      delete: 1,
      invoice: 1,
    });

    // Check unknown senders
    expect(result.unknown_senders).toHaveLength(1);
    expect(result.unknown_senders[0].from_address).toBe('unknown@mystery.com');
    expect(result.unknown_senders[0].uid).toBe(102);

    // Verify emails were actually moved
    expect(mockClient._movedMessages.get(100)).toBe('subscriptions');
    expect(mockClient._movedMessages.get(101)).toBe('for-delete');
    expect(mockClient._movedMessages.get(103)).toBe('invoices');
  });

  it('11.2 — All unknown senders', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 200, from_address: 'who@nowhere.com', subject: 'Hello' }),
      createMockMessage({ uid: 201, from_address: 'stranger@other.com', subject: 'Hi' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.total_fetched).toBe(2);
    expect(result.known_processed).toBe(0);
    expect(result.unknown_skipped).toBe(2);
    expect(result.actions_summary).toEqual({});
    expect(result.unknown_senders).toHaveLength(2);
  });

  it('11.3 — All known senders', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 300, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 301, from_address: 'boss@news.hugoboss.com', subject: 'New' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.total_fetched).toBe(2);
    expect(result.known_processed).toBe(2);
    expect(result.unknown_skipped).toBe(0);
    expect(result.unknown_senders).toHaveLength(0);
    expect(result.actions_summary).toEqual({ subscriptions: 1, news: 1 });
  });

  it('11.4 — Empty inbox', async () => {
    mockClient = createMockImapClient([]);

    const result = await handleProcessKnownSenders({});

    expect(result.total_fetched).toBe(0);
    expect(result.known_processed).toBe(0);
    expect(result.unknown_skipped).toBe(0);
    expect(result.actions_summary).toEqual({});
    expect(result.unknown_senders).toHaveLength(0);
    expect(result.batches).toBe(0);
  });

  it('11.5 — Passes date filters through to listInboxEmails', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 400, from_address: 'fossil@email.fossil.com', subject: 'Old', date: new Date('2026-03-01T10:00:00Z') }),
      createMockMessage({ uid: 401, from_address: 'ubereats@uber.com', subject: 'Recent', date: new Date('2026-03-10T10:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ since_date: '2026-03-05' });

    expect(result.known_processed).toBe(result.total_fetched);
    expect(result.unknown_skipped).toBe(0);
    expect(result.errors).toBe(0);
    expect(mockClient.search).toHaveBeenCalled();
  });

  it('11.6 — Emails moved out of inbox after processing', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 500, from_address: 'fossil@email.fossil.com', subject: 'Move me' }),
    ]);

    await handleProcessKnownSenders({});

    expect(mockClient._movedMessages.get(500)).toBe('subscriptions');
    expect(mockClient._messages.find(m => m.uid === 500)).toBeUndefined();
  });

  it('11.7 — Works with custom actions', async () => {
    registerAction('watches', { moveToFolder: 'watches', markRead: true });
    const customRules: SenderRules = {
      exact: new Map([
        ['watch@example.com', { action: 'watches', rule_id: 'test0005' }],
      ]),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };
    initProcessKnownSenders(customRules);

    mockClient = createMockImapClient([
      createMockMessage({ uid: 600, from_address: 'watch@example.com', subject: 'New Watch' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(1);
    expect(result.actions_summary).toEqual({ watches: 1 });
    expect(mockClient._movedMessages.get(600)).toBe('watches');
  });

  it('11.8 — Unknown senders include subject and from_name', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 700, from_address: 'mystery@test.com', from_name: 'Mystery Person', subject: 'Important info' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.unknown_senders[0]).toEqual({
      uid: 700,
      from_address: 'mystery@test.com',
      from_name: 'Mystery Person',
      subject: 'Important info',
    });
  });

  it('11.9 — Filter: only process "delete" actions', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 800, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 801, from_address: 'ubereats@uber.com', subject: 'Order' }),
      createMockMessage({ uid: 802, from_address: 'orders@starbucks.com', subject: 'Receipt' }),
      createMockMessage({ uid: 803, from_address: 'unknown@test.com', subject: 'Who?' }),
    ]);

    const result = await handleProcessKnownSenders({ actions_filter: ['delete'] });

    expect(result.known_processed).toBe(1);
    expect(result.actions_summary).toEqual({ delete: 1 });
    expect(result.known_filtered_out).toBe(2);
    expect(result.unknown_skipped).toBe(1);
    expect(result.unknown_senders[0].uid).toBe(803);
    expect(result.actions_filter).toEqual(['delete']);

    // Only the delete email was moved
    expect(mockClient._movedMessages.has(801)).toBe(true);
    expect(mockClient._movedMessages.has(800)).toBe(false);
    expect(mockClient._movedMessages.has(802)).toBe(false);
  });

  it('11.10 — Filter: multiple action types', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 900, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 901, from_address: 'ubereats@uber.com', subject: 'Order' }),
      createMockMessage({ uid: 902, from_address: 'orders@starbucks.com', subject: 'Receipt' }),
      createMockMessage({ uid: 903, from_address: 'boss@news.hugoboss.com', subject: 'News' }),
    ]);

    const result = await handleProcessKnownSenders({ actions_filter: ['delete', 'invoice'] });

    expect(result.known_processed).toBe(2);
    expect(result.actions_summary).toEqual({ delete: 1, invoice: 1 });
    expect(result.known_filtered_out).toBe(2);
  });

  it('11.11 — Filter: case-insensitive', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1000, from_address: 'ubereats@uber.com', subject: 'Order' }),
      createMockMessage({ uid: 1001, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
    ]);

    const result = await handleProcessKnownSenders({ actions_filter: ['DELETE'] });

    expect(result.known_processed).toBe(1);
    expect(result.actions_summary).toEqual({ delete: 1 });
    expect(result.known_filtered_out).toBe(1);
  });

  it('11.12 — No filter: all known senders processed (backwards compatible)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1100, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 1101, from_address: 'ubereats@uber.com', subject: 'Order' }),
      createMockMessage({ uid: 1102, from_address: 'orders@starbucks.com', subject: 'Receipt' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(3);
    expect(result.known_filtered_out).toBe(0);
    expect(result.actions_filter).toBeNull();
  });

  it('11.13 — Filter with empty array: treats as no filter', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1200, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 1201, from_address: 'ubereats@uber.com', subject: 'Order' }),
    ]);

    const result = await handleProcessKnownSenders({ actions_filter: [] });

    expect(result.known_processed).toBe(2);
    expect(result.known_filtered_out).toBe(0);
    expect(result.actions_filter).toBeNull();
  });

  // ── Looping / batching tests ──

  it('11.14 — Loops to process all emails in inbox', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1300, from_address: 'fossil@email.fossil.com', subject: 'Known 1' }),
      createMockMessage({ uid: 1301, from_address: 'ubereats@uber.com', subject: 'Known 2' }),
      createMockMessage({ uid: 1302, from_address: 'unknown1@test.com', subject: 'Unknown A' }),
      createMockMessage({ uid: 1303, from_address: 'unknown2@test.com', subject: 'Unknown B' }),
      createMockMessage({ uid: 1304, from_address: 'orders@starbucks.com', subject: 'Known 3' }),
      createMockMessage({ uid: 1305, from_address: 'boss@news.hugoboss.com', subject: 'Known 4' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(4);
    expect(result.unknown_skipped).toBe(2);
    expect(result.unknown_senders).toHaveLength(2);
    expect(result.total_fetched).toBe(6);
    expect(result.batches).toBeGreaterThanOrEqual(1);
  });

  it('11.15 — Deduplicates unknown senders by email address', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1400, from_address: 'same@unknown.com', subject: 'First email' }),
      createMockMessage({ uid: 1401, from_address: 'same@unknown.com', subject: 'Second email' }),
      createMockMessage({ uid: 1402, from_address: 'other@unknown.com', subject: 'Different sender' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.unknown_skipped).toBe(2);
    expect(result.unknown_senders).toHaveLength(2);
    const addresses = result.unknown_senders.map(u => u.from_address);
    expect(addresses).toContain('same@unknown.com');
    expect(addresses).toContain('other@unknown.com');
  });

  it('11.16 — Stops looping when inbox is exhausted', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1500, from_address: 'a@unknown.com', subject: 'A' }),
      createMockMessage({ uid: 1501, from_address: 'fossil@email.fossil.com', subject: 'Known' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result.unknown_skipped).toBe(1);
    expect(result.known_processed).toBe(1);
  });

  it('11.17 — Response includes batches count', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1600, from_address: 'fossil@email.fossil.com', subject: 'Known' }),
    ]);

    const result = await handleProcessKnownSenders({});

    expect(result).toHaveProperty('batches');
    expect(typeof result.batches).toBe('number');
    expect(result.batches).toBeGreaterThanOrEqual(1);
  });

  it('11.18 — Batches is 0 for empty inbox', async () => {
    mockClient = createMockImapClient([]);

    const result = await handleProcessKnownSenders({});

    expect(result.batches).toBe(0);
    expect(result.total_fetched).toBe(0);
  });

  // --- Date filter tests (bug fix: combined since_date + before_date) ---

  it('11.19 — since_date only: returns emails on or after that date', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1800, from_address: 'fossil@email.fossil.com', subject: 'Old', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 1801, from_address: 'ubereats@uber.com', subject: 'Recent', date: new Date('2026-03-10T12:00:00Z') }),
      createMockMessage({ uid: 1802, from_address: 'orders@starbucks.com', subject: 'Latest', date: new Date('2026-03-15T12:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ since_date: '2026-03-08' });

    expect(result.total_fetched).toBe(2);
    expect(result.known_processed).toBe(2);
  });

  it('11.20 — before_date only: returns emails before that date', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1900, from_address: 'fossil@email.fossil.com', subject: 'Old', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 1901, from_address: 'ubereats@uber.com', subject: 'Recent', date: new Date('2026-03-10T12:00:00Z') }),
      createMockMessage({ uid: 1902, from_address: 'orders@starbucks.com', subject: 'Latest', date: new Date('2026-03-15T12:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ before_date: '2026-03-12' });

    expect(result.total_fetched).toBe(2);
    expect(result.known_processed).toBe(2);
  });

  it('11.21 — Both since_date and before_date: returns only emails within range', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 2000, from_address: 'fossil@email.fossil.com', subject: 'Before', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 2001, from_address: 'ubereats@uber.com', subject: 'In range', date: new Date('2026-03-10T12:00:00Z') }),
      createMockMessage({ uid: 2002, from_address: 'orders@starbucks.com', subject: 'In range too', date: new Date('2026-03-15T12:00:00Z') }),
      createMockMessage({ uid: 2003, from_address: 'boss@news.hugoboss.com', subject: 'After', date: new Date('2026-03-25T12:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ since_date: '2026-03-05', before_date: '2026-03-20' });

    expect(result.total_fetched).toBe(2);
    expect(result.known_processed).toBe(2);
  });

  it('11.22 — Date range with no matching emails returns 0 without error', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 2100, from_address: 'fossil@email.fossil.com', subject: 'Outside', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 2101, from_address: 'ubereats@uber.com', subject: 'Also outside', date: new Date('2026-03-25T12:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ since_date: '2026-03-10', before_date: '2026-03-15' });

    expect(result.total_fetched).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.batches).toBe(0);
  });

  it('11.23 — since_date == before_date returns 0 without error', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 2200, from_address: 'fossil@email.fossil.com', subject: 'On date', date: new Date('2026-03-10T12:00:00Z') }),
    ]);

    const result = await handleProcessKnownSenders({ since_date: '2026-03-10', before_date: '2026-03-10' });

    expect(result.total_fetched).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('11.24 — Date string with time component treated same as date-only', async () => {
    // Both formats should yield identical results: ISO date-only vs ISO with time component
    mockClient = createMockImapClient([
      createMockMessage({ uid: 2300, from_address: 'fossil@email.fossil.com', subject: 'Old', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 2301, from_address: 'ubereats@uber.com', subject: 'Recent', date: new Date('2026-03-10T12:00:00Z') }),
      createMockMessage({ uid: 2302, from_address: 'orders@starbucks.com', subject: 'Latest', date: new Date('2026-03-15T12:00:00Z') }),
    ]);

    const resultWithTime = await handleProcessKnownSenders({ since_date: '2026-03-08T00:00:00.000Z' });

    mockClient = createMockImapClient([
      createMockMessage({ uid: 2400, from_address: 'fossil@email.fossil.com', subject: 'Old', date: new Date('2026-03-01T12:00:00Z') }),
      createMockMessage({ uid: 2401, from_address: 'ubereats@uber.com', subject: 'Recent', date: new Date('2026-03-10T12:00:00Z') }),
      createMockMessage({ uid: 2402, from_address: 'orders@starbucks.com', subject: 'Latest', date: new Date('2026-03-15T12:00:00Z') }),
    ]);

    const resultDateOnly = await handleProcessKnownSenders({ since_date: '2026-03-08' });

    expect(resultWithTime.total_fetched).toBe(resultDateOnly.total_fetched);
    expect(resultWithTime.known_processed).toBe(resultDateOnly.known_processed);
  });

  // --- End date filter tests ---

  it('11.25 — Does not retain processed email objects (memory efficiency)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 1700, from_address: 'fossil@email.fossil.com', subject: 'Sale' }),
      createMockMessage({ uid: 1701, from_address: 'ubereats@uber.com', subject: 'Order' }),
      createMockMessage({ uid: 1702, from_address: 'orders@starbucks.com', subject: 'Receipt' }),
    ]);

    const result = await handleProcessKnownSenders({});

    // No processed array in response — only counts and summary
    expect(result).not.toHaveProperty('processed');
    expect(result.known_processed).toBe(3);
    expect(result.actions_summary).toEqual({ subscriptions: 1, delete: 1, invoice: 1 });
  });
});
