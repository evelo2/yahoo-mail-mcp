import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { resetClientState } from '../../src/imap/client.js';
import { registerAction, resetCustomActions } from '../../src/imap/operations.js';
import { handleProcessEmail, initProcessEmail } from '../../src/tools/process-email.js';
import { handleProcessKnownSenders, initProcessKnownSenders } from '../../src/tools/process-known-senders.js';
import type { SenderRules } from '../../src/rules/config.js';

let mockClient: MockImapClient;

// Mock the IMAP client module so tool handlers use our mock
vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(),
  };
});

let getConnectionMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  resetClientState();
  resetCustomActions();
  registerAction('watches', { moveToFolder: 'watches', markRead: true });

  const clientMod = await import('../../src/imap/client.js');
  getConnectionMock = clientMod.getConnection as unknown as ReturnType<typeof vi.fn>;
});

describe('process_email: unknown senders must NOT be moved', () => {
  const rules: SenderRules = {
    exact: new Map([
      ['known@example.com', { action: 'subscriptions', rule_id: 'test0001' }],
      ['fossil@email.fossil.com', { action: 'watches', rule_id: 'test0002' }],
    ]),
    regex: [],
    configPath: '/tmp/test-rules.json',
  };

  beforeEach(() => {
    initProcessEmail(rules);
  });

  it('unknown sender — no IMAP operations, stays in inbox', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 500, from_address: 'stranger@unknown.com', subject: 'Hello!' }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    const result = await handleProcessEmail({ uid: 500, from_address: 'stranger@unknown.com' });

    expect(result.matched).toBe(false);
    expect(result.action).toBe('unknown');
    expect(result.operations_performed).toEqual([]);
    // CRITICAL: email must NOT have been moved
    expect(mockClient._movedMessages.has(500)).toBe(false);
    expect(mockClient._messages.length).toBe(1);
  });

  it('known sender — moved out of inbox', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 501, from_address: 'known@example.com', subject: 'Newsletter' }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    const result = await handleProcessEmail({ uid: 501, from_address: 'known@example.com' });

    expect(result.matched).toBe(true);
    expect(result.action).toBe('subscriptions');
    expect(result.operations_performed.length).toBeGreaterThan(0);
    expect(mockClient._movedMessages.has(501)).toBe(true);
  });

  it('three unknown senders — none moved, all stay in inbox', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 600, from_address: 'a@unknown.com', subject: 'Email A' }),
      createMockMessage({ uid: 601, from_address: 'b@unknown.com', subject: 'Email B' }),
      createMockMessage({ uid: 602, from_address: 'c@unknown.com', subject: 'Email C' }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    for (const msg of [
      { uid: 600, from_address: 'a@unknown.com' },
      { uid: 601, from_address: 'b@unknown.com' },
      { uid: 602, from_address: 'c@unknown.com' },
    ]) {
      const result = await handleProcessEmail(msg);
      expect(result.matched).toBe(false);
      expect(result.operations_performed).toEqual([]);
    }

    // CRITICAL: none moved
    expect(mockClient._movedMessages.size).toBe(0);
    expect(mockClient._messages.length).toBe(3);
  });
});

describe('process_known_senders: unknown senders must NOT be moved', () => {
  const rules: SenderRules = {
    exact: new Map([
      ['known@example.com', { action: 'subscriptions', rule_id: 'test0003' }],
      ['fossil@email.fossil.com', { action: 'watches', rule_id: 'test0004' }],
    ]),
    regex: [],
    configPath: '/tmp/test-rules.json',
  };

  beforeEach(() => {
    initProcessKnownSenders(rules);
  });

  it('mixed batch — known moved, unknown stays, unknown_senders populated', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 700, from_address: 'known@example.com', subject: 'Newsletter', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 701, from_address: 'stranger@unknown.com', subject: 'Who am I?', date: new Date('2026-03-10T09:00:00Z') }),
      createMockMessage({ uid: 702, from_address: 'fossil@email.fossil.com', subject: 'New watch', date: new Date('2026-03-10T08:00:00Z') }),
      createMockMessage({ uid: 703, from_address: 'another@mystery.com', subject: 'Mystery', date: new Date('2026-03-10T07:00:00Z') }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    const result = await handleProcessKnownSenders({});

    // Known senders processed
    expect(result.known_processed).toBe(2);
    expect(mockClient._movedMessages.has(700)).toBe(true);
    expect(mockClient._movedMessages.has(702)).toBe(true);

    // Unknown senders NOT moved
    expect(result.unknown_skipped).toBe(2);
    expect(mockClient._movedMessages.has(701)).toBe(false);
    expect(mockClient._movedMessages.has(703)).toBe(false);

    // Unknown senders returned with details for classification
    expect(result.unknown_senders).toHaveLength(2);
    expect(result.unknown_senders[0]).toMatchObject({
      uid: 701,
      from_address: 'stranger@unknown.com',
      subject: 'Who am I?',
    });
    expect(result.unknown_senders[1]).toMatchObject({
      uid: 703,
      from_address: 'another@mystery.com',
      subject: 'Mystery',
    });
  });

  it('all unknown — none moved, all returned for classification', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 800, from_address: 'x@new.com', subject: 'Sub X', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 801, from_address: 'y@new.com', subject: 'Sub Y', date: new Date('2026-03-10T09:00:00Z') }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(0);
    expect(result.unknown_skipped).toBe(2);
    expect(mockClient._movedMessages.size).toBe(0);
    expect(mockClient._messages.length).toBe(2);
    expect(result.unknown_senders).toHaveLength(2);
  });

  it('all known — none left in inbox', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 900, from_address: 'known@example.com', subject: 'Known 1', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 901, from_address: 'fossil@email.fossil.com', subject: 'Known 2', date: new Date('2026-03-10T09:00:00Z') }),
    ]);
    getConnectionMock.mockResolvedValue(mockClient);

    const result = await handleProcessKnownSenders({});

    expect(result.known_processed).toBe(2);
    expect(result.unknown_skipped).toBe(0);
    expect(result.unknown_senders).toHaveLength(0);
    expect(mockClient._messages.length).toBe(0);
  });
});
