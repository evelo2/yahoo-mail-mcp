import { readFileSync, existsSync } from 'node:fs';
import { getConnection } from '../imap/client.js';
import { getActionTable, REQUIRED_FOLDERS } from '../imap/operations.js';
import { getRulesConfigPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

interface CheckResult {
  ok: boolean;
  skipped?: boolean;
  [key: string]: any;
}

interface HealthCheckResult {
  healthy: boolean;
  checks: {
    imap_connect: CheckResult;
    inbox_access: CheckResult;
    required_folders: CheckResult;
    rules_config: CheckResult;
    actions_config: CheckResult;
  };
  errors: Array<{ check: string; message: string }>;
}

export async function handleHealthCheck(): Promise<HealthCheckResult> {
  const errors: Array<{ check: string; message: string }> = [];
  let imapOk = false;
  let client: any = null;

  // ── 1. IMAP connectivity ──
  let imapConnectResult: CheckResult;
  const start = Date.now();
  try {
    client = await getConnection() as any;
    const latency = Date.now() - start;
    imapConnectResult = { ok: true, latency_ms: latency };
    imapOk = true;
  } catch (err) {
    const latency = Date.now() - start;
    imapConnectResult = { ok: false, latency_ms: latency, error: (err as Error).message };
    errors.push({ check: 'imap_connect', message: (err as Error).message });
  }

  // ── 2. Inbox accessibility ──
  let inboxAccessResult: CheckResult;
  if (!imapOk) {
    inboxAccessResult = { ok: false, skipped: true };
  } else {
    try {
      const lock = await client!.getMailboxLock('INBOX');
      let messageCount = 0;
      try {
        const mailbox = client!.mailbox;
        if (mailbox && typeof mailbox === 'object' && 'exists' in mailbox) {
          messageCount = (mailbox as any).exists || 0;
        }
      } finally {
        lock.release();
      }
      inboxAccessResult = { ok: true, message_count: messageCount };
    } catch (err) {
      inboxAccessResult = { ok: false, error: (err as Error).message };
      errors.push({ check: 'inbox_access', message: (err as Error).message });
    }
  }

  // ── 3. Required folders ──
  let requiredFoldersResult: CheckResult;
  if (!imapOk) {
    requiredFoldersResult = { ok: false, skipped: true };
  } else {
    try {
      const builtInFolders = [...REQUIRED_FOLDERS];
      // Include custom action folders
      const actionTable = getActionTable();
      const customFolders = Object.values(actionTable)
        .filter(def => !def.builtIn && def.moveToFolder)
        .map(def => def.moveToFolder!);
      const allRequired = [...new Set([...builtInFolders, ...customFolders])];

      const mailboxes = await client!.list();
      const existingPaths = new Set(mailboxes.map((mb: any) => mb.path.toLowerCase()));

      const present: string[] = [];
      const missing: string[] = [];
      for (const folder of allRequired) {
        if (existingPaths.has(folder.toLowerCase())) {
          present.push(folder);
        } else {
          missing.push(folder);
        }
      }

      requiredFoldersResult = {
        ok: missing.length === 0,
        present,
        missing,
      };
      if (missing.length > 0) {
        errors.push({ check: 'required_folders', message: `Missing folders: ${missing.join(', ')}` });
      }
    } catch (err) {
      requiredFoldersResult = { ok: false, error: (err as Error).message };
      errors.push({ check: 'required_folders', message: (err as Error).message });
    }
  }

  // ── 4. Rules config ──
  let rulesConfigResult: CheckResult;
  const rulesPath = getRulesConfigPath();
  try {
    if (!existsSync(rulesPath)) {
      throw new Error(`File not found: ${rulesPath}`);
    }
    const raw = readFileSync(rulesPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Handle both structured format { exact: {...}, regex: [...] } and legacy flat format
    let totalRules: number;
    if (parsed.exact && typeof parsed.exact === 'object' && !Array.isArray(parsed.exact)) {
      totalRules = Object.keys(parsed.exact).length + (Array.isArray(parsed.regex) ? parsed.regex.length : 0);
    } else {
      totalRules = Object.keys(parsed).length;
    }
    rulesConfigResult = { ok: true, total_rules: totalRules };
  } catch (err) {
    rulesConfigResult = { ok: false, error: (err as Error).message };
    errors.push({ check: 'rules_config', message: (err as Error).message });
  }

  // ── 5. Actions config ──
  let actionsConfigResult: CheckResult;
  try {
    const actionTable = getActionTable();
    const totalActions = Object.keys(actionTable).length;
    actionsConfigResult = { ok: true, total_actions: totalActions };
  } catch (err) {
    actionsConfigResult = { ok: false, error: (err as Error).message };
    errors.push({ check: 'actions_config', message: (err as Error).message });
  }

  // No disconnect — using the shared singleton connection

  const healthy = errors.length === 0;

  logger.info({ healthy, errorCount: errors.length }, 'Health check complete');

  return {
    healthy,
    checks: {
      imap_connect: imapConnectResult,
      inbox_access: inboxAccessResult,
      required_folders: requiredFoldersResult,
      rules_config: rulesConfigResult,
      actions_config: actionsConfigResult,
    },
    errors,
  };
}
