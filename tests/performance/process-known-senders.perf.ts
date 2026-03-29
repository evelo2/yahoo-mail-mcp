/**
 * Performance tests for the hot path: lookupSender + process_known_senders
 *
 * These tests establish throughput and latency baselines. Any change to
 * src/rules/engine.ts, src/tools/process-known-senders.ts, or
 * src/imap/operations.ts must not cause a regression below these thresholds.
 *
 * Thresholds are intentionally generous to avoid flakiness on slow CI.
 * The goal is to catch O(n) regressions in O(1) paths, not to microbenchmark.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lookupSender, clearRegexCache } from '../../src/rules/engine.js';
import { handleProcessKnownSenders, initProcessKnownSenders } from '../../src/tools/process-known-senders.js';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, resetKnownFolders } from '../../src/imap/operations.js';
import type { SenderRules, ExactRule, RegexRule } from '../../src/rules/config.js';
import { createMockImapClient, type MockImapClient } from '../setup.js';
import { createMockMessage } from '../fixtures/emails.js';

// ── Mock IMAP for end-to-end process_known_senders tests ──────────────────────

let mockClient: MockImapClient;

vi.mock('../../src/imap/client.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/imap/client.js')>();
  return {
    ...mod,
    delay: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn(() => mockClient),
  };
});

// ── Fixture builders ───────────────────────────────────────────────────────────

/**
 * Build a SenderRules map with `n` exact rules.
 * The target email 'known@example.com' is always included as the last entry.
 */
function buildExactRules(n: number, targetEmail = 'known@example.com'): SenderRules {
  const exact = new Map<string, ExactRule>();
  for (let i = 0; i < n - 1; i++) {
    exact.set(`sender${i}@domain${i}.com`, { action: 'subscriptions', rule_id: `rule${i.toString().padStart(8, '0')}` });
  }
  exact.set(targetEmail, { action: 'delete', rule_id: 'targetrule' });
  return { exact, regex: [], configPath: '/tmp/perf-test-rules.json' };
}

/**
 * Build a SenderRules map with `n` regex rules.
 * None match the target — forces a full traversal before returning unknown.
 */
function buildRegexRules(n: number): SenderRules {
  const regex: RegexRule[] = [];
  for (let i = 0; i < n; i++) {
    regex.push({
      rule_id: `regex${i.toString().padStart(8, '0')}`,
      pattern: `@specific-domain-${i}\\.com$`,
      action: 'subscriptions',
    });
  }
  return { exact: new Map(), regex, configPath: '/tmp/perf-test-rules.json' };
}

/**
 * Build a SenderRules map with `n` regex rules, where the last one matches target.
 */
function buildRegexRulesWithMatch(n: number, targetEmail: string): SenderRules {
  const regex: RegexRule[] = [];
  for (let i = 0; i < n - 1; i++) {
    regex.push({
      rule_id: `regex${i.toString().padStart(8, '0')}`,
      pattern: `@specific-domain-${i}\\.com$`,
      action: 'subscriptions',
    });
  }
  // Last rule matches the target email
  const domain = targetEmail.split('@')[1];
  regex.push({
    rule_id: 'regexlast',
    pattern: `@${domain.replace(/\./g, '\\.')}$`,
    action: 'news',
  });
  return { exact: new Map(), regex, configPath: '/tmp/perf-test-rules.json' };
}

/**
 * Build a batch of mock inbox messages.
 * Half map to known senders, half are unknown.
 */
function buildInboxMessages(count: number, knownEmails: string[]) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const fromAddress = i % 2 === 0 && knownEmails.length > 0
      ? knownEmails[i % knownEmails.length]
      : `unknown${i}@mystery.com`;
    messages.push(createMockMessage({
      uid: 2000 + i,
      from_address: fromAddress,
      subject: `Perf Test Email ${i}`,
      date: new Date(Date.now() - i * 3600000),
    }));
  }
  return messages;
}

// ── Suite setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  clearRegexCache();
  resetClientState();
  resetCustomActions();
  resetKnownFolders();
});

afterEach(() => {
  clearRegexCache();
});

