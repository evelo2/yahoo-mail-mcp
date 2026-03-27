import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, resetKnownFolders, getActionTable } from '../../src/imap/operations.js';
import {
  loadSenderRules,
  saveSenderRules,
  addRegexRule,
  removeRule,
  generateRuleId,
  getValidActions,
  type SenderRules,
  type ExactRule,
  type RegexRule,
} from '../../src/rules/config.js';
import { lookupSender, clearRegexCache } from '../../src/rules/engine.js';
import { handleAddRegexRule, initAddRegexRule } from '../../src/tools/add-regex-rule.js';
import { handleRemoveRule, initRemoveRule } from '../../src/tools/remove-rule.js';
import { handleClassifySenders, initClassifySenders } from '../../src/tools/classify-senders.js';
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
  resetKnownFolders();
  clearRegexCache();
});

// Helper to build SenderRules in-memory (no filesystem needed for pure engine tests)
function makeSenderRules(opts?: {
  exact?: Array<[string, ExactRule]>;
  regex?: RegexRule[];
}): SenderRules {
  return {
    exact: new Map(opts?.exact ?? []),
    regex: opts?.regex ?? [],
    configPath: '/tmp/test-rules.json',
  };
}

// ── Test Suite: Regex Rules (Story 1 + cross-story) ──

describe('Regex Rules — lookupSender engine', () => {
  it('Exact rule matches correctly and takes priority over a regex rule that would also match', () => {
    const rules = makeSenderRules({
      exact: [['promo@shop.com', { action: 'delete', rule_id: 'ex01' }]],
      regex: [{ rule_id: 'rx01', pattern: '@shop\\.com$', action: 'subscriptions' }],
    });

    const result = lookupSender(rules, 'promo@shop.com');
    expect(result).toMatchObject({
      matched: true,
      match_type: 'exact',
      action: 'delete',
      rule_id: 'ex01',
    });
  });

  it('Regex rule matches when no exact rule exists', () => {
    const rules = makeSenderRules({
      regex: [{ rule_id: 'rx01', pattern: '@shop\\.com$', action: 'subscriptions' }],
    });

    const result = lookupSender(rules, 'promo@shop.com');
    expect(result).toMatchObject({
      matched: true,
      match_type: 'regex',
      action: 'subscriptions',
      matched_pattern: '@shop\\.com$',
      rule_id: 'rx01',
    });
  });

  it('First matching regex rule wins when multiple patterns match', () => {
    const rules = makeSenderRules({
      regex: [
        { rule_id: 'rx01', pattern: '@shop\\.com$', action: 'subscriptions' },
        { rule_id: 'rx02', pattern: 'promo@', action: 'delete' },
      ],
    });

    const result = lookupSender(rules, 'promo@shop.com');
    expect(result).toMatchObject({
      matched: true,
      match_type: 'regex',
      action: 'subscriptions',
      matched_pattern: '@shop\\.com$',
      rule_id: 'rx01',
    });
  });

  it('lookup_sender returns correct match_type and matched_pattern for regex matches', () => {
    const rules = makeSenderRules({
      regex: [{ rule_id: 'rx10', pattern: 'newsletter@.*\\.org$', action: 'news', description: 'All .org newsletters' }],
    });

    const result = lookupSender(rules, 'newsletter@example.org');
    expect(result.match_type).toBe('regex');
    expect(result.matched_pattern).toBe('newsletter@.*\\.org$');
    expect(result.rule_id).toBe('rx10');
    expect(result.action).toBe('news');
    expect(result.matched).toBe(true);
  });

  it('lookup_sender returns correct match_type: "exact" and rule_id for exact matches', () => {
    const rules = makeSenderRules({
      exact: [['bob@example.com', { action: 'important', rule_id: 'ex99' }]],
    });

    const result = lookupSender(rules, 'bob@example.com');
    expect(result.match_type).toBe('exact');
    expect(result.rule_id).toBe('ex99');
    expect(result.matched).toBe(true);
  });

  it('process_known_senders applies regex rules correctly (via lookupSender)', () => {
    // This tests that lookupSender, which is the core of process_known_senders,
    // returns the right action for regex-matched senders.
    const rules = makeSenderRules({
      regex: [
        { rule_id: 'rx20', pattern: '@marketing\\.example\\.com$', action: 'delete' },
        { rule_id: 'rx21', pattern: '@news\\.example\\.com$', action: 'news' },
      ],
    });

    const r1 = lookupSender(rules, 'promo@marketing.example.com');
    expect(r1.matched).toBe(true);
    expect(r1.action).toBe('delete');

    const r2 = lookupSender(rules, 'daily@news.example.com');
    expect(r2.matched).toBe(true);
    expect(r2.action).toBe('news');

    const r3 = lookupSender(rules, 'support@example.com');
    expect(r3.matched).toBe(false);
    expect(r3.action).toBe('unknown');
  });

  it('Empty regex array behaves identically to current system (no regression)', () => {
    const rules = makeSenderRules({
      exact: [['known@test.com', { action: 'invoice', rule_id: 'ex50' }]],
      regex: [],
    });

    const known = lookupSender(rules, 'known@test.com');
    expect(known).toMatchObject({ matched: true, match_type: 'exact', action: 'invoice' });

    const unknown = lookupSender(rules, 'unknown@test.com');
    expect(unknown).toMatchObject({ matched: false, action: 'unknown' });
  });
});

