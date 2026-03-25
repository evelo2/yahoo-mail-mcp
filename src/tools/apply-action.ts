import { getConnection } from '../imap/client.js';
import { applyAction, applyActionsBatch, getActionTable } from '../imap/operations.js';

export async function handleApplyAction(params: {
  uid: number | number[];
  action: string;
  source_folder?: string;
}) {
  const client = await getConnection();
  const sourceFolder = params.source_folder ?? 'INBOX';

  // Single UID — existing behaviour with fetchOne validation
  if (typeof params.uid === 'number') {
    const result = await applyAction(client, params.uid, params.action, sourceFolder);
    return {
      uid: params.uid,
      action: params.action,
      ...(params.source_folder ? { source_folder: params.source_folder } : {}),
      ...result,
    };
  }

  // Batch UIDs — use the batch path directly
  const uids: number[] = params.uid;
  const items = uids.map((uid: number) => ({ uid, action: params.action }));
  const batchResult = await applyActionsBatch(client, items, sourceFolder);

  // Build per-UID results
  const def = getActionTable()[params.action];
  const operations: string[] = [];
  if (def?.markRead) operations.push('marked_read');
  if (def?.flag) operations.push('flagged');
  if (def?.moveToFolder) operations.push(`moved_to_${def.moveToFolder}`);

  const results = uids.map((uid: number) => ({
    uid,
    success: true,
    operations_performed: [...operations],
  }));

  // If the batch had errors, mark trailing UIDs as failed
  if (batchResult.errors > 0) {
    const failCount = batchResult.errors;
    for (let i = results.length - failCount; i < results.length; i++) {
      if (i >= 0) {
        results[i].success = false;
        results[i].operations_performed = [];
      }
    }
  }

  return {
    action: params.action,
    ...(params.source_folder ? { source_folder: params.source_folder } : {}),
    success_count: batchResult.applied,
    error_count: batchResult.errors,
    results,
  };
}
