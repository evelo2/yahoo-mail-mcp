import type { ImapFlow } from 'imapflow';
import { randomUUID } from 'node:crypto';
import { EmailNotFoundError, InvalidActionError } from '../utils/errors.js';
import { delay } from './client.js';
import { logger } from '../utils/logger.js';
import { logAction } from '../utils/audit-log.js';
import type { EmailSummary, EmailDetail, FolderCheckResult, MailboxCounts } from './types.js';
import { MAX_BODY_LENGTH } from '../utils/paths.js';

export const REQUIRED_FOLDERS = ['invoices', 'subscriptions', 'news', 'for-delete'];

function parseAddress(envelope: any): { address: string; name: string } {
  const from = envelope?.from?.[0];
  return {
    address: from ? `${from.address || ''}` : '',
    name: from?.name || '',
  };
}

/**
 * List emails in INBOX. No keyword filtering — everything in INBOX is unprocessed.
 * Only uses standard IMAP SEARCH criteria: SINCE, BEFORE.
 */
export async function listInboxEmails(
  client: ImapFlow,
  options: { limit?: number; sinceDate?: string; beforeDate?: string; excludeUids?: Set<number> } = {}
): Promise<EmailSummary[]> {
  const limit = Math.min(options.limit ?? 10, 50);

  const lock = await client.getMailboxLock('INBOX');
  try {
    // Build search query using only standard IMAP criteria.
    // Merge all conditions into a single object — imapflow does not support { and: [...] }.
    const searchQuery: any = {};

    if (options.sinceDate) searchQuery.since = new Date(options.sinceDate);
    if (options.beforeDate) searchQuery.before = new Date(options.beforeDate);
    if (Object.keys(searchQuery).length === 0) searchQuery.all = true;

    let uids: number[];
    try {
      const results = await client.search(searchQuery, { uid: true });
      uids = Array.from(results as Iterable<number>);
    } catch (err) {
      logger.error({ err }, 'IMAP SEARCH failed');
      uids = [];
    }

    if (uids.length === 0) return [];

    uids.sort((a, b) => b - a);
    // Exclude UIDs already seen (used by looping callers like process_known_senders)
    const filteredUids = options.excludeUids
      ? uids.filter(uid => !options.excludeUids!.has(uid))
      : uids;
    if (filteredUids.length === 0) return [];
    const selectedUids = filteredUids.slice(0, limit);

    const emails: EmailSummary[] = [];
    // Use { uid: true } so imapflow treats the range as UIDs, not sequence numbers
    const uidRange = selectedUids.join(',');
    const messages = client.fetch(uidRange as any, { envelope: true, flags: true, uid: true }, { uid: true } as any);

    for await (const msg of messages) {
      const flags = msg.flags ?? new Set<string>();
      const { address, name } = parseAddress(msg.envelope);
      emails.push({
        uid: msg.uid,
        from_address: address,
        from_name: name,
        subject: msg.envelope?.subject || '',
        date: msg.envelope?.date?.toISOString() || '',
        flags: Array.from(flags),
        labels: [],
      });
    }

    emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return emails.slice(0, limit);
  } finally {
    lock.release();
  }
}

/**
 * List emails from any IMAP folder. Generalised version of listInboxEmails.
 */