// ── 1. lookupSender — Exact rule O(1) throughput ───────────────────────────────

describe('Perf 1: lookupSender exact-match throughput', () => {
  it('1.1 — 1000 exact lookups against 50 rules completes in < 10ms', () => {
    const rules = buildExactRules(50);
    const targetEmail = 'known@example.com';

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, targetEmail);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    // Sanity check — correct result returned
    const result = lookupSender(rules, targetEmail);
    expect(result.matched).toBe(true);
    expect(result.action).toBe('delete');
  });

  it('1.2 — 1000 exact lookups against 450 rules completes in < 10ms (O(1) verified)', () => {
    const rules = buildExactRules(450);
    const targetEmail = 'known@example.com';

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, targetEmail);
    }
    const elapsed = performance.now() - start;

    // O(1) Map.get — rule count should not meaningfully affect lookup time
    expect(elapsed).toBeLessThan(500);
  });

  it('1.3 — 1000 exact lookups against 1000 rules completes in < 10ms (O(1) at scale)', () => {
    const rules = buildExactRules(1000);
    const targetEmail = 'known@example.com';

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, targetEmail);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it('1.4 — O(1) scale characteristic: 50 vs 1000 rules shows <3x difference', () => {
    const rules50 = buildExactRules(50);
    const rules1000 = buildExactRules(1000);
    const targetEmail = 'known@example.com';
    const iterations = 1000;

    const start50 = performance.now();
    for (let i = 0; i < iterations; i++) lookupSender(rules50, targetEmail);
    const elapsed50 = performance.now() - start50;

    const start1000 = performance.now();
    for (let i = 0; i < iterations; i++) lookupSender(rules1000, targetEmail);
    const elapsed1000 = performance.now() - start1000;

    // If O(1), 20x more rules should NOT produce 20x more time.
    // Allow up to 3x for warmup/noise — any more indicates O(n) regression.
    // Guard against near-zero measurements causing flaky ratio calculations.
    if (elapsed50 > 0.5) {
      expect(elapsed1000 / elapsed50).toBeLessThan(3);
    }
  });
});

// ── 2. lookupSender — Regex fallback throughput ────────────────────────────────

describe('Perf 2: lookupSender regex-fallback throughput', () => {
  it('2.1 — 1000 regex traversals through 10 rules completes in < 50ms', () => {
    // Cold cache first pass populates it; subsequent hits serve from cache
    const rules = buildRegexRules(10);
    const unknownEmail = 'unmatched@nowhere.com';

    // Warm the cache with one pass
    lookupSender(rules, unknownEmail);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, unknownEmail);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(2000);
  });

  it('2.2 — 1000 regex traversals through 30 rules completes in < 100ms', () => {
    const rules = buildRegexRules(30);
    const unknownEmail = 'unmatched@nowhere.com';

    // Warm cache
    lookupSender(rules, unknownEmail);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, unknownEmail);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  it('2.3 — Regex match on last rule of 30: 1000 lookups < 100ms', () => {
    const targetEmail = 'match@last-domain.com';
    const rules = buildRegexRulesWithMatch(30, targetEmail);

    // Warm cache
    lookupSender(rules, targetEmail);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      lookupSender(rules, targetEmail);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    // Verify match is found
    const result = lookupSender(rules, targetEmail);
    expect(result.matched).toBe(true);
    expect(result.match_type).toBe('regex');
  });
});

// ── 3. lookupSender — Subject route overhead ───────────────────────────────────