describe('Regex Rules — addRegexRule / removeRule config helpers', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-regex-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(
      tmpFile,
      JSON.stringify({
        exact: { 'existing@test.com': { action: 'subscriptions', rule_id: 'ex01' } },
        regex: [],
      }),
    );
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('Invalid regex pattern in add_regex_rule is rejected with a clear error', () => {
    const rules = loadSenderRules(tmpFile);
    expect(() => addRegexRule(rules, '[invalid(', 'delete')).toThrow(/Invalid regex pattern/);
  });

  it('Invalid action in add_regex_rule is rejected', () => {
    const rules = loadSenderRules(tmpFile);
    expect(() => addRegexRule(rules, '@test\\.com$', 'nonexistent_action')).toThrow(/Invalid action/);
  });

  it('add_regex_rule returns the new rule with rule_id', () => {
    const rules = loadSenderRules(tmpFile);
    const rule = addRegexRule(rules, '@example\\.com$', 'delete', 'All example.com');

    expect(rule.rule_id).toEqual(expect.any(String));
    expect(rule.rule_id).toHaveLength(8);
    expect(rule.pattern).toBe('@example\\.com$');
    expect(rule.action).toBe('delete');
    expect(rule.description).toBe('All example.com');

    // Also check it was pushed to the rules object
    expect(rules.regex).toHaveLength(1);
    expect(rules.regex[0].rule_id).toBe(rule.rule_id);
  });

  it('removeRule by rule_id removes the correct regex rule', () => {
    const rules = loadSenderRules(tmpFile);
    const added = addRegexRule(rules, '@example\\.com$', 'delete');
    expect(rules.regex).toHaveLength(1);

    const result = removeRule(rules, { rule_id: added.rule_id });
    expect(result.removed).toBe(true);
    expect(result.pattern).toBe('@example\\.com$');
    expect(rules.regex).toHaveLength(0);
  });

  it('removeRule by pattern removes regex rule', () => {
    const rules = loadSenderRules(tmpFile);
    addRegexRule(rules, '@example\\.com$', 'delete');
    expect(rules.regex).toHaveLength(1);

    const result = removeRule(rules, { pattern: '@example\\.com$' });
    expect(result.removed).toBe(true);
    expect(result.pattern).toBe('@example\\.com$');
    expect(rules.regex).toHaveLength(0);
  });

  it('removeRule with a non-existent pattern returns removed: false without error', () => {
    const rules = loadSenderRules(tmpFile);
    const result = removeRule(rules, { pattern: '@nope\\.com$' });
    expect(result.removed).toBe(false);
  });
});

