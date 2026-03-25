import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, resetKnownFolders } from '../../src/imap/operations.js';
import { handleListRules, initListRules } from '../../src/tools/list-rules.js';
import type { SenderRules, ExactRule, RegexRule } from '../../src/rules/config.js';

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

// ── Test Suite: list_rules tool (Story 2) ──

describe('list_rules — no filters', () => {
  it('Returns all rules when called with no params', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@test.com', { action: 'delete', rule_id: 'ex01' }],
        ['bob@test.com', { action: 'news', rule_id: 'ex02' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@spam\\.com$', action: 'delete', description: 'All spam.com' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({});

    expect(result.total).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.total_exact).toBe(2);
    expect(result.total_regex).toBe(1);
    expect(result.results).toHaveLength(3);
  });
});

describe('list_rules — action filter', () => {
  it('action filter returns only rules for that action', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@test.com', { action: 'delete', rule_id: 'ex01' }],
        ['bob@test.com', { action: 'news', rule_id: 'ex02' }],
        ['charlie@test.com', { action: 'delete', rule_id: 'ex03' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@spam\\.com$', action: 'delete' },
        { rule_id: 'rx02', pattern: '@news\\.org$', action: 'news' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({ action: 'delete' });

    expect(result.total).toBe(3); // rx01 + ex01 + ex03
    for (const r of result.results) {
      expect(r.action).toBe('delete');
    }
  });
});

describe('list_rules — type filter', () => {
  it('type: "exact" returns only exact rules', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@test.com', { action: 'delete', rule_id: 'ex01' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@spam\\.com$', action: 'delete' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({ type: 'exact' });

    expect(result.total).toBe(1);
    expect(result.results[0].type).toBe('exact');
    expect(result.results[0].email_address).toBe('alice@test.com');
  });

  it('type: "regex" returns only regex rules', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@test.com', { action: 'delete', rule_id: 'ex01' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@spam\\.com$', action: 'delete' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({ type: 'regex' });

    expect(result.total).toBe(1);
    expect(result.results[0].type).toBe('regex');
    expect(result.results[0].pattern).toBe('@spam\\.com$');
  });
});

describe('list_rules — search filter', () => {
  it('search matches partial email address substrings', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@example.com', { action: 'delete', rule_id: 'ex01' }],
        ['bob@other.com', { action: 'news', rule_id: 'ex02' }],
      ],
    });
    initListRules(rules);

    const result = await handleListRules({ search: 'example' });

    expect(result.total).toBe(1);
    expect(result.results[0].email_address).toBe('alice@example.com');
  });

  it('search matches against regex description field', async () => {
    const rules = makeSenderRules({
      regex: [
        { rule_id: 'rx01', pattern: '@spam\\.com$', action: 'delete', description: 'Block all spam domain' },
        { rule_id: 'rx02', pattern: '@news\\.org$', action: 'news', description: 'News orgs' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({ search: 'spam domain' });

    expect(result.total).toBe(1);
    expect(result.results[0].rule_id).toBe('rx01');
  });
});

describe('list_rules — pagination', () => {
  it('limit and offset paginate correctly', async () => {
    const exactEntries: Array<[string, ExactRule]> = [];
    for (let i = 0; i < 10; i++) {
      exactEntries.push([`user${i}@test.com`, { action: 'delete', rule_id: `ex${String(i).padStart(2, '0')}` }]);
    }
    const rules = makeSenderRules({ exact: exactEntries });
    initListRules(rules);

    // Page 1: offset=0, limit=3
    const page1 = await handleListRules({ limit: 3, offset: 0 });
    expect(page1.total).toBe(10);
    expect(page1.returned).toBe(3);
    expect(page1.offset).toBe(0);

    // Page 2: offset=3, limit=3
    const page2 = await handleListRules({ limit: 3, offset: 3 });
    expect(page2.total).toBe(10);
    expect(page2.returned).toBe(3);
    expect(page2.offset).toBe(3);

    // No overlap between pages
    const page1Ids = page1.results.map(r => r.rule_id);
    const page2Ids = page2.results.map(r => r.rule_id);
    for (const id of page1Ids) {
      expect(page2Ids).not.toContain(id);
    }

    // Last page (partial)
    const lastPage = await handleListRules({ limit: 3, offset: 9 });
    expect(lastPage.returned).toBe(1);
  });
});

describe('list_rules — empty ruleset', () => {
  it('Empty ruleset returns total: 0, results: []', async () => {
    const rules = makeSenderRules();
    initListRules(rules);

    const result = await handleListRules({});

    expect(result.total).toBe(0);
    expect(result.results).toEqual([]);
    expect(result.total_exact).toBe(0);
    expect(result.total_regex).toBe(0);
    expect(result.returned).toBe(0);
  });
});

describe('list_rules — combined filters', () => {
  it('Combined filters work correctly', async () => {
    const rules = makeSenderRules({
      exact: [
        ['alice@example.com', { action: 'delete', rule_id: 'ex01' }],
        ['bob@example.com', { action: 'news', rule_id: 'ex02' }],
        ['carol@other.com', { action: 'delete', rule_id: 'ex03' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@example\\.com$', action: 'delete', description: 'Example delete' },
        { rule_id: 'rx02', pattern: '@other\\.com$', action: 'news' },
      ],
    });
    initListRules(rules);

    // Filter: action=delete + type=exact
    const result = await handleListRules({ action: 'delete', type: 'exact' });
    expect(result.total).toBe(2); // alice + carol
    for (const r of result.results) {
      expect(r.type).toBe('exact');
      expect(r.action).toBe('delete');
    }

    // Filter: action=delete + search=example
    const result2 = await handleListRules({ action: 'delete', search: 'example' });
    // Should match: rx01 (pattern contains "example", action=delete) + ex01 (email contains "example", action=delete)
    expect(result2.total).toBe(2);
    for (const r of result2.results) {
      expect(r.action).toBe('delete');
    }
  });
});

describe('list_rules — sorting order', () => {
  it('Sorting: regex rules first (definition order), then exact rules alphabetical', async () => {
    const rules = makeSenderRules({
      exact: [
        ['charlie@test.com', { action: 'delete', rule_id: 'ex03' }],
        ['alice@test.com', { action: 'news', rule_id: 'ex01' }],
        ['bob@test.com', { action: 'invoice', rule_id: 'ex02' }],
      ],
      regex: [
        { rule_id: 'rx01', pattern: '@first\\.com$', action: 'delete' },
        { rule_id: 'rx02', pattern: '@second\\.com$', action: 'news' },
      ],
    });
    initListRules(rules);

    const result = await handleListRules({});

    // Regex rules come first, in definition order
    expect(result.results[0].type).toBe('regex');
    expect(result.results[0].rule_id).toBe('rx01');
    expect(result.results[1].type).toBe('regex');
    expect(result.results[1].rule_id).toBe('rx02');

    // Exact rules come after, alphabetical by email
    expect(result.results[2].type).toBe('exact');
    expect(result.results[2].email_address).toBe('alice@test.com');
    expect(result.results[3].type).toBe('exact');
    expect(result.results[3].email_address).toBe('bob@test.com');
    expect(result.results[4].type).toBe('exact');
    expect(result.results[4].email_address).toBe('charlie@test.com');
  });
});
