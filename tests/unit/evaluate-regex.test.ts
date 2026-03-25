import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';
import { resetClientState } from '../../src/imap/client.js';
import { initEvaluateRegex, handleEvaluateRegex } from '../../src/tools/evaluate-regex.js';
import type { SenderRules, ExactRule, RegexRule } from '../../src/rules/config.js';

let mockClient: MockImapClient;

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockImplementation(() => {
      return Promise.resolve(mockClient);
    }),
  };
});

beforeEach(() => {
  resetClientState();
});

function buildRules(opts?: {
  exact?: Array<{ email: string; action: string; rule_id?: string }>;
  regex?: RegexRule[];
}): SenderRules {
  const exactMap = new Map<string, ExactRule>();
  for (const e of opts?.exact ?? []) {
    exactMap.set(e.email.toLowerCase(), {
      action: e.action,
      rule_id: e.rule_id ?? `r-${e.email.replace(/[@.]/g, '')}`,
    });
  }
  return {
    exact: exactMap,
    regex: opts?.regex ?? [],
    configPath: '/tmp/test-rules.json',
  };
}

describe('Test Suite: evaluate_regex', () => {
  it('valid pattern with no matches returns rule_matches.total: 0', async () => {
    const rules = buildRules({
      exact: [{ email: 'alice@foo.com', action: 'important' }],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({ pattern: '@bar\\.com$' });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.total).toBe(0);
    expect(result.rule_matches.exact_matches).toEqual([]);
    expect(result.rule_matches.regex_matches).toEqual([]);
  });

  it('valid pattern matching exact rules returns them in exact_matches', async () => {
    const rules = buildRules({
      exact: [
        { email: 'news@example.com', action: 'news' },
        { email: 'promo@example.com', action: 'subscriptions' },
        { email: 'unrelated@other.com', action: 'important' },
      ],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({ pattern: '@example\\.com$' });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.total).toBe(2);
    expect(result.rule_matches.exact_matches.length).toBe(2);
    const emails = result.rule_matches.exact_matches.map((m: any) => m.email_address);
    expect(emails).toContain('news@example.com');
    expect(emails).toContain('promo@example.com');
  });

  it('conflict correctly identified when matched rule maps to different action', async () => {
    const rules = buildRules({
      exact: [
        { email: 'news@example.com', action: 'news' },
        { email: 'promo@example.com', action: 'subscriptions' },
      ],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({
      pattern: '@example\\.com$',
      action: 'delete',
    });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.conflicts).toBe(2);
    for (const match of result.rule_matches.exact_matches) {
      expect(match.conflict).toBe(true);
    }
    expect(result.rule_matches.conflict_summary).toContain('2');
  });

  it('no conflict when matched rule maps to same action as action param', async () => {
    const rules = buildRules({
      exact: [
        { email: 'news@example.com', action: 'delete' },
      ],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({
      pattern: '@example\\.com$',
      action: 'delete',
    });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.conflicts).toBe(0);
    expect(result.rule_matches.exact_matches[0].conflict).toBe(false);
    expect(result.rule_matches.conflict_summary).toBeNull();
  });

  it('include_inbox_sample: false returns inbox_sample: { checked: false }', async () => {
    const rules = buildRules();
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({
      pattern: '@test\\.com$',
      include_inbox_sample: false,
    });
    expect(result.inbox_sample.checked).toBe(false);
    expect(result.inbox_sample.total_matches).toBeUndefined();
    expect(result.inbox_sample.emails).toBeUndefined();
  });

  it('invalid regex pattern returns valid: false with error message', async () => {
    const rules = buildRules();
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({ pattern: '[invalid(' });
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('Invalid regular expression');
  });

  it('pattern matching both exact and regex rules populates both arrays', async () => {
    const rules = buildRules({
      exact: [
        { email: 'news@example.com', action: 'news' },
      ],
      regex: [
        { rule_id: 'rx-1', pattern: '@example\\.com$', action: 'subscriptions' },
      ],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({ pattern: '@example\\.com$' });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.exact_matches.length).toBe(1);
    expect(result.rule_matches.regex_matches.length).toBe(1);
    expect(result.rule_matches.total).toBe(2);
  });

  it('empty ruleset returns valid response with zero matches', async () => {
    const rules = buildRules();
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({ pattern: '.*' });
    expect(result.valid).toBe(true);
    expect(result.rule_matches.total).toBe(0);
    expect(result.rule_matches.exact_matches).toEqual([]);
    expect(result.rule_matches.regex_matches).toEqual([]);
  });

  it('conflicts sorted first in results', async () => {
    const rules = buildRules({
      exact: [
        { email: 'alice@example.com', action: 'delete' },
        { email: 'bob@example.com', action: 'news' },
        { email: 'carol@example.com', action: 'delete' },
      ],
    });
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({
      pattern: '@example\\.com$',
      action: 'news',
    });

    // alice and carol have action 'delete' != 'news' => conflict=true
    // bob has action 'news' == 'news' => conflict=false
    expect(result.rule_matches.exact_matches.length).toBe(3);
    expect(result.rule_matches.conflicts).toBe(2);

    // Conflicts should come first
    expect(result.rule_matches.exact_matches[0].conflict).toBe(true);
    expect(result.rule_matches.exact_matches[1].conflict).toBe(true);
    expect(result.rule_matches.exact_matches[2].conflict).toBe(false);
  });

  it('include_inbox_sample: true with matching inbox emails returns sample', async () => {
    const msgs = [
      createMockMessage({ uid: 1, from_address: 'sender@example.com', subject: 'Test 1' }),
      createMockMessage({ uid: 2, from_address: 'other@unrelated.com', subject: 'Test 2' }),
      createMockMessage({ uid: 3, from_address: 'another@example.com', subject: 'Test 3' }),
    ];
    mockClient = createMockImapClient(msgs);

    const rules = buildRules();
    initEvaluateRegex(rules);

    const result = await handleEvaluateRegex({
      pattern: '@example\\.com$',
      include_inbox_sample: true,
    });

    expect(result.inbox_sample.checked).toBe(true);
    expect(result.inbox_sample.total_matches).toBe(2);
    expect(result.inbox_sample.emails.length).toBe(2);
    const addresses = result.inbox_sample.emails.map((e: any) => e.from_address);
    expect(addresses).toContain('sender@example.com');
    expect(addresses).toContain('another@example.com');
  });
});
