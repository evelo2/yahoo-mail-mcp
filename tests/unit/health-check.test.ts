import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetCustomActions, registerAction } from '../../src/imap/operations.js';

// Mock IMAP client returned by getConnection
const mockGetMailboxLock = vi.fn().mockResolvedValue({ release: vi.fn() });
const mockList = vi.fn().mockResolvedValue([
  { path: 'invoices' },
  { path: 'subscriptions' },
  { path: 'news' },
  { path: 'for-delete' },
]);
let mockMailbox: any = { exists: 47 };

function getMockClient() {
  return {
    usable: true,
    getMailboxLock: mockGetMailboxLock,
    list: mockList,
    get mailbox() { return mockMailbox; },
  };
}

vi.mock('../../src/imap/client.js', () => ({
  getConnection: vi.fn().mockImplementation(() => Promise.resolve(getMockClient())),
}));

import { handleHealthCheck } from '../../src/tools/health-check.js';
import { getConnection } from '../../src/imap/client.js';

let tmpDir: string;

beforeEach(() => {
  resetCustomActions();
  mockGetMailboxLock.mockResolvedValue({ release: vi.fn() });
  mockList.mockResolvedValue([
    { path: 'invoices' },
    { path: 'subscriptions' },
    { path: 'news' },
    { path: 'for-delete' },
  ]);
  mockMailbox = { exists: 47 };
  (getConnection as any).mockImplementation(() => Promise.resolve(getMockClient()));

  tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
  const rulesPath = join(tmpDir, 'sender-rules.json');
  writeFileSync(rulesPath, JSON.stringify({
    exact: { 'a@b.com': { action: 'delete', rule_id: 'r1' }, 'c@d.com': { action: 'news', rule_id: 'r2' } },
    regex: [{ rule_id: 'rx1', pattern: '@test\\.com$', action: 'subscriptions' }],
  }));
  process.env.RULES_CONFIG_PATH = rulesPath;
});

afterEach(() => {
  delete process.env.RULES_CONFIG_PATH;
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

describe('Test Suite 12: health_check', () => {
  it('12.1 — All checks pass on healthy connection', async () => {
    const result = await handleHealthCheck();

    expect(result.healthy).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.checks.imap_connect.ok).toBe(true);
    expect(result.checks.imap_connect.latency_ms).toBeTypeOf('number');
    expect(result.checks.inbox_access.ok).toBe(true);
    expect(result.checks.inbox_access.message_count).toBe(47);
    expect(result.checks.required_folders.ok).toBe(true);
    expect(result.checks.required_folders.missing).toHaveLength(0);
    expect(result.checks.rules_config.ok).toBe(true);
    expect(result.checks.rules_config.total_rules).toBe(3); // 2 exact + 1 regex
    expect(result.checks.actions_config.ok).toBe(true);
    expect(result.checks.actions_config.total_actions).toBeGreaterThanOrEqual(7);
  });

  it('12.2 — IMAP connect failure skips IMAP-dependent checks', async () => {
    (getConnection as any).mockRejectedValue(new Error('Connection refused'));

    const result = await handleHealthCheck();

    expect(result.healthy).toBe(false);
    expect(result.checks.imap_connect.ok).toBe(false);
    expect(result.checks.inbox_access.skipped).toBe(true);
    expect(result.checks.required_folders.skipped).toBe(true);
    // File-based checks still run
    expect(result.checks.rules_config.ok).toBe(true);
    expect(result.checks.actions_config.ok).toBe(true);
    expect(result.errors.some(e => e.check === 'imap_connect')).toBe(true);
  });

  it('12.3 — Missing required folder reports correctly', async () => {
    mockList.mockResolvedValue([
      { path: 'invoices' },
      { path: 'subscriptions' },
      // news, for-delete missing
    ]);

    const result = await handleHealthCheck();

    expect(result.healthy).toBe(false);
    expect(result.checks.required_folders.ok).toBe(false);
    expect(result.checks.required_folders.missing).toContain('news');
    expect(result.checks.required_folders.missing).toContain('for-delete');
    expect(result.checks.required_folders.missing).not.toContain('triaged');
    expect(result.checks.required_folders.present).toContain('invoices');
    expect(result.checks.required_folders.present).toContain('subscriptions');
  });

  it('12.4 — Corrupted rules JSON reports error', async () => {
    writeFileSync(join(tmpDir, 'sender-rules.json'), '{ invalid json !!!');

    const result = await handleHealthCheck();

    expect(result.healthy).toBe(false);
    expect(result.checks.rules_config.ok).toBe(false);
    expect(result.errors.some(e => e.check === 'rules_config')).toBe(true);
  });

  it('12.5 — Missing rules file reports error', async () => {
    process.env.RULES_CONFIG_PATH = join(tmpDir, 'nonexistent.json');

    const result = await handleHealthCheck();

    expect(result.healthy).toBe(false);
    expect(result.checks.rules_config.ok).toBe(false);
    expect(result.errors.some(e => e.check === 'rules_config')).toBe(true);
  });

  it('12.6 — Partial failure: rules ok, folder missing', async () => {
    mockList.mockResolvedValue([
      { path: 'invoices' },
      { path: 'subscriptions' },
      { path: 'news' },
      // for-delete missing
    ]);

    const result = await handleHealthCheck();

    expect(result.healthy).toBe(false);
    expect(result.checks.imap_connect.ok).toBe(true);
    expect(result.checks.inbox_access.ok).toBe(true);
    expect(result.checks.rules_config.ok).toBe(true);
    expect(result.checks.actions_config.ok).toBe(true);
    expect(result.checks.required_folders.ok).toBe(false);
    expect(result.checks.required_folders.missing).toEqual(['for-delete']);
  });

  it('12.7 — Custom action folders are checked', async () => {
    registerAction('watches', { moveToFolder: 'Watches', markRead: false });
    mockList.mockResolvedValue([
      { path: 'invoices' },
      { path: 'subscriptions' },
      { path: 'news' },
      { path: 'for-delete' },
    ]);

    const result = await handleHealthCheck();

    expect(result.checks.required_folders.missing).toContain('Watches');
  });

  it('12.8 — Uses shared connection via getConnection', async () => {
    await handleHealthCheck();

    expect(getConnection).toHaveBeenCalled();
  });

  it('12.9 — Rule count is correct for structured format', async () => {
    const result = await handleHealthCheck();

    // 2 exact + 1 regex = 3 total
    expect(result.checks.rules_config.total_rules).toBe(3);
  });

  it('12.10 — Rule count works for legacy flat format', async () => {
    writeFileSync(
      join(tmpDir, 'sender-rules.json'),
      JSON.stringify({ 'a@b.com': 'delete', 'c@d.com': 'news', 'e@f.com': 'invoice' }),
    );

    const result = await handleHealthCheck();

    expect(result.checks.rules_config.total_rules).toBe(3);
  });
});