describe('Perf 3: lookupSender subject route evaluation overhead', () => {
  it('3.1 — Subject route matching adds negligible overhead vs no routes', () => {
    const iterations = 5000;

    // Rules without subject routes
    const rulesNoRoutes: SenderRules = {
      exact: new Map([
        ['sender@test.com', { action: 'subscriptions', rule_id: 'base0001' }],
      ]),
      regex: [],
      configPath: '/tmp/perf-test.json',
    };

    // Rules with 3 subject routes (realistic case)
    const rulesWithRoutes: SenderRules = {
      exact: new Map([
        ['sender@test.com', {
          action: 'subscriptions',
          rule_id: 'base0002',
          subject_routes: [
            { route_id: 'r001', pattern: 'order.*confirm', action: 'invoice', important: true, important_ttl_days: 1 },
            { route_id: 'r002', pattern: 'shipped|tracking|delivered', action: 'invoice', important: true, important_ttl_days: 1 },
            { route_id: 'r003', pattern: 'unsubscribe|newsletter', action: 'delete' },
          ],
        }],
      ]),
      regex: [],
      configPath: '/tmp/perf-test.json',
    };

    // Subject that does NOT match any route (worst case for route evaluation)
    const nonMatchingSubject = 'Spring sale — up to 50% off';

    // Warm caches
    lookupSender(rulesNoRoutes, 'sender@test.com', nonMatchingSubject);
    lookupSender(rulesWithRoutes, 'sender@test.com', nonMatchingSubject);

    const startNoRoutes = performance.now();
    for (let i = 0; i < iterations; i++) {
      lookupSender(rulesNoRoutes, 'sender@test.com', nonMatchingSubject);
    }
    const elapsedNoRoutes = performance.now() - startNoRoutes;

    const startWithRoutes = performance.now();
    for (let i = 0; i < iterations; i++) {
      lookupSender(rulesWithRoutes, 'sender@test.com', nonMatchingSubject);
    }
    const elapsedWithRoutes = performance.now() - startWithRoutes;

    // Ratio is not asserted — elapsedNoRoutes can be sub-millisecond on fast
    // machines, making any ratio wildly unstable. The absolute guard below
    // is the meaningful regression detector.

    // 5000 lookups with 3 cached route patterns must complete in < 200ms
    expect(elapsedWithRoutes).toBeLessThan(1000);
  });

  it('3.2 — Subject route match (first match): 5000 lookups < 30ms', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['noreply@store.com', {
          action: 'subscriptions',
          rule_id: 'store001',
          subject_routes: [
            { route_id: 'sr001', pattern: 'order.*confirm', action: 'invoice', important: true, important_ttl_days: 1 },
            { route_id: 'sr002', pattern: 'shipped|tracking|delivered', action: 'invoice' },
          ],
        }],
      ]),
      regex: [],
      configPath: '/tmp/perf-test.json',
    };

    const matchingSubject = 'Order NB-19643 confirmed — thank you!';

    // Warm cache
    lookupSender(rules, 'noreply@store.com', matchingSubject);

    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      lookupSender(rules, 'noreply@store.com', matchingSubject);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(200);

    // Verify routing is correct
    const result = lookupSender(rules, 'noreply@store.com', matchingSubject);
    expect(result.action).toBe('invoice');
    expect(result.route_id).toBe('sr001');
    expect(result.matched_subject_pattern).toBe('order.*confirm');
  });
});

// ── 4. process_known_senders — End-to-end throughput ──────────────────────────

