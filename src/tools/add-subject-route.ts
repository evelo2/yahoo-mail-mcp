import type { SenderRules } from '../rules/config.js';
import { addSubjectRoute } from '../rules/config.js';

let rules: SenderRules;

export function initAddSubjectRoute(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleAddSubjectRoute(params: {
  email_address: string;
  contains: string[];
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}) {
  return addSubjectRoute(rules, params.email_address, {
    contains: params.contains,
    action: params.action,
    important: params.important,
    important_ttl_days: params.important_ttl_days,
  });
}
