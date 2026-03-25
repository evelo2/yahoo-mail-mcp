import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetClientState } from '../../src/imap/client.js';
import { resetCustomActions, resetKnownFolders } from '../../src/imap/operations.js';
import {
  loadSenderRules,
  saveSenderRules,
  generateRuleId,
  type SenderRules,
} from '../../src/rules/config.js';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
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

// ── Test Suite: Config Migration (cross-story) ──

describe('Config Migration — legacy flat format', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-migrate-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
    try { unlinkSync(join(tmpDir, 'sender-rules.backup.json')); } catch {}
  });

  it('Loading legacy flat format produces correct SenderRules with rule_ids', () => {
    // Legacy format: Record<string, string>
    writeFileSync(tmpFile, JSON.stringify({
      'alice@example.com': 'delete',
      'bob@example.com': 'news',
      'carol@example.com': 'subscriptions',
    }));

    const rules = loadSenderRules(tmpFile);

    expect(rules.exact.size).toBe(3);
    expect(rules.exact.get('alice@example.com')?.action).toBe('delete');
    expect(rules.exact.get('bob@example.com')?.action).toBe('news');
    expect(rules.exact.get('carol@example.com')?.action).toBe('subscriptions');

    // All should have rule_ids
    for (const [, rule] of rules.exact) {
      expect(rule.rule_id).toEqual(expect.any(String));
      expect(rule.rule_id.length).toBeGreaterThan(0);
    }

    // Regex array should be empty
    expect(rules.regex).toEqual([]);
  });

  it('Migration from flat format creates backup file', () => {
    writeFileSync(tmpFile, JSON.stringify({
      'alice@example.com': 'delete',
    }));

    const backupPath = join(tmpDir, 'sender-rules.backup.json');
    expect(existsSync(backupPath)).toBe(false);

    loadSenderRules(tmpFile);

    expect(existsSync(backupPath)).toBe(true);

    // Backup should contain the original flat format
    const backupContent = JSON.parse(readFileSync(backupPath, 'utf-8'));
    expect(backupContent).toEqual({ 'alice@example.com': 'delete' });
  });
});

describe('Config Migration — new format', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-new-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('Loading new format preserves existing rule_ids', () => {
    writeFileSync(tmpFile, JSON.stringify({
      exact: {
        'alice@example.com': { action: 'delete', rule_id: 'abc12345' },
        'bob@example.com': { action: 'news', rule_id: 'def67890' },
      },
      regex: [
        { rule_id: 'rx112233', pattern: '@spam\\.com$', action: 'delete', description: 'Spam blocker' },
      ],
    }));

    const rules = loadSenderRules(tmpFile);

    expect(rules.exact.get('alice@example.com')?.rule_id).toBe('abc12345');
    expect(rules.exact.get('bob@example.com')?.rule_id).toBe('def67890');
    expect(rules.regex[0].rule_id).toBe('rx112233');
    expect(rules.regex[0].description).toBe('Spam blocker');
  });

  it('Missing rule_id gets assigned on load', () => {
    // New format but with missing rule_ids
    writeFileSync(tmpFile, JSON.stringify({
      exact: {
        'alice@example.com': { action: 'delete' },
      },
      regex: [
        { pattern: '@spam\\.com$', action: 'delete' },
      ],
    }));

    const rules = loadSenderRules(tmpFile);

    // Should have auto-generated rule_ids
    const aliceRuleId = rules.exact.get('alice@example.com')?.rule_id;
    expect(aliceRuleId).toEqual(expect.any(String));
    expect(aliceRuleId!.length).toBeGreaterThan(0);

    expect(rules.regex[0].rule_id).toEqual(expect.any(String));
    expect(rules.regex[0].rule_id.length).toBeGreaterThan(0);
  });
});

describe('Config Migration — round-trip', () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-roundtrip-'));
    tmpFile = join(tmpDir, 'sender-rules.json');
  });

  afterEach(() => {
    try { unlinkSync(tmpFile); } catch {}
  });

  it('Save/reload round-trip preserves all data', () => {
    writeFileSync(tmpFile, JSON.stringify({
      exact: {
        'alice@example.com': { action: 'delete', rule_id: 'abc12345' },
        'bob@example.com': { action: 'news', rule_id: 'def67890' },
      },
      regex: [
        { rule_id: 'rx01', pattern: '@marketing\\.com$', action: 'delete', description: 'Marketing spam' },
        { rule_id: 'rx02', pattern: '@newsletter\\.org$', action: 'news' },
      ],
    }));

    const original = loadSenderRules(tmpFile);

    // Save
    saveSenderRules(original);

    // Reload
    const reloaded = loadSenderRules(tmpFile);

    // Verify exact rules
    expect(reloaded.exact.size).toBe(original.exact.size);
    for (const [email, rule] of original.exact) {
      const reloadedRule = reloaded.exact.get(email);
      expect(reloadedRule).toBeDefined();
      expect(reloadedRule!.action).toBe(rule.action);
      expect(reloadedRule!.rule_id).toBe(rule.rule_id);
    }

    // Verify regex rules
    expect(reloaded.regex).toHaveLength(original.regex.length);
    for (let i = 0; i < original.regex.length; i++) {
      expect(reloaded.regex[i].rule_id).toBe(original.regex[i].rule_id);
      expect(reloaded.regex[i].pattern).toBe(original.regex[i].pattern);
      expect(reloaded.regex[i].action).toBe(original.regex[i].action);
      expect(reloaded.regex[i].description).toBe(original.regex[i].description);
    }

    // configPath preserved
    expect(reloaded.configPath).toBe(original.configPath);
  });
});

describe('generateRuleId', () => {
  it('produces 8 hex chars', () => {
    const id = generateRuleId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(id).toHaveLength(8);
  });

  it('produces unique ids on successive calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateRuleId());
    }
    expect(ids.size).toBe(100);
  });
});
