import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { resetClientState } from '../../src/imap/client.js';
import { registerAction, getActionTable, resetCustomActions, applyAction, resetKnownFolders } from '../../src/imap/operations.js';
import { lookupSender } from '../../src/rules/engine.js';
import { loadSenderRules, saveSenderRules, getValidActions } from '../../src/rules/config.js';
import type { SenderRules } from '../../src/rules/config.js';
import type { ImapFlow } from 'imapflow';
import { writeFileSync, readFileSync, unlinkSync, mkdtempSync } from 'node:fs';
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
  resetCustomActions();
  resetKnownFolders();
});

describe('Test Suite 7: classify_sender', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-test-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(tmpFile, JSON.stringify({
      'fossil@email.fossil.com': 'subscriptions',
      'ubereats@uber.com': 'delete',
    }));
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('7.1 — Add new sender classification', () => {
    const rules = loadSenderRules(tmpFile);
    expect(rules.exact.size).toBe(2);

    rules.exact.set('new@example.com', { action: 'news', rule_id: 'test0001' });
    saveSenderRules(rules);

    // Reload and verify persistence
    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('new@example.com')?.action).toBe('news');
    expect(reloaded.exact.size).toBe(3);
  });

  it('7.2 — Overwrite existing sender classification', () => {
    const rules = loadSenderRules(tmpFile);
    const previousAction = rules.exact.get('fossil@email.fossil.com')?.action;
    expect(previousAction).toBe('subscriptions');

    rules.exact.set('fossil@email.fossil.com', { action: 'news', rule_id: 'test0002' });
    saveSenderRules(rules);

    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('fossil@email.fossil.com')?.action).toBe('news');
  });

  it('7.3 — Case-insensitive sender classification', () => {
    const rules = loadSenderRules(tmpFile);
    rules.exact.set('NEW@EXAMPLE.COM'.toLowerCase(), { action: 'delete', rule_id: 'test0003' });
    saveSenderRules(rules);

    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('new@example.com')?.action).toBe('delete');
  });

  it('7.4 — Invalid action rejected', () => {
    const validActions = getValidActions();
    expect(validActions.has('bogus_action')).toBe(false);
  });

  it('7.5 — Classify then lookup succeeds', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['known@test.com', { action: 'subscriptions', rule_id: 'test0010' }],
      ]),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };
    rules.exact.set('new@test.com', { action: 'invoice', rule_id: 'test0011' });

    const result = lookupSender(rules, 'new@test.com');
    expect(result.matched).toBe(true);
    expect(result.action).toBe('invoice');
  });
});

describe('Test Suite 8: add_action', () => {
  it('8.1 — Register a new custom action', () => {
    const result = registerAction('archive', { moveToFolder: 'archived', markRead: true });
    expect(result.created).toBe(true);
    expect(result.existed).toBe(false);

    const table = getActionTable();
    expect(table['archive']).toBeDefined();
    expect(table['archive'].moveToFolder).toBe('archived');
    expect(table['archive'].markRead).toBe(true);
  });

  it('8.2 — Reject duplicate action name', () => {
    const result = registerAction('delete', { moveToFolder: 'trash' });
    expect(result.created).toBe(false);
    expect(result.existed).toBe(true);

    // Original should be unchanged
    const table = getActionTable();
    expect(table['delete'].moveToFolder).toBe('for-delete');
  });

  it('8.3 — Custom action appears in getActionTable', () => {
    registerAction('spam', { moveToFolder: 'spam-folder', flag: true });
    const table = getActionTable();
    expect(table['spam']).toBeDefined();
    expect(table['spam'].moveToFolder).toBe('spam-folder');
    expect(table['spam'].flag).toBe(true);
    expect(table['spam'].builtIn).toBe(false);
  });

  it('8.4 — Custom action can be used with applyAction', async () => {
    registerAction('archive', { moveToFolder: 'archived', markRead: true });
    const mockClient = createMockImapClient([
      createMockMessage({ uid: 200, from_address: 'test@test.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 200, 'archive');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_archived');
    expect(mockClient._movedMessages.get(200)).toBe('archived');
  });

  it('8.5 — Custom action with flag', async () => {
    registerAction('priority', { moveToFolder: 'priority-inbox', flag: true });
    const mockClient = createMockImapClient([
      createMockMessage({ uid: 201, from_address: 'boss@company.com' }),
    ]);

    const result = await applyAction(mockClient as unknown as ImapFlow, 201, 'priority');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('flagged');
    expect(result.operations_performed).toContain('moved_to_priority-inbox');
  });
});

describe('Test Suite 9: get_actions', () => {
  it('9.1 — Returns all built-in actions', () => {
    const table = getActionTable();
    const builtInNames = Object.keys(table).filter(k => table[k].builtIn);
    expect(builtInNames).toContain('important');
    expect(builtInNames).toContain('invoice');
    expect(builtInNames).toContain('subscriptions');
    expect(builtInNames).toContain('news');
    expect(builtInNames).toContain('delete');
    expect(builtInNames).toContain('doubleclick');
    expect(builtInNames).toContain('unknown');
    expect(builtInNames.length).toBe(7);
  });

  it('9.2 — Returns custom actions with built_in=false', () => {
    registerAction('archive', { moveToFolder: 'archived' });
    registerAction('spam', { moveToFolder: 'spam-folder' });

    const table = getActionTable();
    expect(table['archive'].builtIn).toBe(false);
    expect(table['spam'].builtIn).toBe(false);
    expect(Object.keys(table).length).toBe(9);
  });

  it('9.3 — Action metadata is correct', () => {
    const table = getActionTable();
    const important = table['important'];
    expect(important.flag).toBe(true);
    expect(important.moveToFolder).toBeUndefined();
    expect(important.builtIn).toBe(true);

    const invoice = table['invoice'];
    expect(invoice.markRead).toBe(true);
    expect(invoice.moveToFolder).toBe('invoices');
    expect(invoice.builtIn).toBe(true);
  });
});

describe('Test Suite 10: End-to-end flow', () => {
  it('10.1 — Add action, classify sender, then process email', async () => {
    // Step 1: Register custom action
    registerAction('archive', { moveToFolder: 'archived', markRead: true });

    // Step 2: Create rules and classify sender
    const rules: SenderRules = {
      exact: new Map(),
      regex: [],
      configPath: '/tmp/test-rules.json',
    };
    rules.exact.set('newsletter@blog.com', { action: 'archive', rule_id: 'test0020' });

    // Step 3: Lookup sender
    const lookup = lookupSender(rules, 'newsletter@blog.com');
    expect(lookup.matched).toBe(true);
    expect(lookup.action).toBe('archive');

    // Step 4: Apply the custom action
    const mockClient = createMockImapClient([
      createMockMessage({ uid: 300, from_address: 'newsletter@blog.com' }),
    ]);
    const result = await applyAction(mockClient as unknown as ImapFlow, 300, 'archive');
    expect(result.success).toBe(true);
    expect(result.operations_performed).toContain('marked_read');
    expect(result.operations_performed).toContain('moved_to_archived');
  });

  it('10.2 — Custom action with classify_sender validates action exists', () => {
    registerAction('social', { moveToFolder: 'social-media' });
    const validActions = getValidActions();
    expect(validActions.has('social')).toBe(true);
    expect(validActions.has('nonexistent')).toBe(false);
  });
});