export async function listFolderEmails(
  client: ImapFlow,
  folder: string,
  options: {
    limit?: number;
    sinceDate?: string;
    beforeDate?: string;
    sort?: 'date_desc' | 'date_asc';
    includeFlags?: boolean;
  } = {}
): Promise<(EmailSummary & { folder: string })[]> {
  const limit = Math.min(options.limit ?? 10, 50);
  const sort = options.sort ?? 'date_desc';
  const includeFlags = options.includeFlags ?? true;

  let lock: { release: () => void };
  try {
    lock = await client.getMailboxLock(folder);
  } catch (err) {
    throw new Error(`Folder not found: "${folder}"`);
  }

  try {
    const searchQuery: any = {};
    if (options.sinceDate) searchQuery.since = new Date(options.sinceDate);
    if (options.beforeDate) searchQuery.before = new Date(options.beforeDate);
    if (Object.keys(searchQuery).length === 0) searchQuery.all = true;

    let uids: number[];
    try {
      const results = await client.search(searchQuery, { uid: true });
      uids = Array.from(results as Iterable<number>);
    } catch (err) {
      logger.error({ err, folder }, 'IMAP SEARCH failed');
      uids = [];
    }

    if (uids.length === 0) return [];

    // Sort UIDs
    if (sort === 'date_desc') {
      uids.sort((a, b) => b - a);
    } else {
      uids.sort((a, b) => a - b);
    }

    const selectedUids = uids.slice(0, limit);

    const emails: (EmailSummary & { folder: string })[] = [];
    const uidRange = selectedUids.join(',');
    const messages = client.fetch(uidRange as any, { envelope: true, flags: true, uid: true }, { uid: true } as any);

    for await (const msg of messages) {
      const flags = msg.flags ?? new Set<string>();
      const { address, name } = parseAddress(msg.envelope);
      emails.push({
        uid: msg.uid,
        from_address: address,
        from_name: name,
        subject: msg.envelope?.subject || '',
        date: msg.envelope?.date?.toISOString() || '',
        flags: includeFlags ? Array.from(flags) : [],
        labels: [],
        folder,
      });
    }

    // Sort by date
    if (sort === 'date_desc') {
      emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    } else {
      emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    }

    return emails.slice(0, limit);
  } finally {
    lock.release();
  }
}

export async function getEmail(
  client: ImapFlow,
  uid: number,
  includeBody: boolean = false
): Promise<EmailDetail> {
  const lock = await client.getMailboxLock('INBOX');
  try {
    const fetchQuery: any = { envelope: true, flags: true, uid: true };
    if (includeBody) {
      fetchQuery.bodyParts = ['text'];
      fetchQuery.bodyStructure = true;
    }

    // CRITICAL: pass { uid: true } so imapflow uses UID, not sequence number
    const msg = await client.fetchOne(String(uid) as any, fetchQuery, { uid: true } as any);
    if (!msg) {
      throw new EmailNotFoundError(uid);
    }

    const { address, name } = parseAddress(msg.envelope);
    const to = msg.envelope?.to?.[0]?.address || '';
    const flags = msg.flags ?? new Set<string>();

    let bodyPlain: string | undefined;
    if (includeBody && msg.bodyParts) {
      const textPart = msg.bodyParts.get('text');
      if (textPart) {
        bodyPlain = textPart.toString('utf-8').slice(0, MAX_BODY_LENGTH);
      }
    }

    return {
      uid: msg.uid,
      from_address: address,
      from_name: name,
      subject: msg.envelope?.subject || '',
      date: msg.envelope?.date?.toISOString() || '',
      to,
      flags: Array.from(flags),
      labels: [],
      body_plain: bodyPlain,
    };
  } catch (err) {
    if (err instanceof EmailNotFoundError) throw err;
    logger.error({ uid, includeBody, err }, 'get_email failed');
    throw err;
  } finally {
    lock.release();
  }
}

/**
 * Action definitions — folder-only, no custom IMAP keywords.
 * Every action moves the email out of INBOX.
 * Only standard flags used: \Seen, \Flagged
 */
export interface ActionDef {
  markRead?: boolean;
  flag?: boolean;
  moveToFolder?: string;
  builtIn?: boolean;
}

const BUILTIN_ACTIONS: Record<string, ActionDef> = {
  important:     { flag: true, builtIn: true },
  doubleclick:   { builtIn: true },
  unknown:       { builtIn: true },
  invoice:       { markRead: true, moveToFolder: 'invoices', builtIn: true },
  subscriptions: { markRead: true, moveToFolder: 'subscriptions', builtIn: true },
  news:          { markRead: true, moveToFolder: 'news', builtIn: true },
  delete:        { markRead: true, moveToFolder: 'for-delete', builtIn: true },
};

const customActions: Record<string, ActionDef> = {};
let cachedActionTable: Record<string, ActionDef> | null = null;

export function getActionTable(): Record<string, ActionDef> {
  if (!cachedActionTable) {
    cachedActionTable = { ...BUILTIN_ACTIONS, ...customActions };
  }
  return cachedActionTable;
}

