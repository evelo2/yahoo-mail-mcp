import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { applyAction, listInboxEmails, registerAction, resetCustomActions, resetKnownFolders } from '../../src/imap/operations.js';
import { lookupSender } from '../../src/rules/engine.js';
import { loadSenderRules, type SenderRules } from '../../src/rules/config.js';
import { resetClientState } from '../../src/imap/client.js';
import { resolve } from 'node:path';
import type { ImapFlow } from 'imapflow';

let rules: SenderRules;
let mockClient: MockImapClient;

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
  };
});

beforeAll(() => {
  rules = loadSenderRules(resolve(import.meta.dirname, '../../config/sender-rules.json'));
});

beforeEach(() => {
  resetClientState();
  resetCustomActions();
  resetKnownFolders();
  // Register custom actions used in the config
  registerAction('watches', { moveToFolder: 'watches', markRead: true });
  registerAction('bank', { moveToFolder: 'bank', markRead: true });
  registerAction('amazon', { moveToFolder: 'amazon', markRead: true });
  registerAction('hd', { moveToFolder: 'hd', markRead: true });
  registerAction('health', { moveToFolder: 'health', markRead: true });
  registerAction('shipping', { moveToFolder: 'shipping', markRead: true });
});

describe('Test Suite 4: End-to-End Processing', () => {
  it('4.1 — Process known sender (watches)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 200, from_address: 'fossil@email.fossil.com' }),
    ]);

    const lookup = lookupSender(rules, 'fossil@email.fossil.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('watches');

    const result = await applyAction(mockClient as unknown as ImapFlow, 200, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_watches');
    expect(mockClient._movedMessages.get(200)).toBe('watches');
  });

  it('4.2 — Process known sender (subscriptions)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 201, from_address: 'hello@pelacase.com' }),
    ]);

    const lookup = lookupSender(rules, 'hello@pelacase.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('subscriptions');

    const result = await applyAction(mockClient as unknown as ImapFlow, 201, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_subscriptions');
  });

  it('4.3 — Process known sender (invoice)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 202, from_address: 'orders@starbucks.com' }),
    ]);

    const lookup = lookupSender(rules, 'orders@starbucks.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('invoice');

    const result = await applyAction(mockClient as unknown as ImapFlow, 202, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_invoices');
  });

  it('4.4 — Process known sender (important — test config)', async () => {
    const testRules: SenderRules = {
      exact: new Map([['vip@testdomain.com', { action: 'important', rule_id: 'test0001' }]]),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };

    mockClient = createMockImapClient([
      createMockMessage({ uid: 203, from_address: 'vip@testdomain.com' }),
    ]);

    const lookup = lookupSender(testRules, 'vip@testdomain.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('important');

    const result = await applyAction(mockClient as unknown as ImapFlow, 203, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('flagged');
    expect(result.operations_performed).not.toContain('moved_to_triaged');
    expect(mockClient._movedMessages.has(203)).toBe(false);
  });

  it('4.5 — Process unknown sender → no-op (stays in INBOX)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 204, from_address: 'promo@newbrand.xyz' }),
    ]);

    const lookup = lookupSender(rules, 'promo@newbrand.xyz');
    expect(lookup.matched).toBe(false);
    expect(lookup.action).toBe('unknown');

    const result = await applyAction(mockClient as unknown as ImapFlow, 204, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toHaveLength(0);
    expect(mockClient._movedMessages.has(204)).toBe(false);
  });

  it('4.6 — Process known sender (doubleclick) → no-op (stays in INBOX)', async () => {
    const doubleclickRules: SenderRules = {
      exact: new Map([['marketing@edm.xtool.com', { action: 'doubleclick', rule_id: 'test0010' }]]),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };
    mockClient = createMockImapClient([
      createMockMessage({ uid: 205, from_address: 'marketing@edm.xtool.com' }),
    ]);

    const lookup = lookupSender(doubleclickRules, 'marketing@edm.xtool.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('doubleclick');

    const result = await applyAction(mockClient as unknown as ImapFlow, 205, lookup.action);
    expect(result.success).toBe(true);
    expect(result.operations_performed).toHaveLength(0);
    expect(mockClient._movedMessages.has(205)).toBe(false);
  });

  it('4.7 — Batch processing: known senders leave INBOX, unknown stays', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 300, from_address: 'fossil@email.fossil.com', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 301, from_address: 'ubereats@uber.com', date: new Date('2026-03-10T09:00:00Z') }),
      createMockMessage({ uid: 302, from_address: 'orders@starbucks.com', date: new Date('2026-03-10T08:00:00Z') }),
      createMockMessage({ uid: 303, from_address: 'unknown@mystery.com', date: new Date('2026-03-10T07:00:00Z') }),
      createMockMessage({ uid: 304, from_address: 'boss@news.hugoboss.com', date: new Date('2026-03-10T06:00:00Z') }),
    ]);

    const emails = await listInboxEmails(mockClient as unknown as ImapFlow, { limit: 50 });
    expect(emails.length).toBe(5);

    for (const email of emails) {
      const lookup = lookupSender(rules, email.from_address);
      if (lookup.matched) {
        await applyAction(mockClient as unknown as ImapFlow, email.uid, lookup.action);
      }
    }

    // Known senders moved out of INBOX
    expect(mockClient._movedMessages.get(300)).toBe('watches');
    expect(mockClient._movedMessages.get(301)).toBe('for-delete');
    expect(mockClient._movedMessages.get(302)).toBe('invoices');
    expect(mockClient._movedMessages.get(304)).toBe('subscriptions');

    // Unknown sender stays in INBOX — not moved
    expect(mockClient._movedMessages.has(303)).toBe(false);

    // INBOX should have 1 remaining (the unknown)
    expect(mockClient._messages.length).toBe(1);
    expect(mockClient._messages[0].uid).toBe(303);
  });

  it('4.8 — unknown action leaves email in INBOX', async () => {
    // unknown is now a no-op: no move, no flags.
    mockClient = createMockImapClient([
      createMockMessage({ uid: 400, from_address: 'test@test.com' }),
    ]);

    // Process the email with unknown action
    await applyAction(mockClient as unknown as ImapFlow, 400, 'unknown');
    expect(mockClient._movedMessages.has(400)).toBe(false);

    // INBOX should still contain the email
    const emails = await listInboxEmails(mockClient as unknown as ImapFlow);
    expect(emails.length).toBe(1);
    expect(emails[0].uid).toBe(400);
  });
});
