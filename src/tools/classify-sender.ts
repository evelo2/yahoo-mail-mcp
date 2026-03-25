import type { SenderRules } from '../rules/config.js';
import { saveSenderRules, getValidActions, generateRuleId } from '../rules/config.js';
import { logger } from '../utils/logger.js';

let rules: SenderRules;

export function initClassifySender(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleClassifySender(params: {
  email_address: string;
  action: string;
}): Promise<{ email_address: string; action: string; rule_id: string; overwritten: boolean; total_rules: number }> {
  const normalized = params.email_address.toLowerCase();
  const action = params.action.toLowerCase();

  const validActions = getValidActions();
  if (!validActions.has(action)) {
    throw new Error(`Invalid action: "${action}". Valid actions: ${[...validActions].join(', ')}`);
  }

  const existing = rules.exact.get(normalized);
  const overwritten = !!existing;
  const rule_id = existing?.rule_id ?? generateRuleId();

  rules.exact.set(normalized, { action, rule_id });
  saveSenderRules(rules);

  logger.info({ email: normalized, action, overwritten, rule_id }, 'Sender classified');

  return {
    email_address: normalized,
    action,
    rule_id,
    overwritten,
    total_rules: rules.exact.size + rules.regex.length,
  };
}
