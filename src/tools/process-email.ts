import type { SenderRules } from '../rules/config.js';
import { lookupSender } from '../rules/engine.js';
import { getConnection } from '../imap/client.js';
import { applyAction } from '../imap/operations.js';

let rules: SenderRules;

export function initProcessEmail(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleProcessEmail(params: {
  uid: number;
  from_address: string;
}) {
  const lookup = lookupSender(rules, params.from_address);

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
  const result = await applyAction(client, params.uid, lookup.action);

  return {
    uid: params.uid,
    from_address: params.from_address,
    matched: true,
    action: lookup.action,
    match_type: lookup.match_type,
    rule_id: lookup.rule_id,
    ...(lookup.matched_pattern ? { matched_pattern: lookup.matched_pattern } : {}),
    operations_performed: result.operations_performed,
    success: result.success,
  };
}
