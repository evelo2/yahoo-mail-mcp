import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { applyAction, resetKnownFolders } from '../../src/imap/operations.js';
import { lookupSender } from '../../src/rules/engine.js';
import { loadSenderRules } from '../../src/rules/config.js';
import { resetClientState } from '../../src/imap/client.js';
import type { SenderRules } from '../../src/rules/config.js';
import type { ImapFlow } from 'imapflow';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
  };
});

beforeEach(() => {
  resetClientState();
  resetKnownFolders();
});

describe('Test Suite 6: Edge Cases and Error Handling', () => {
  it('6.1 — IMAP connection failure', async () => {
    const mockClient = createMockImapClient([]);
    mockClient.getMailboxLock.mockRejectedValue(new Error('IMAP connection failed: Connection refused'));

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 100, 'delete')
    ).rejects.toThrow('IMAP connection failed');
  });

  it('6.2 — Authentication failure', async () => {
    const { AuthenticationError } = await import('../../src/utils/errors.js');
    const err = new AuthenticationError();
    expect(err.message).toBe('Authentication failed. Verify Yahoo App Password.');
    expect(err.name).toBe('AuthenticationError');
  });

  it('6.3 — UID becomes stale (email deleted externally)', async () => {
    const mockClient = createMockImapClient([]);

    await expect(
      applyAction(mockClient as unknown as ImapFlow, 400, 'delete')
    ).rejects.toThrow('Email UID 400 not found');
  });

  it('6.4 — Very long from_address', () => {
    const rules: SenderRules = {
      exact: new Map([['test@test.com', { action: 'delete', rule_id: 'test0001' }]]),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };
    const longEmail = 'a@' + 'x'.repeat(500) + '.com';
    const result = lookupSender(rules, longEmail);
    expect(result.matched).toBe(false);
    expect(result.action).toBe('unknown');
  });

  it('6.5 — Config file missing', () => {
    expect(() => {
      loadSenderRules('/nonexistent/path/rules.json');
    }).toThrow('Rules config not found at: /nonexistent/path/rules.json');
  });

  it('6.6 — Config file malformed JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-test-'));
    const tmpFile = join(tmpDir, 'bad-rules.json');
    writeFileSync(tmpFile, '{ invalid json }}}');

    expect(() => {
      loadSenderRules(tmpFile);
    }).toThrow('Failed to parse rules config:');

    unlinkSync(tmpFile);
  });
});