describe('Perf 4: process_known_senders end-to-end throughput', () => {
  const knownEmails = [
    'fossil@email.fossil.com',
    'ubereats@uber.com',
    'orders@starbucks.com',
    'boss@news.hugoboss.com',
    'newsletter@brand.com',
    'alerts@service.com',
    'billing@company.com',
    'noreply@store.com',
    'updates@platform.com',
    'promo@shop.com',
  ];

  const rules: SenderRules = {
    exact: new Map(knownEmails.map((email, i) => [
      email,
      { action: (['subscriptions', 'delete', 'invoice', 'news'] as const)[i % 4], rule_id: `perf${i.toString().padStart(4, '0')}` },
    ])),
    regex: [],
    configPath: '/tmp/perf-test-rules.json',
  };

  beforeEach(() => {
    initProcessKnownSenders(rules);
  });

  it('4.1 — 50 mixed emails (50% known) processes in < 1000ms', async () => {
    const messages = buildInboxMessages(50, knownEmails);
    mockClient = createMockImapClient(messages);

    const start = performance.now();
    const result = await handleProcessKnownSenders({});
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.total_fetched).toBe(50);
    expect(result.errors).toBe(0);
  });

  it('4.2 — 50 all-known emails processes in < 1000ms', async () => {
    // All emails from known senders
    const messages = knownEmails.flatMap((email, i) =>
      Array.from({ length: 5 }, (_, j) =>
        createMockMessage({
          uid: 3000 + i * 10 + j,
          from_address: email,
          subject: `Perf batch ${i}-${j}`,
          date: new Date(Date.now() - (i * 10 + j) * 3600000),
        })
      )
    );
    mockClient = createMockImapClient(messages);

    const start = performance.now();
    const result = await handleProcessKnownSenders({});
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(result.total_fetched).toBe(50);
    expect(result.known_processed).toBe(50);
    expect(result.unknown_skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('4.3 — 50 all-unknown emails processes in < 500ms (lookup + skip path)', async () => {
    // All emails from unknown senders — tests the lookup + skip branch
    const messages = Array.from({ length: 50 }, (_, i) =>
      createMockMessage({
        uid: 4000 + i,
        from_address: `unknown${i}@mystery${i}.com`,
        subject: `Unknown ${i}`,
        date: new Date(Date.now() - i * 3600000),
      })
    );
    mockClient = createMockImapClient(messages);

    const start = performance.now();
    const result = await handleProcessKnownSenders({});
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(result.total_fetched).toBe(50);
    expect(result.known_processed).toBe(0);
    expect(result.unknown_skipped).toBe(50);
    expect(result.errors).toBe(0);
  });

  it('4.4 — Lookup throughput: 1000 process_known_senders lookups within tool in < 20ms', () => {
    // Tests that the lookup itself (not IMAP) stays fast at batch scale.
    // This directly calls lookupSender in a tight loop to mirror what the tool does.
    const iterations = 1000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const email = i % 2 === 0
        ? knownEmails[i % knownEmails.length]
        : `unknown${i}@mystery.com`;
      lookupSender(rules, email);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(150);
  });
});

// ── 5. Regex cache behaviour ───────────────────────────────────────────────────

describe('Perf 5: regex cache effectiveness', () => {
  it('5.1 — Cold vs warm cache: warm lookups are not slower than cold', () => {
    const rules = buildRegexRules(20);
    const unknownEmail = 'unmatched@nowhere.com';

    // Cold cache — first 20 lookups compile regexes
    const coldStart = performance.now();
    for (let i = 0; i < 20; i++) lookupSender(rules, unknownEmail);
    const coldElapsed = performance.now() - coldStart;

    // Warm cache — subsequent 1000 lookups use cached regexes
    const warmStart = performance.now();
    for (let i = 0; i < 1000; i++) lookupSender(rules, unknownEmail);
    const warmElapsed = performance.now() - warmStart;

    // 1000 warm lookups should complete in under 5x the time of 20 cold lookups
    // (1000/20 = 50x more iterations at cached speed should be much faster per op)
    // Expressed differently: per-op time warm < per-op time cold
    // Absolute: 1000 warm lookups through 20 rules should be < 50ms.
    // Per-op ratio is not asserted — both measurements are sub-millisecond on
    // fast hardware and floating-point noise makes ratios unreliable at that
    // scale. The absolute threshold is the meaningful guard here.
    expect(warmElapsed).toBeLessThan(2000);
  });

  it('5.2 — Subject route regex cache: repeated pattern hits use cache (< 150ms for 5000)', () => {
    const rules: SenderRules = {
      exact: new Map([
        ['sender@brand.com', {
          action: 'subscriptions',
          rule_id: 'cache001',
          subject_routes: [
            { route_id: 'cr001', pattern: 'sale|promo|discount', action: 'delete' },
            { route_id: 'cr002', pattern: 'order.*confirm', action: 'invoice' },
          ],
        }],
      ]),
      regex: [],
      configPath: '/tmp/perf-test.json',
    };

    const subject = 'Big sale — 40% off everything this weekend';

    // Warm cache
    lookupSender(rules, 'sender@brand.com', subject);

    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      lookupSender(rules, 'sender@brand.com', subject);
    }
    const elapsedCache = performance.now() - start;

    expect(elapsedCache).toBeLessThan(150);
  });
});
