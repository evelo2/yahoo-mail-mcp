import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage, createInboxMessages } from '../fixtures/emails.js';
import { listInboxEmails } from '../../src/imap/operations.js';
import { resetClientState } from '../../src/imap/client.js';
import type { ImapFlow } from 'imapflow';

let mockClient: MockImapClient;

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  resetClientState();
});

describe('Test Suite 3: Inbox Listing', () => {
  it('3.1 — List all emails in INBOX (default limit)', async () => {
    const msgs = createInboxMessages(15);
    mockClient = createMockImapClient(msgs);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow);
    // Default limit is 10, so should return 10 of 15
    expect(result.length).toBe(10);
  });

  it('3.2 — List with limit', async () => {
    const msgs = createInboxMessages(15);
    mockClient = createMockImapClient(msgs);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow, { limit: 3 });
    expect(result.length).toBe(3);
    // Should be newest first
    for (let i = 0; i < result.length - 1; i++) {
      expect(new Date(result[i].date).getTime()).toBeGreaterThanOrEqual(
        new Date(result[i + 1].date).getTime()
      );
    }
  });

  it('3.3 — List with date filter', async () => {
    const msgs = [];
    for (let day = 1; day <= 10; day++) {
      msgs.push(
        createMockMessage({
          uid: 300 + day,
          from_address: `sender${day}@test.com`,
          date: new Date(`2026-03-${String(day).padStart(2, '0')}T12:00:00Z`),
        })
      );
    }
    mockClient = createMockImapClient(msgs);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow, {
      sinceDate: '2026-03-08',
    });
    expect(result.length).toBe(3); // March 8, 9, 10
    for (const email of result) {
      expect(new Date(email.date).getDate()).toBeGreaterThanOrEqual(8);
    }
  });

  it('3.4 — List with date range', async () => {
    const msgs = [];
    for (let day = 1; day <= 10; day++) {
      msgs.push(
        createMockMessage({
          uid: 400 + day,
          from_address: `sender${day}@test.com`,
          date: new Date(`2026-03-${String(day).padStart(2, '0')}T12:00:00Z`),
        })
      );
    }
    mockClient = createMockImapClient(msgs);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow, {
      sinceDate: '2026-03-03',
      beforeDate: '2026-03-06',
    });
    expect(result.length).toBe(3); // March 3, 4, 5
  });

  it('3.5 — Empty inbox', async () => {
    mockClient = createMockImapClient([]);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow);
    expect(result).toEqual([]);
  });

  it('3.6 — Response shape validation', async () => {
    mockClient = createMockImapClient([
      createMockMessage({
        uid: 500,
        from_address: 'fossil@email.fossil.com',
        from_name: 'Fossil',
        subject: 'Spring Collection Now Live',
        date: new Date('2026-03-10T14:22:00Z'),
      }),
    ]);

    const result = await listInboxEmails(mockClient as unknown as ImapFlow);
    expect(result.length).toBe(1);

    const email = result[0];
    expect(typeof email.uid).toBe('number');
    expect(typeof email.from_address).toBe('string');
    expect(typeof email.from_name).toBe('string');
    expect(typeof email.subject).toBe('string');
    expect(typeof email.date).toBe('string');
    expect(Array.isArray(email.flags)).toBe(true);
    expect(Array.isArray(email.labels)).toBe(true);
    expect((email as any).body_plain).toBeUndefined();
    expect((email as any).body).toBeUndefined();
  });
});
