import type { SenderRules } from '../rules/config.js';
import { addSubjectRoute } from '../rules/config.js';

let rules: SenderRules;

export function initAddSubjectRoute(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleAddSubjectRoute(params: {
  email_address: string;
  pattern: string;
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}) {
  return addSubjectRoute(rules, params.email_address, {
    pattern: params.pattern,
    action: params.action,
    important: params.important,
    important_ttl_days: params.important_ttl_days,
  });
}