function invalidateActionTableCache(): void {
  cachedActionTable = null;
}

export function registerAction(name: string, def: Omit<ActionDef, 'builtIn'>): { created: boolean; existed: boolean } {
  const all = getActionTable();
  if (all[name]) {
    return { created: false, existed: true };
  }
  customActions[name] = { ...def, builtIn: false };
  invalidateActionTableCache();
  return { created: true, existed: false };
}

export function resetCustomActions(): void {
  for (const key of Object.keys(customActions)) {
    delete customActions[key];
  }
  invalidateActionTableCache();
}

/**
 * Apply actions to one or more emails in a single mailbox lock.
 * Groups UIDs by action and executes bulk IMAP operations (flags, moves)
 * using comma-separated UID ranges instead of per-email calls.
 *
 * @param sourceFolder — the folder to operate on (default: 'INBOX').
 *   Emails are flagged/moved FROM this folder.
 */
export async function applyActionsBatch(
  client: ImapFlow,
  items: Array<{ uid: number; action: string }>,
  sourceFolder: string = 'INBOX',
): Promise<{
  applied: number;
  errors: number;
  actions_summary: Record<string, number>;
}> {
  if (items.length === 0) {
    return { applied: 0, errors: 0, actions_summary: {} };
  }

  const table = getActionTable();
  const actionsSummary: Record<string, number> = {};
  let applied = 0;
  let errors = 0;

  // Validate all actions up front
  for (const item of items) {
    if (!table[item.action]) {
      throw new InvalidActionError(item.action, Object.keys(table));
    }
  }

  // Group UIDs by action
  const groups = new Map<string, number[]>();
  for (const item of items) {
    let group = groups.get(item.action);
    if (!group) {
      group = [];
      groups.set(item.action, group);
    }
    group.push(item.uid);
  }

  const batchId = randomUUID().slice(0, 8);
  const lock = await client.getMailboxLock(sourceFolder);
  try {
    for (const [action, uids] of groups) {
      const def = table[action]!;
      const uidRange = uids.join(',');
      const count = uids.length;

      try {
        if (def.markRead) {
          await client.messageFlagsAdd(uidRange as any, ['\\Seen'], { uid: true } as any);
          await delay();
        }

        if (def.flag) {
          await client.messageFlagsAdd(uidRange as any, ['\\Flagged'], { uid: true } as any);
          await delay();
        }

        if (def.moveToFolder) {
          await ensureFolderExists(client, def.moveToFolder);
          await client.messageMove(uidRange as any, def.moveToFolder, { uid: true } as any);
          await delay();
        }

        applied += count;
        actionsSummary[action] = (actionsSummary[action] || 0) + count;
        logger.info({ action, count, uids, sourceFolder }, 'Batch action applied');

        // Audit log
        logAction({ uids, action, source_folder: sourceFolder, count, batch_id: batchId });
      } catch (err) {
        errors += count;
        logger.error({ action, count, uids, sourceFolder, err }, 'Failed to apply batch action');
      }
    }
  } finally {
    lock.release();
  }

  return { applied, errors, actions_summary: actionsSummary };
}

/**
 * Apply a single action to a single email. Validates the email exists,
 * then applies flags/move in a single lock acquisition (no double-lock).
 *
 * @param sourceFolder — the folder containing the email (default: 'INBOX').
 */
