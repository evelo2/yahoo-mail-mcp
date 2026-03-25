import type { SenderRules } from '../rules/config.js';
import { lookupSender } from '../rules/engine.js';

let rules: SenderRules;

export function initLookupSender(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleLookupSender(params: { email_address: string }) {
  return lookupSender(rules, params.email_address);
}
