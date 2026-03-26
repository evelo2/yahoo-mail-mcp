import type { SenderRules } from '../rules/config.js';
import { saveSenderRules, getValidActions, generateRuleId } from '../rules/config.js';
import { logger } from '../utils/logger.js';

let rules: SenderRules;

export function initClassifySenders(senderRules: SenderRules) {
  rules = senderRules;
}

interface Classification {
  email_address: string;
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}

interface FailedClassification {
  email_address: string;
  action: string;
  error: string;
}

export async function handleClassifySenders(params: {
  classifications: Classification[];
}): Promise<{ saved: number; failed: FailedClassification[]; total_rules: number }> {
  const validActions = getValidActions();
  const failed: FailedClassification[] = [];
  let saved = 0;

  // Validate all entries first, separate valid from invalid
  const validEntries: { normalized: string; action: string; important?: boolean; important_ttl_days?: number }[] = [];

  for (const entry of params.classifications) {
    const normalized = entry.email_address.toLowerCase();
    const action = entry.action.toLowerCase();

    if (!validActions.has(action)) {
      failed.push({
        email_address: entry.email_address,
        action: entry.action,
        error: `Invalid action: "${action}". Valid actions: ${[...validActions].join(', ')}`,
      });
      continue;
    }

    validEntries.push({
      normalized,
      action,
      important: entry.important,
      important_ttl_days: entry.important_ttl_days,
    });
  }

  // Apply all valid entries (last one wins for duplicates, preserve existing rule_id)
  for (const { normalized, action, important, important_ttl_days } of validEntries) {
    const existing = rules.exact.get(normalized);
    rules.exact.set(normalized, {
      action,
      rule_id: existing?.rule_id ?? generateRuleId(),
      ...(important ? { important: true } : {}),
      ...(important_ttl_days != null ? { important_ttl_days } : {}),
    });
    saved++;
  }

  // Single atomic save for all valid classifications
  if (saved > 0) {
    saveSenderRules(rules);
  }

  const totalRules = rules.exact.size + rules.regex.length;
  logger.info({ saved, failed: failed.length, total: totalRules }, 'Bulk sender classification complete');

  return {
    saved,
    failed,
    total_rules: totalRules,
  };
}
