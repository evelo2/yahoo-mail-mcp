import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { ensureFolders } from '../../src/imap/operations.js';
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

describe('Test Suite 5: Folder Management', () => {
  it('5.1 — Ensure folders (none exist)', async () => {
    mockClient = createMockImapClient([]);

    const result = await ensureFolders(mockClient as unknown as ImapFlow);
    expect(result.created).toContain('invoices');
    expect(result.created).toContain('subscriptions');
    expect(result.created).toContain('news');
    expect(result.created).toContain('for-delete');
    expect(result.created).not.toContain('triaged');
    expect(result.already_existed.length).toBe(0);
  });

  it('5.2 — Ensure folders (all exist)', async () => {
    mockClient = createMockImapClient([]);
    mockClient._folders.set('invoices', []);
    mockClient._folders.set('subscriptions', []);
    mockClient._folders.set('news', []);
    mockClient._folders.set('for-delete', []);

    const result = await ensureFolders(mockClient as unknown as ImapFlow);
    expect(result.created.length).toBe(0);
    expect(result.already_existed).toContain('invoices');
    expect(result.already_existed).toContain('subscriptions');
    expect(result.already_existed).toContain('news');
    expect(result.already_existed).toContain('for-delete');
    expect(result.already_existed).not.toContain('triaged');
  });

  it('5.3 — Ensure folders (partial)', async () => {
    mockClient = createMockImapClient([]);
    mockClient._folders.set('subscriptions', []);
    mockClient._folders.set('news', []);

    const result = await ensureFolders(mockClient as unknown as ImapFlow);
    expect(result.created).toContain('invoices');
    expect(result.created).toContain('for-delete');
    expect(result.created).not.toContain('triaged');
    expect(result.already_existed).toContain('subscriptions');
    expect(result.already_existed).toContain('news');
  });
});
