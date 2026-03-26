import type { SenderRules } from '../rules/config.js';
import { addRegexRule } from '../rules/config.js';

let rules: SenderRules;

export function initAddRegexRule(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleAddRegexRule(params: {
  pattern: string;
  action: string;
  description?: string;
  important?: boolean;
  important_ttl_days?: number;
}) {
  const rule = addRegexRule(
    rules,
    params.pattern,
    params.action,
    params.description,
    { important: params.important, important_ttl_days: params.important_ttl_days },
  );

  return {
    rule_id: rule.rule_id,
    pattern: rule.pattern,
    action: rule.action,
    description: rule.description ?? null,
    total_regex_rules: rules.regex.length,
    total_exact_rules: rules.exact.size,
    ...(rule.important ? { important: true, important_ttl_days: rule.important_ttl_days ?? 7 } : {}),
  };
}
