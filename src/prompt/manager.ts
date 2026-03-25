import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

// ── Types ──

export interface VersionEntry {
  version: number;
  saved_at: string;
  change_summary: string | null;
}

interface PromptMeta {
  current_version: number;
  last_updated: string;
  versions: VersionEntry[];
}

// ── Default prompt ──

const DEFAULT_PROMPT = `# Yahoo Mail Inbox Processing — Runtime Prompt

## Setup

At the start of every session:
1. Call \`health_check\` to verify the server is operational.
2. Call \`get_actions\` to load the current action list.
3. Call \`ensure_folders\` to verify all required folders exist.

## Standard Run Procedure

### Bulk Processing (Known Senders)
1. Call \`process_known_senders\` with the requested date range.
2. Present the results summary and unknown senders to the user.

### Classifying Unknown Senders
- Use from_address, from_name, and subject to suggest an action for each unknown sender.
- Group suggestions where possible and present as a table.
- Once confirmed, call \`classify_senders\` (bulk) to persist all mappings.
- Call \`process_known_senders\` again to action the newly classified emails.

### Adding New Actions
1. Call \`add_action\` to create the action and folder.
2. Classify relevant senders to it.
3. Reprocess.

## Key Rules
- Use \`process_known_senders\` as the primary tool — never manually loop through emails for known senders.
- Use \`classify_senders\` (bulk) not \`classify_sender\` (singular) for multiple new rules.
- Use \`evaluate_regex\` before \`add_regex_rule\` to check for conflicts.
- Keep responses concise — the user does not need to see individual email processing details.
`;

// ── Manager ──

let configDir: string;

function promptPath(): string {
  return join(configDir, 'prompt.md');
}

function metaPath(): string {
  return join(configDir, 'prompt_meta.json');
}

function versionsDir(): string {
  return join(configDir, 'prompt_versions');
}

function versionPath(version: number): string {
  return join(versionsDir(), `v${version}.md`);
}

function loadMeta(): PromptMeta {
  if (!existsSync(metaPath())) {
    return { current_version: 0, last_updated: '', versions: [] };
  }
  return JSON.parse(readFileSync(metaPath(), 'utf-8'));
}

function saveMeta(meta: PromptMeta): void {
  atomicWriteFileSync(metaPath(), JSON.stringify(meta, null, 2) + '\n');
}

