import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { listFolderEmails } from '../../src/imap/operations.js';
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

function setupFolderClient(folderName: string, msgs: ReturnType<typeof createMockMessage>[]) {
  mockClient = createMockImapClient([]);
  mockClient._folders.set(folderName, [...msgs]);
  return mockClient;
}

describe('Test Suite: list_folder_emails', () => {
  it('returns emails from a valid non-inbox folder', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', subject: 'Folder email 1', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 2, from_address: 'b@test.com', subject: 'Folder email 2', date: new Date('2026-03-09T10:00:00Z') }),
    ];
    setupFolderClient('subscriptions', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'subscriptions');
    expect(result.length).toBe(2);
    expect(result[0].from_address).toBe('a@test.com');
    expect(result[1].from_address).toBe('b@test.com');
  });

  it('returns emails from INBOX (same basic result as list_inbox_emails)', async () => {
    const msgs = [
      createMockMessage({ uid: 10, from_address: 'inbox@test.com', subject: 'Inbox email', date: new Date('2026-03-10T12:00:00Z') }),
    ];
    mockClient = createMockImapClient(msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'INBOX');
    expect(result.length).toBe(1);
    expect(result[0].from_address).toBe('inbox@test.com');
    expect(result[0].folder).toBe('INBOX');
  });

  it('since_date filter works correctly', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', date: new Date('2026-03-01T10:00:00Z') }),
      createMockMessage({ uid: 2, from_address: 'b@test.com', date: new Date('2026-03-05T10:00:00Z') }),
      createMockMessage({ uid: 3, from_address: 'c@test.com', date: new Date('2026-03-10T10:00:00Z') }),
    ];
    setupFolderClient('invoices', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'invoices', {
      sinceDate: '2026-03-04',
    });
    expect(result.length).toBe(2);
    for (const email of result) {
      expect(new Date(email.date).getTime()).toBeGreaterThanOrEqual(new Date('2026-03-04').getTime());
    }
  });

  it('before_date filter works correctly', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', date: new Date('2026-03-01T10:00:00Z') }),
      createMockMessage({ uid: 2, from_address: 'b@test.com', date: new Date('2026-03-05T10:00:00Z') }),
      createMockMessage({ uid: 3, from_address: 'c@test.com', date: new Date('2026-03-10T10:00:00Z') }),
    ];
    setupFolderClient('invoices', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'invoices', {
      beforeDate: '2026-03-06',
    });
    expect(result.length).toBe(2);
    for (const email of result) {
      expect(new Date(email.date).getTime()).toBeLessThan(new Date('2026-03-06').getTime());
    }
  });

  it('sort: "date_asc" returns oldest first', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 2, from_address: 'b@test.com', date: new Date('2026-03-01T10:00:00Z') }),
      createMockMessage({ uid: 3, from_address: 'c@test.com', date: new Date('2026-03-05T10:00:00Z') }),
    ];
    setupFolderClient('news', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'news', {
      sort: 'date_asc',
    });
    expect(result.length).toBe(3);
    for (let i = 0; i < result.length - 1; i++) {
      expect(new Date(result[i].date).getTime()).toBeLessThanOrEqual(
        new Date(result[i + 1].date).getTime()
      );
    }
  });

  it('sort: "date_desc" returns newest first (default)', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', date: new Date('2026-03-01T10:00:00Z') }),
      createMockMessage({ uid: 2, from_address: 'b@test.com', date: new Date('2026-03-10T10:00:00Z') }),
      createMockMessage({ uid: 3, from_address: 'c@test.com', date: new Date('2026-03-05T10:00:00Z') }),
    ];
    setupFolderClient('news', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'news');
    expect(result.length).toBe(3);
    for (let i = 0; i < result.length - 1; i++) {
      expect(new Date(result[i].date).getTime()).toBeGreaterThanOrEqual(
        new Date(result[i + 1].date).getTime()
      );
    }
  });

  it('limit is respected', async () => {
    const msgs = [];
    for (let i = 0; i < 20; i++) {
      msgs.push(
        createMockMessage({
          uid: 200 + i,
          from_address: `sender${i}@test.com`,
          date: new Date(Date.now() - i * 3600000),
        })
      );
    }
    setupFolderClient('subscriptions', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'subscriptions', {
      limit: 5,
    });
    expect(result.length).toBe(5);
  });

  it('non-existent folder returns error "Folder not found" not a crash', async () => {
    mockClient = createMockImapClient([]);

    await expect(
      listFolderEmails(mockClient as unknown as ImapFlow, 'nonexistent-folder')
    ).rejects.toThrow('Folder not found');
  });

  it('empty folder returns [] without error', async () => {
    setupFolderClient('subscriptions', []);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'subscriptions');
    expect(result).toEqual([]);
  });

  it('include_flags: false results in empty flags arrays', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com', flags: ['\\Seen', '\\Flagged'] }),
    ];
    setupFolderClient('invoices', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'invoices', {
      includeFlags: false,
    });
    expect(result.length).toBe(1);
    expect(result[0].flags).toEqual([]);
  });

  it('each result includes the folder field', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'a@test.com' }),
      createMockMessage({ uid: 2, from_address: 'b@test.com' }),
    ];
    setupFolderClient('invoices', msgs);

    const result = await listFolderEmails(mockClient as unknown as ImapFlow, 'invoices');
    for (const email of result) {
      expect(email.folder).toBe('invoices');
    }
  });
});
