import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetClientState } from '../../src/imap/client.js';
import { registerAction, getActionTable, resetCustomActions } from '../../src/imap/operations.js';
import { loadSenderRules, getValidActions } from '../../src/rules/config.js';
import type { SenderRules } from '../../src/rules/config.js';
import { handleClassifySenders, initClassifySenders } from '../../src/tools/classify-senders.js';
import { handleGetActions } from '../../src/tools/get-actions.js';
import { handleAddAction } from '../../src/tools/add-action.js';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({
      list: vi.fn().mockResolvedValue([]),
      mailboxCreate: vi.fn().mockResolvedValue(undefined),
    }),
  };
});

beforeEach(() => {
  resetClientState();
  resetCustomActions();
});

// ── Test Suite 12: classify_senders (bulk) ──

describe('Test Suite 12: classify_senders (bulk)', () => {
  let tmpDir: string;
  let tmpFile: string;
  let rules: SenderRules;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-test-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(tmpFile, JSON.stringify({
      'existing@test.com': 'subscriptions',
    }));
    rules = loadSenderRules(tmpFile);
    process.env.RULES_CONFIG_PATH = tmpFile;
    initClassifySenders(rules);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
    delete process.env.RULES_CONFIG_PATH;
  });

  it('12.1 — Single classification saves correctly', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'new@test.com', action: 'delete' },
      ],
    });

    expect(result.saved).toBe(1);
    expect(result.failed).toEqual([]);
    expect(result.total_rules).toBe(2); // 1 existing + 1 new

    // Verify persistence
    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('new@test.com')?.action).toBe('delete');
  });

  it('12.2 — Multiple classifications all save, total_rules reflects correct count', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'a@test.com', action: 'news' },
        { email_address: 'b@test.com', action: 'delete' },
        { email_address: 'c@test.com', action: 'invoice' },
      ],
    });

    expect(result.saved).toBe(3);
    expect(result.failed).toEqual([]);
    expect(result.total_rules).toBe(4); // 1 existing + 3 new

    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('a@test.com')?.action).toBe('news');
    expect(reloaded.exact.get('b@test.com')?.action).toBe('delete');
    expect(reloaded.exact.get('c@test.com')?.action).toBe('invoice');
  });

  it('12.3 — Invalid action for one entry → that entry in failed[], others still saved', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'good@test.com', action: 'news' },
        { email_address: 'bad@test.com', action: 'nonexistent_action' },
        { email_address: 'also-good@test.com', action: 'delete' },
      ],
    });

    expect(result.saved).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].email_address).toBe('bad@test.com');
    expect(result.failed[0].action).toBe('nonexistent_action');
    expect(result.failed[0].error).toContain('Invalid action');
    expect(result.total_rules).toBe(3); // 1 existing + 2 new

    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('good@test.com')?.action).toBe('news');
    expect(reloaded.exact.get('also-good@test.com')?.action).toBe('delete');
    expect(reloaded.exact.has('bad@test.com')).toBe(false);
  });

  it('12.4 — Duplicate email_address in array → last one wins, no error', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'dup@test.com', action: 'news' },
        { email_address: 'dup@test.com', action: 'delete' },
      ],
    });

    expect(result.saved).toBe(2); // both counted as saved
    expect(result.failed).toEqual([]);

    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('dup@test.com')?.action).toBe('delete'); // last wins
  });

  it('12.5 — Empty array → returns saved=0, failed=[], no errors thrown', async () => {
    const result = await handleClassifySenders({
      classifications: [],
    });

    expect(result.saved).toBe(0);
    expect(result.failed).toEqual([]);
    expect(result.total_rules).toBe(1); // unchanged
  });

  it('12.6 — All invalid actions → saved=0, all in failed[]', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'a@test.com', action: 'bogus1' },
        { email_address: 'b@test.com', action: 'bogus2' },
        { email_address: 'c@test.com', action: 'bogus3' },
      ],
    });

    expect(result.saved).toBe(0);
    expect(result.failed).toHaveLength(3);
    expect(result.total_rules).toBe(1); // unchanged
  });

  it('12.7 — Case-insensitive: "FOO@BAR.COM" and "foo@bar.com" treated as same address', async () => {
    const result = await handleClassifySenders({
      classifications: [
        { email_address: 'FOO@BAR.COM', action: 'news' },
        { email_address: 'foo@bar.com', action: 'delete' },
      ],
    });

    expect(result.saved).toBe(2);
    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('foo@bar.com')?.action).toBe('delete'); // last wins, both normalized
    // Should not have both upper and lower as separate entries
    const fooEntries = [...reloaded.exact.keys()].filter(k => k === 'foo@bar.com');
    expect(fooEntries).toHaveLength(1);
  });

  it('12.8 — Atomic save: if disk write fails, no partial state is written', async () => {
    // Point to unwritable path
    process.env.RULES_CONFIG_PATH = '/nonexistent-dir/rules.json';
    const freshRules: SenderRules = {
      exact: new Map([['existing@test.com', { action: 'subscriptions', rule_id: 'test0001' }]]),
      regex: [],
      configPath: '/nonexistent-dir/rules.json',
    };
    initClassifySenders(freshRules);

    await expect(handleClassifySenders({
      classifications: [
        { email_address: 'a@test.com', action: 'news' },
        { email_address: 'b@test.com', action: 'delete' },
      ],
    })).rejects.toThrow();

    // Original rules file should be unchanged
    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.size).toBe(1);
    expect(reloaded.exact.has('a@test.com')).toBe(false);
  });
});