function ensureVersionsDir(): void {
  const dir = versionsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Initialize the prompt manager. Call once at startup.
 * Creates prompt.md with default content if it doesn't exist.
 */
export function initPromptManager(dataDir: string): void {
  configDir = dataDir;
  ensureVersionsDir();

  if (!existsSync(promptPath())) {
    // First run: create default prompt as version 1
    const now = new Date().toISOString();
    writeFileSync(promptPath(), DEFAULT_PROMPT, 'utf-8');
    writeFileSync(versionPath(1), DEFAULT_PROMPT, 'utf-8');
    const meta: PromptMeta = {
      current_version: 1,
      last_updated: now,
      versions: [{ version: 1, saved_at: now, change_summary: 'Initial prompt' }],
    };
    saveMeta(meta);
    logger.info({ configDir }, 'Created default prompt.md (version 1)');
  }
}

/**
 * Get the current prompt content and metadata.
 */
export function getPrompt(): {
  content: string;
  version: number;
  last_updated: string;
  total_versions: number;
} {
  const meta = loadMeta();
  const content = readFileSync(promptPath(), 'utf-8');
  return {
    content,
    version: meta.current_version,
    last_updated: meta.last_updated,
    total_versions: meta.versions.length,
  };
}

/**
 * Update the prompt with new content. Saves previous version to history.
 */
export function updatePrompt(
  content: string,
  changeSummary?: string,
): {
  version: number;
  previous_version: number;
  change_summary: string | null;
  saved_at: string;
  total_versions: number;
} {
  const meta = loadMeta();
  const currentContent = readFileSync(promptPath(), 'utf-8');

  if (content === currentContent) {
    throw new Error('No changes detected — prompt not updated');
  }

  const previousVersion = meta.current_version;
  const newVersion = previousVersion + 1;
  const now = new Date().toISOString();

  // Save current content as the previous version file (if not already there)
  ensureVersionsDir();
  if (!existsSync(versionPath(previousVersion))) {
    writeFileSync(versionPath(previousVersion), currentContent, 'utf-8');
  }

  // Write new content (prompt.md is overwritten — use atomic; version file is write-once)
  atomicWriteFileSync(promptPath(), content);
  writeFileSync(versionPath(newVersion), content, 'utf-8');

  // Update meta
  meta.current_version = newVersion;
  meta.last_updated = now;
  meta.versions.push({
    version: newVersion,
    saved_at: now,
    change_summary: changeSummary ?? null,
  });
  saveMeta(meta);

  logger.info({ version: newVersion, changeSummary }, 'Prompt updated');

  return {
    version: newVersion,
    previous_version: previousVersion,
    change_summary: changeSummary ?? null,
    saved_at: now,
    total_versions: meta.versions.length,
  };
}

/**
 * List prompt version history (newest first).
 */
export function listPromptVersions(
  limit: number = 10,
  offset: number = 0,
): {
  current_version: number;
  total_versions: number;
  versions: VersionEntry[];
} {
  const meta = loadMeta();
  // Return newest first
  const reversed = [...meta.versions].reverse();
  const paginated = reversed.slice(offset, offset + limit);
  return {
    current_version: meta.current_version,
    total_versions: meta.versions.length,
    versions: paginated,
  };
}

/**
 * Get a specific version's content.
 */
export function getPromptVersion(version: number): {
  version: number;
  content: string;
  saved_at: string;
  change_summary: string | null;
} {
  const meta = loadMeta();
  const entry = meta.versions.find(v => v.version === version);
  if (!entry) {
    throw new VersionNotFoundError(version, meta.versions.length);
  }

  const filePath = versionPath(version);
  if (!existsSync(filePath)) {
    throw new VersionNotFoundError(version, meta.versions.length);
  }

  const content = readFileSync(filePath, 'utf-8');
  return {
    version: entry.version,
    content,
    saved_at: entry.saved_at,
    change_summary: entry.change_summary,
  };
}

/**
 * Rollback to a previous version. Records the rollback as a new version.
 */
export function rollbackPrompt(
  version: number,
  changeSummary?: string,
): {
  rolled_back_to: number;
  new_version: number;
  change_summary: string;
  saved_at: string;
} {
  const meta = loadMeta();

  if (version === meta.current_version) {
    throw new Error(`Already on version ${version}`);
  }

  const entry = meta.versions.find(v => v.version === version);
  if (!entry) {
    throw new VersionNotFoundError(version, meta.versions.length);
  }

  const filePath = versionPath(version);
  if (!existsSync(filePath)) {
    throw new VersionNotFoundError(version, meta.versions.length);
  }

  const restoredContent = readFileSync(filePath, 'utf-8');
  const summary = changeSummary ?? `Rollback to v${version}`;

  // Save current version before overwriting
  const currentContent = readFileSync(promptPath(), 'utf-8');
  if (!existsSync(versionPath(meta.current_version))) {
    writeFileSync(versionPath(meta.current_version), currentContent, 'utf-8');
  }

  const newVersion = meta.current_version + 1;
  const now = new Date().toISOString();

  // Write restored content (prompt.md is overwritten — use atomic; version file is write-once)
  atomicWriteFileSync(promptPath(), restoredContent);
  writeFileSync(versionPath(newVersion), restoredContent, 'utf-8');

  // Update meta
  meta.current_version = newVersion;
  meta.last_updated = now;
  meta.versions.push({
    version: newVersion,
    saved_at: now,
    change_summary: summary,
  });
  saveMeta(meta);

  logger.info({ rolledBackTo: version, newVersion: newVersion, summary }, 'Prompt rolled back');

  return {
    rolled_back_to: version,
    new_version: newVersion,
    change_summary: summary,
    saved_at: now,
  };
}

// ── Errors ──

export class VersionNotFoundError extends Error {
  public readonly totalVersions: number;
  public readonly requestedVersion: number;

  constructor(version: number, totalVersions: number) {
    super(`Version ${version} not found`);
    this.name = 'VersionNotFoundError';
    this.requestedVersion = version;
    this.totalVersions = totalVersions;
  }
}