export async function applyAction(
  client: ImapFlow,
  uid: number,
  action: string,
  sourceFolder: string = 'INBOX',
): Promise<{ operations_performed: string[]; success: boolean }> {
  const table = getActionTable();
  const def = table[action];
  if (!def) {
    throw new InvalidActionError(action, Object.keys(table));
  }

  // Single lock: verify existence + apply action in one pass
  let lock: { release: () => void };
  try {
    lock = await client.getMailboxLock(sourceFolder);
  } catch (err) {
    if (sourceFolder !== 'INBOX') {
      throw new Error(`Folder not found: "${sourceFolder}"`);
    }
    throw err;
  }

  const operations: string[] = [];
  try {
    // Verify the email exists
    const msg = await client.fetchOne(String(uid) as any, { uid: true }, { uid: true } as any);
    if (!msg) {
      throw new EmailNotFoundError(uid);
    }

    // Apply flags and move within the same lock
    const uidStr = String(uid);
    if (def.markRead) {
      await client.messageFlagsAdd(uidStr as any, ['\\Seen'], { uid: true } as any);
      operations.push('marked_read');
      await delay();
    }
    if (def.flag) {
      await client.messageFlagsAdd(uidStr as any, ['\\Flagged'], { uid: true } as any);
      operations.push('flagged');
      await delay();
    }
    if (def.moveToFolder) {
      await ensureFolderExists(client, def.moveToFolder);
      await client.messageMove(uidStr as any, def.moveToFolder, { uid: true } as any);
      operations.push(`moved_to_${def.moveToFolder}`);
      await delay();
    }

    logger.info({ uid, action, operations, sourceFolder }, 'Action applied');
  } finally {
    lock.release();
  }

  return { operations_performed: operations, success: true };
}

// Cache of folders known to exist — avoids repeated IMAP LIST calls.
// Populated on first call and updated when folders are created.
const knownFolders = new Set<string>();

export function resetKnownFolders(): void {
  knownFolders.clear();
}

export async function ensureFolderExists(client: ImapFlow, folder: string): Promise<boolean> {
  const folderLower = folder.toLowerCase();

  // Fast path: already confirmed to exist
  if (knownFolders.has(folderLower)) {
    return false;
  }

  try {
    // Only do a full LIST if the cache is empty (first call)
    if (knownFolders.size === 0) {
      const list = await client.list();
      for (const mb of list) {
        knownFolders.add((mb as any).path.toLowerCase());
      }
      if (knownFolders.has(folderLower)) {
        return false;
      }
    }

    await client.mailboxCreate(folder);
    knownFolders.add(folderLower);
    logger.info({ folder }, 'Created missing folder');
    return true;
  } catch (err: unknown) {
    const msg = (err as Error).message || '';
    if (msg.includes('already exists') || msg.includes('ALREADYEXISTS')) {
      knownFolders.add(folderLower);
      return false;
    }
    logger.error({ folder, err }, 'Failed to ensure folder exists');
    throw err;
  }
}

export async function ensureFolders(client: ImapFlow): Promise<FolderCheckResult> {
  const existing = await client.list();
  const existingPaths = new Set(existing.map((mb: any) => mb.path.toLowerCase()));

  const result: FolderCheckResult = {
    checked: [...REQUIRED_FOLDERS],
    created: [],
    already_existed: [],
  };

  for (const folder of REQUIRED_FOLDERS) {
    if (existingPaths.has(folder.toLowerCase())) {
      result.already_existed.push(folder);
    } else {
      try {
        await client.mailboxCreate(folder);
        result.created.push(folder);
        logger.info({ folder }, 'Created folder');
      } catch (err: unknown) {
        const msg = (err as Error).message || '';
        if (msg.includes('already exists') || msg.includes('ALREADYEXISTS')) {
          result.already_existed.push(folder);
        } else {
          logger.error({ folder, err }, 'Failed to create folder');
          throw err;
        }
      }
    }
    await delay();
  }

  return result;
}

export async function getMailboxCounts(client: ImapFlow): Promise<MailboxCounts> {
  const lock = await client.getMailboxLock('INBOX');
  let inboxTotal = 0;

  try {
    const mailbox = client.mailbox;
    if (mailbox && typeof mailbox === 'object' && 'exists' in mailbox) {
      inboxTotal = (mailbox as any).exists || 0;
    }
  } finally {
    lock.release();
  }

  const folderCounts: Record<string, number> = {};
  for (const folder of REQUIRED_FOLDERS) {
    try {
      const status = await client.status(folder, { messages: true });
      folderCounts[folder] = (status as any)?.messages || 0;
    } catch {
      folderCounts[folder] = 0;
    }
  }

  return {
    inbox_total: inboxTotal,
    inbox_unprocessed: inboxTotal,
    folder_counts: folderCounts,
  };
}
