import { getConnection } from '../imap/client.js';
import { applyActionsBatch, listInboxEmails } from '../imap/operations.js';
import { getExpiredRecords, removeTtlRecords } from '../utils/ttl-store.js';
import { logger } from '../utils/logger.js';

export async function handleProcessTtlExpirations(): Promise<{
  checked: number;
  moved: number;
  orphaned: number;
}> {
  const expired = getExpiredRecords();

  if (expired.length === 0) {
    return { checked: 0, moved: 0, orphaned: 0 };
  }

  const client = await getConnection();

  // Get current inbox UIDs to check which expired records still exist
  const inboxEmails = await listInboxEmails(client, { limit: 50 });
  const inboxUids = new Set(inboxEmails.map(e => e.uid));

  // For larger inboxes, we may need multiple fetches. But for TTL sweep
  // we're only checking specific UIDs, so let's just check against what we have.
  // If the UID exists in inbox, it's still there. If not, it's an orphan.

  const toMove: Array<{ uid: number; action: string }> = [];
  const orphanUids: number[] = [];

  for (const record of expired) {
    if (inboxUids.has(record.uid)) {
      toMove.push({ uid: record.uid, action: record.action });
    } else {
      orphanUids.push(record.uid);
    }
  }

  let moved = 0;

  // Apply actions to move expired emails to their destination folders
  if (toMove.length > 0) {
    // First unflag the emails (remove \Flagged) before moving
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uidRange = toMove.map(t => t.uid).join(',');
      await client.messageFlagsRemove(uidRange as any, ['\\Flagged'], { uid: true } as any);
    } catch (err) {
      logger.warn({ err }, 'Failed to remove flags from expired important emails');
    } finally {
      lock.release();
    }

    // Now batch-move to their action folders
    const result = await applyActionsBatch(client, toMove);
    moved = result.applied;
  }

  // Remove all expired records from the store (both moved and orphaned)
  const allExpiredUids = expired.map(r => r.uid);
  removeTtlRecords(allExpiredUids);

  logger.info({
    checked: expired.length,
    moved,
    orphaned: orphanUids.length,
  }, 'TTL expiry sweep complete');

  return {
    checked: expired.length,
    moved,
    orphaned: orphanUids.length,
  };
}
