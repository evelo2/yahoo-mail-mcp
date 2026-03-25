import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initPromptManager,
  getPrompt,
  updatePrompt,
  listPromptVersions,
  getPromptVersion,
  rollbackPrompt,
  VersionNotFoundError,
} from '../../src/prompt/manager.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'yahoo-mail-prompt-'));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true }); } catch {}
});

// ── get_prompt ──

describe('get_prompt', () => {
  it('On first run with no prompt.md, creates the default prompt and returns it as version 1', () => {
    initPromptManager(tmpDir);

    const result = getPrompt();
    expect(result.version).toBe(1);
    expect(result.total_versions).toBe(1);
    expect(result.content).toContain('# Yahoo Mail Inbox Processing');
    expect(result.content).toContain('health_check');
    expect(result.last_updated).toEqual(expect.any(String));

    // Files should exist on disk
    expect(existsSync(join(tmpDir, 'prompt.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'prompt_meta.json'))).toBe(true);
    expect(existsSync(join(tmpDir, 'prompt_versions', 'v1.md'))).toBe(true);
  });

  it('Returns current content and correct version metadata', () => {
    initPromptManager(tmpDir);
    updatePrompt('# Updated prompt v2', 'First update');
    updatePrompt('# Updated prompt v3', 'Second update');

    const result = getPrompt();
    expect(result.version).toBe(3);
    expect(result.total_versions).toBe(3);
    expect(result.content).toBe('# Updated prompt v3');
  });

  it('Returns version 1 and total_versions: 1 when only one version exists', () => {
    initPromptManager(tmpDir);

    const result = getPrompt();
    expect(result.version).toBe(1);
    expect(result.total_versions).toBe(1);
  });
});

// ── update_prompt ──

describe('update_prompt', () => {
  beforeEach(() => {
    initPromptManager(tmpDir);
  });

  it('Saves previous version to prompt_versions/v{N}.md before overwriting', () => {
    const originalContent = getPrompt().content;
    updatePrompt('# New content');

    const v1Content = readFileSync(join(tmpDir, 'prompt_versions', 'v1.md'), 'utf-8');
    expect(v1Content).toBe(originalContent);

    const v2Content = readFileSync(join(tmpDir, 'prompt_versions', 'v2.md'), 'utf-8');
    expect(v2Content).toBe('# New content');
  });

  it('Increments version number correctly', () => {
    const r1 = updatePrompt('# V2');
    expect(r1.version).toBe(2);
    expect(r1.previous_version).toBe(1);

    const r2 = updatePrompt('# V3');
    expect(r2.version).toBe(3);
    expect(r2.previous_version).toBe(2);
  });

  it('Stores change_summary in prompt_meta.json', () => {
    updatePrompt('# V2', 'Added classification guidelines');

    const meta = JSON.parse(readFileSync(join(tmpDir, 'prompt_meta.json'), 'utf-8'));
    const v2entry = meta.versions.find((v: any) => v.version === 2);
    expect(v2entry.change_summary).toBe('Added classification guidelines');
  });

  it('Returns error if content is identical to current prompt', () => {
    const currentContent = getPrompt().content;
    expect(() => updatePrompt(currentContent)).toThrow('No changes detected');
  });

  it('prompt.md contains the new content after update', () => {
    updatePrompt('# Brand new content');
    const onDisk = readFileSync(join(tmpDir, 'prompt.md'), 'utf-8');
    expect(onDisk).toBe('# Brand new content');
  });

  it('prompt_meta.json is updated atomically', () => {
    updatePrompt('# V2', 'Update 1');
    updatePrompt('# V3', 'Update 2');

    const meta = JSON.parse(readFileSync(join(tmpDir, 'prompt_meta.json'), 'utf-8'));
    expect(meta.current_version).toBe(3);
    expect(meta.versions).toHaveLength(3);
    expect(meta.versions[2].change_summary).toBe('Update 2');
  });

  it('change_summary defaults to null when not provided', () => {
    const result = updatePrompt('# V2 no summary');
    expect(result.change_summary).toBeNull();
  });
});

// ── list_prompt_versions ──

describe('list_prompt_versions', () => {
  beforeEach(() => {
    initPromptManager(tmpDir);
    updatePrompt('# V2', 'Update 1');
    updatePrompt('# V3', 'Update 2');
    updatePrompt('# V4');
  });

  it('Returns versions in reverse chronological order (newest first)', () => {
    const result = listPromptVersions();
    expect(result.current_version).toBe(4);
    expect(result.total_versions).toBe(4);
    expect(result.versions[0].version).toBe(4);
    expect(result.versions[1].version).toBe(3);
    expect(result.versions[2].version).toBe(2);
    expect(result.versions[3].version).toBe(1);
  });

  it('limit and offset paginate correctly', () => {
    const page1 = listPromptVersions(2, 0);
    expect(page1.versions).toHaveLength(2);
    expect(page1.versions[0].version).toBe(4);
    expect(page1.versions[1].version).toBe(3);

    const page2 = listPromptVersions(2, 2);
    expect(page2.versions).toHaveLength(2);
    expect(page2.versions[0].version).toBe(2);
    expect(page2.versions[1].version).toBe(1);
  });

  it('change_summary is null when not provided', () => {
    const result = listPromptVersions();
    const v4 = result.versions.find(v => v.version === 4);
    expect(v4!.change_summary).toBeNull();
  });
});

// ── get_prompt_version ──

describe('get_prompt_version', () => {
  beforeEach(() => {
    initPromptManager(tmpDir);
    updatePrompt('# Version 2 content', 'V2 update');
    updatePrompt('# Version 3 content', 'V3 update');
  });

  it('Returns correct content for a valid historical version', () => {
    const result = getPromptVersion(1);
    expect(result.version).toBe(1);
    expect(result.content).toContain('# Yahoo Mail Inbox Processing');
    expect(result.change_summary).toBe('Initial prompt');
  });

  it('Returns correct content for version 2', () => {
    const result = getPromptVersion(2);
    expect(result.version).toBe(2);
    expect(result.content).toBe('# Version 2 content');
    expect(result.change_summary).toBe('V2 update');
  });

  it('Returns error for a non-existent version number', () => {
    expect(() => getPromptVersion(99)).toThrow(VersionNotFoundError);
    try {
      getPromptVersion(99);
    } catch (err) {
      expect((err as VersionNotFoundError).totalVersions).toBe(3);
    }
  });

  it('Current version is accessible via get_prompt_version as well as get_prompt', () => {
    const current = getPrompt();
    const viaVersion = getPromptVersion(current.version);
    expect(viaVersion.content).toBe(current.content);
  });
});

// ── rollback_prompt ──

describe('rollback_prompt', () => {
  beforeEach(() => {
    initPromptManager(tmpDir);
    updatePrompt('# Version 2', 'V2');
    updatePrompt('# Version 3', 'V3');
  });

  it('Restores the content of the specified version as the new current prompt', () => {
    const result = rollbackPrompt(1);
    expect(result.rolled_back_to).toBe(1);
    expect(result.new_version).toBe(4);
    expect(result.change_summary).toBe('Rollback to v1');

    const current = getPrompt();
    expect(current.version).toBe(4);
    expect(current.content).toContain('# Yahoo Mail Inbox Processing');
  });

  it('Records the rollback as a new version entry in history', () => {
    rollbackPrompt(2);

    const versions = listPromptVersions();
    expect(versions.total_versions).toBe(4);
    expect(versions.versions[0].version).toBe(4);
    expect(versions.versions[0].change_summary).toBe('Rollback to v2');
  });

  it('Previous versions are not modified or deleted by a rollback', () => {
    rollbackPrompt(1);

    // All previous version files still exist
    expect(existsSync(join(tmpDir, 'prompt_versions', 'v1.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'prompt_versions', 'v2.md'))).toBe(true);
    expect(existsSync(join(tmpDir, 'prompt_versions', 'v3.md'))).toBe(true);

    // Previous version contents unchanged
    const v2 = getPromptVersion(2);
    expect(v2.content).toBe('# Version 2');
  });

  it('Attempting to rollback to the current version returns an error', () => {
    expect(() => rollbackPrompt(3)).toThrow('Already on version 3');
  });

  it('Rollback to a non-existent version returns an appropriate error', () => {
    expect(() => rollbackPrompt(99)).toThrow(VersionNotFoundError);
  });

  it('Custom change_summary overrides the default', () => {
    const result = rollbackPrompt(1, 'Reverting bad changes');
    expect(result.change_summary).toBe('Reverting bad changes');
  });
});

// ── General ──

describe('Prompt management — general', () => {
  it('All version files persist correctly across re-initialization', () => {
    initPromptManager(tmpDir);
    updatePrompt('# V2', 'Update');

    // Re-init (simulating server restart)
    initPromptManager(tmpDir);

    const result = getPrompt();
    expect(result.version).toBe(2);
    expect(result.content).toBe('# V2');
    expect(result.total_versions).toBe(2);

    const v1 = getPromptVersion(1);
    expect(v1.content).toContain('# Yahoo Mail Inbox Processing');
  });

  it('prompt_meta.json and prompt.md are always consistent', () => {
    initPromptManager(tmpDir);
    updatePrompt('# V2');
    updatePrompt('# V3');
    rollbackPrompt(1);

    const meta = JSON.parse(readFileSync(join(tmpDir, 'prompt_meta.json'), 'utf-8'));
    const promptContent = readFileSync(join(tmpDir, 'prompt.md'), 'utf-8');

    expect(meta.current_version).toBe(4);
    expect(promptContent).toContain('# Yahoo Mail Inbox Processing');

    // The version file for current version matches prompt.md
    const currentVersionFile = readFileSync(join(tmpDir, 'prompt_versions', `v${meta.current_version}.md`), 'utf-8');
    expect(currentVersionFile).toBe(promptContent);
  });
});
