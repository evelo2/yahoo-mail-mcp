import type { SenderRules } from '../rules/config.js';
import { lookupSender } from '../rules/engine.js';
import { getConnection, delay } from '../imap/client.js';
import { applyAction, getActionTable } from '../imap/operations.js';
import { addTtlRecord } from '../utils/ttl-store.js';
import { logger } from '../utils/logger.js';

let rules: SenderRules;

export function initProcessEmail(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleProcessEmail(params: {
  uid: number;
  from_address: string;
  subject?: string;
}) {
  const lookup = lookupSender(rules, params.from_address, params.subject);

  if (!lookup.matched) {
    return {
      uid: params.uid,
      from_address: params.from_address,
      matched: false,
      action: 'unknown',
      operations_performed: [],
      success: true,
    };
  }

  const client = await getConnection();

  // Important-flagged rules/routes: hold in inbox with TTL instead of routing immediately.
  // The email stays in INBOX, is flagged for visibility, and will be routed by
  // process_ttl_expirations once the hold period expires.
  if (lookup.important) {
    const ttlDays = lookup.important_ttl_days ?? 7;
    const arrivedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const actionTable = getActionTable();
    const def = actionTable[lookup.action];

    let flagged = false;
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(String(params.uid) as any, ['\\Flagged'], { uid: true } as any);
      await delay();
      flagged = true;
    } catch (err) {
      logger.error({ uid: params.uid, err }, 'process_email: failed to flag important email');
    } finally {
      lock.release();
    }

    if (flagged) {
      addTtlRecord({
        uid: params.uid,
        action: lookup.action,
        folder: def?.moveToFolder ?? lookup.action,
        arrived_at: arrivedAt,
        expires_at: expiresAt,
      });
    }

    return {
      uid: params.uid,
      from_address: params.from_address,
      matched: true,
      action: lookup.action,
      match_type: lookup.match_type,
      rule_id: lookup.rule_id,
      ...(lookup.route_id ? { route_id: lookup.route_id } : {}),
      ...(lookup.matched_subject_pattern ? { matched_subject_pattern: lookup.matched_subject_pattern } : {}),
      ...(lookup.matched_pattern ? { matched_pattern: lookup.matched_pattern } : {}),
      important: true,
      important_ttl_days: ttlDays,
      operations_performed: flagged ? ['flagged'] : [],
      success: flagged,
    };
  }

  const result = await applyAction(client, params.uid, lookup.action);

  return {
    uid: params.uid,
    from_address: params.from_address,
    matched: true,
    action: lookup.action,
    match_type: lookup.match_type,
    rule_id: lookup.rule_id,
    ...(lookup.route_id ? { route_id: lookup.route_id } : {}),
    ...(lookup.matched_subject_pattern ? { matched_subject_pattern: lookup.matched_subject_pattern } : {}),
    ...(lookup.matched_pattern ? { matched_pattern: lookup.matched_pattern } : {}),
    operations_performed: result.operations_performed,
    success: result.success,
  };
}
