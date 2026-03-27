import type { SenderRules } from '../rules/config.js';
import { removeRule } from '../rules/config.js';

let rules: SenderRules;

export function initRemoveRule(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleRemoveRule(params: {
  rule_id?: string;
  email_address?: string;
  pattern?: string;
  route_id?: string;
}) {
  if (!params.rule_id && !params.email_address && !params.pattern && !params.route_id) {
    throw new Error('At least one of rule_id, email_address, pattern, or route_id must be provided');
  }

  return removeRule(rules, {
    rule_id: params.rule_id,
    email_address: params.email_address,
    pattern: params.pattern,
    route_id: params.route_id,
  });
}