// ── Test Suite 13: get_actions (handler-level) ──

describe('Test Suite 13: get_actions (handler-level)', () => {
  let actionsDir: string;

  beforeEach(() => {
    actionsDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-actions-'));
    process.env.ACTIONS_CONFIG_PATH = join(actionsDir, 'custom-actions.json');
  });

  afterEach(() => {
    delete process.env.ACTIONS_CONFIG_PATH;
  });

  it('13.1 — Returns all 7 built-in actions always, even with empty custom config', async () => {
    const result = await handleGetActions();
    const builtIns = result.actions.filter(a => a.built_in);
    expect(builtIns).toHaveLength(7);

    const names = builtIns.map(a => a.name);
    expect(names).toContain('important');
    expect(names).toContain('invoice');
    expect(names).toContain('subscriptions');
    expect(names).toContain('news');
    expect(names).toContain('delete');
    expect(names).toContain('doubleclick');
    expect(names).toContain('unknown');
  });

  it('13.2 — Returns custom actions merged with built-ins when custom config exists', async () => {
    registerAction('archive', { moveToFolder: 'archived', markRead: true });
    registerAction('spam', { moveToFolder: 'spam-folder' });

    const result = await handleGetActions();
    expect(result.total).toBe(9); // 7 built-in + 2 custom
    const customNames = result.actions.filter(a => !a.built_in).map(a => a.name);
    expect(customNames).toContain('archive');
    expect(customNames).toContain('spam');
  });

  it('13.3 — built_in field is true for built-ins, false for custom actions', async () => {
    registerAction('myaction', { moveToFolder: 'my-folder' });

    const result = await handleGetActions();
    const important = result.actions.find(a => a.name === 'important');
    const myaction = result.actions.find(a => a.name === 'myaction');

    expect(important?.built_in).toBe(true);
    expect(myaction?.built_in).toBe(false);
  });

  it('13.4 — After add_action is called, get_actions reflects the new action immediately', async () => {
    const before = await handleGetActions();
    const beforeTotal = before.total;

    await handleAddAction({ name: 'social', folder: 'social-media', mark_read: true });

    const after = await handleGetActions();
    expect(after.total).toBe(beforeTotal + 1);

    const social = after.actions.find(a => a.name === 'social');
    expect(social).toBeDefined();
    expect(social?.folder).toBe('social-media');
    expect(social?.mark_read).toBe(true);
    expect(social?.built_in).toBe(false);
  });

  it('13.5 — Returns built-ins only with no custom actions (no error thrown)', async () => {
    // resetCustomActions already called in beforeEach
    const result = await handleGetActions();
    expect(result.actions.every(a => a.built_in)).toBe(true);
    expect(result.total).toBe(7);
  });

  it('13.6 — No duplicate action names in response', async () => {
    registerAction('archive', { moveToFolder: 'archived' });
    registerAction('archive', { moveToFolder: 'archived-v2' }); // attempt duplicate

    const result = await handleGetActions();
    const archiveEntries = result.actions.filter(a => a.name === 'archive');
    expect(archiveEntries).toHaveLength(1);
  });
});

// ── Test Suite 14: Integration tests (both tools together) ──

describe('Test Suite 14: classify_senders + get_actions integration', () => {
  let tmpDir: string;
  let tmpFile: string;
  let rules: SenderRules;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-test-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(tmpFile, JSON.stringify({}));
    rules = loadSenderRules(tmpFile);
    process.env.RULES_CONFIG_PATH = tmpFile;
    process.env.ACTIONS_CONFIG_PATH = join(tmpDir, 'custom-actions.json');
    initClassifySenders(rules);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
    delete process.env.RULES_CONFIG_PATH;
    delete process.env.ACTIONS_CONFIG_PATH;
  });

  it('14.1 — Full flow: get_actions → add_action → get_actions → classify_senders → verify', async () => {
    // Step 1: get_actions → note total count
    const before = await handleGetActions();
    expect(before.total).toBe(7); // only built-ins

    // Step 2: add_action with a new custom action
    await handleAddAction({ name: 'social', folder: 'social-media', mark_read: true });

    // Step 3: get_actions again → verify new action appears with built_in: false
    const after = await handleGetActions();
    expect(after.total).toBe(8);
    const social = after.actions.find(a => a.name === 'social');
    expect(social).toBeDefined();
    expect(social?.built_in).toBe(false);
    expect(social?.folder).toBe('social-media');

    // Step 4: classify_senders with 3 classifications using the new action
    const classifyResult = await handleClassifySenders({
      classifications: [
        { email_address: 'twitter@x.com', action: 'social' },
        { email_address: 'facebook@meta.com', action: 'social' },
        { email_address: 'insta@meta.com', action: 'social' },
      ],
    });

    // Step 5: Verify saved=3, failed=[]
    expect(classifyResult.saved).toBe(3);
    expect(classifyResult.failed).toEqual([]);

    // Step 6: get_actions → action still present
    const final = await handleGetActions();
    expect(final.actions.find(a => a.name === 'social')).toBeDefined();
    expect(final.total).toBe(8);

    // Verify persistence
    const reloaded = loadSenderRules(tmpFile);
    expect(reloaded.exact.get('twitter@x.com')?.action).toBe('social');
    expect(reloaded.exact.get('facebook@meta.com')?.action).toBe('social');
    expect(reloaded.exact.get('insta@meta.com')?.action).toBe('social');
  });
});
