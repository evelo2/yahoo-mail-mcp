import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { applyAction, applyActionsBatch, resetKnownFolders } from '../../src/imap/operations.js';
import { handleApplyAction } from '../../src/tools/apply-action.js';
import { resetClientState } from '../../src/imap/client.js';
import type { ImapFlow } from 'imapflow';

let mockClient: MockImapClient;

// Suppress delay in tests
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
  resetKnownFolders();
});

describe('Test Suite 2: Action Application', () => {
  it('2.1 — Action: important → flagged, stays in INBOX', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 100, from_address: 'vip@test.com', flags: ['\\Seen'] }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 100, 'important');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('flagged');
    expect(result.operations_performed).not.toContain('moved_to_triaged');

    // Email should NOT have been moved
    expect(mockClient._movedMessages.has(100)).toBe(false);
  });

  it('2.2 — Action: invoice → marked read + moved to invoices', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 101, from_address: 'orders@starbucks.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 101, 'invoice');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_invoices');
    expect(mockClient._movedMessages.get(101)).toBe('invoices');
  });

  it('2.3 — Action: invoice (folder does not exist) → folder created', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 102, from_address: 'orders@starbucks.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 102, 'invoice');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_invoices');
    expect(mockClient.mailboxCreate).toHaveBeenCalledWith('invoices');
  });

  it('2.4 — Action: subscriptions → marked read + moved', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 103, from_address: 'fossil@email.fossil.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 103, 'subscriptions');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_subscriptions');
  });

  it('2.5 — Action: news → marked read + moved', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 104, from_address: 'boss@news.hugoboss.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 104, 'news');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_news');
  });

  it('2.6 — Action: delete → marked read + moved to for-delete', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 105, from_address: 'ubereats@uber.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 105, 'delete');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_for-delete');
  });

  it('2.7 — Action: doubleclick → no-op (stays in INBOX)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 106, from_address: 'marketing@edm.xtool.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 106, 'doubleclick');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toHaveLength(0);
    expect(mockClient._movedMessages.has(106)).toBe(false);
  });

  it('2.8 — Action: unknown → no-op (stays in INBOX)', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 107, from_address: 'unknown@mystery.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 107, 'unknown');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toHaveLength(0);
    expect(mockClient._movedMessages.has(107)).toBe(false);
  });

  it('2.9 — Invalid action', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 108, from_address: 'test@test.com' }),
    ]);

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 108, 'archive')
    ).rejects.toThrow(/Invalid action: archive\. Valid actions:/);

  });

  it('2.10 — Email not found', async () => {
    mockClient = createMockImapClient([]);

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 999, 'delete')
    ).rejects.toThrow('Email UID 999 not found');
  });

  // ── source_folder tests ──

  it('2.11 — source_folder: INBOX default unchanged', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 300, from_address: 'test@example.com', subject: 'Inbox email' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 300, 'delete');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_for-delete');
  });

  it('2.12 — source_folder: email in non-INBOX folder, correct source_folder', async () => {
    mockClient = createMockImapClient([]);
    // Put a message in the "Telus" folder
    mockClient._folders.set('Telus', [
      createMockMessage({ uid: 400, from_address: 'alerts@telus.com', subject: 'Alert' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 400, 'delete', 'Telus');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('moved_to_for-delete');
  });

  it('2.13 — source_folder: email in non-INBOX folder, wrong source_folder', async () => {
    mockClient = createMockImapClient([]);
    mockClient._folders.set('Telus', [
      createMockMessage({ uid: 400, from_address: 'alerts@telus.com', subject: 'Alert' }),
    ]);

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 400, 'delete', 'INBOX')
    ).rejects.toThrow('Email UID 400 not found');
  });

  it('2.14 — source_folder: non-existent folder returns clear error', async () => {
    mockClient = createMockImapClient([]);

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 100, 'delete', 'NonExistentFolder')
    ).rejects.toThrow('Folder not found: "NonExistentFolder"');
  });

  it('2.15 — source_folder: move between two non-INBOX folders', async () => {
    mockClient = createMockImapClient([]);
    mockClient._folders.set('Banking', [
      createMockMessage({ uid: 500, from_address: 'bank@rbc.com', subject: 'Statement' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 500, 'subscriptions', 'Banking');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('moved_to_subscriptions');
  });

  // ── Batch UID tests (via handleApplyAction) ──

  it('2.16 — batch: array of UIDs processed in single call', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 600, from_address: 'a@test.com' }),
      createMockMessage({ uid: 601, from_address: 'b@test.com' }),
      createMockMessage({ uid: 602, from_address: 'c@test.com' }),
    ]);

    const result = await handleApplyAction({ uid: [600, 601, 602], action: 'delete' });
    expect(result.success_count).toBe(3);
    expect(result.error_count).toBe(0);
    expect((result as any).results).toHaveLength(3);
    for (const r of (result as any).results) {
      expect(r.success).toBe(true);
      expect(r.operations_performed).toContain('marked_read');
      expect(r.operations_performed).toContain('moved_to_for-delete');
    }
  });

  it('2.17 — batch: single UID still returns original response shape', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 700, from_address: 'a@test.com' }),
    ]);

    const result = await handleApplyAction({ uid: 700, action: 'delete' });
    // Single UID response has uid, action, operations_performed, success — no results array
    expect(result.uid).toBe(700);
    expect(result.action).toBe('delete');
    expect((result as any).operations_performed).toBeDefined();
    expect((result as any).success).toBe(true);
    expect((result as any).results).toBeUndefined();
  });

  it('2.18 — batch: with source_folder', async () => {
    mockClient = createMockImapClient([]);
    mockClient._folders.set('Telus', [
      createMockMessage({ uid: 800, from_address: 'a@telus.com' }),
      createMockMessage({ uid: 801, from_address: 'b@telus.com' }),
    ]);

    const result = await handleApplyAction({ uid: [800, 801], action: 'delete', source_folder: 'Telus' });
    expect(result.success_count).toBe(2);
    expect(result.error_count).toBe(0);
    expect((result as any).source_folder).toBe('Telus');
  });

  it('2.19 — batch: invalid action rejected', async () => {
    mockClient = createMockImapClient([
      createMockMessage({ uid: 900, from_address: 'a@test.com' }),
    ]);

    await expect(
      handleApplyAction({ uid: [900], action: 'nonexistent' })
    ).rejects.toThrow(/Invalid action/);
  });
});