describe('Regex Rules — tool handlers', () => {
  let tmpDir: string;
  let tmpFile: string;
  let rules: SenderRules;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-regex-tools-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(
      tmpFile,
      JSON.stringify({
        exact: { 'existing@test.com': { action: 'subscriptions', rule_id: 'ex01' } },
        regex: [],
      }),
    );
    rules = loadSenderRules(tmpFile);
    initAddRegexRule(rules);
    initRemoveRule(rules);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('handleAddRegexRule returns rule_id and totals', async () => {
    const result = await handleAddRegexRule({
      pattern: '@shop\\.com$',
      action: 'delete',
      description: 'All shop.com senders',
    });

    expect(result.rule_id).toEqual(expect.any(String));
    expect(result.rule_id).toHaveLength(8);
    expect(result.pattern).toBe('@shop\\.com$');
    expect(result.action).toBe('delete');
    expect(result.description).toBe('All shop.com senders');
    expect(result.total_regex_rules).toBe(1);
    expect(result.total_exact_rules).toBe(1);
  });

  it('handleAddRegexRule rejects invalid regex', async () => {
    await expect(
      handleAddRegexRule({ pattern: '[bad(', action: 'delete' }),
    ).rejects.toThrow(/Invalid regex pattern/);
  });

  it('handleRemoveRule removes regex rule by rule_id', async () => {
    const added = await handleAddRegexRule({ pattern: '@test\\.com$', action: 'delete' });

    const result = await handleRemoveRule({ rule_id: added.rule_id });
    expect(result.removed).toBe(true);
    expect(result.type).toBe('regex');
    expect(result.pattern).toBe('@test\\.com$');
    expect(result.action).toBe('delete');
  });

  it('handleRemoveRule removes exact rule by rule_id', async () => {
    // existing@test.com was loaded with rule_id 'ex01'
    const result = await handleRemoveRule({ rule_id: 'ex01' });
    expect(result.removed).toBe(true);
    expect(result.type).toBe('exact');
    expect(result.email_address).toBe('existing@test.com');
    expect(result.action).toBe('subscriptions');
  });

  it('handleRemoveRule removes exact rule by email_address', async () => {
    const result = await handleRemoveRule({ email_address: 'existing@test.com' });
    expect(result.removed).toBe(true);
    expect(result.type).toBe('exact');
    expect(result.email_address).toBe('existing@test.com');
  });

  it('handleRemoveRule removes regex rule by pattern', async () => {
    await handleAddRegexRule({ pattern: '@example\\.org$', action: 'delete' });
    const result = await handleRemoveRule({ pattern: '@example\\.org$' });
    expect(result.removed).toBe(true);
    expect(result.type).toBe('regex');
    expect(result.pattern).toBe('@example\\.org$');
  });

  it('handleRemoveRule returns removed: false for non-existent', async () => {
    const result = await handleRemoveRule({ rule_id: 'nonexistent' });
    expect(result.removed).toBe(false);
  });

  it('handleRemoveRule requires at least one identifier', async () => {
    await expect(handleRemoveRule({})).rejects.toThrow(
      /At least one of rule_id, email_address, pattern, or route_id must be provided/,
    );
  });
});

describe('Regex Rules — classify_sender rule_id behavior', () => {
  let tmpDir: string;
  let tmpFile: string;
  let rules: SenderRules;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-classify-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
    writeFileSync(tmpFile, JSON.stringify({
      exact: {},
      regex: [],
    }));
    rules = loadSenderRules(tmpFile);
    initClassifySenders(rules);
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('Every rule created via classify_sender has a unique rule_id in the response', async () => {
    await handleClassifySenders({
      classifications: [
        { email_address: 'a@test.com', action: 'delete' },
        { email_address: 'b@test.com', action: 'news' },
        { email_address: 'c@test.com', action: 'invoice' },
      ],
    });

    const reloaded = loadSenderRules(tmpFile);
    const ruleIds = [...reloaded.exact.values()].map(r => r.rule_id);

    // All should be strings
    for (const id of ruleIds) {
      expect(id).toEqual(expect.any(String));
      expect(id.length).toBeGreaterThan(0);
    }

    // All should be unique
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(ruleIds.length);
  });

  it('rule_id does not change when a rule is overwritten via classify_sender with the same email', async () => {
    // Create initial rule
    await handleClassifySenders({
      classifications: [
        { email_address: 'stable@test.com', action: 'delete' },
      ],
    });

    const firstLoad = loadSenderRules(tmpFile);
    const originalRuleId = firstLoad.exact.get('stable@test.com')!.rule_id;
    expect(originalRuleId).toEqual(expect.any(String));

    // Re-init with reloaded rules so the in-memory state matches disk
    initClassifySenders(firstLoad);

    // Overwrite with different action
    await handleClassifySenders({
      classifications: [
        { email_address: 'stable@test.com', action: 'news' },
      ],
    });

    const secondLoad = loadSenderRules(tmpFile);
    const newRuleId = secondLoad.exact.get('stable@test.com')!.rule_id;
    expect(newRuleId).toBe(originalRuleId);
    expect(secondLoad.exact.get('stable@test.com')!.action).toBe('news');
  });
});
