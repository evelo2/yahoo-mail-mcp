import type { SenderRules, SubjectRoute } from '../rules/config.js';
import { saveSenderRules, getValidActions, generateRuleId } from '../rules/config.js';
import { logger } from '../utils/logger.js';

let rules: SenderRules;

export function initClassifySender(senderRules: SenderRules) {
  rules = senderRules;
}

export async function handleClassifySender(params: {
  email_address: string;
  action: string;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: Array<{ pattern: string; action: string; important?: boolean; important_ttl_days?: number }>;
}): Promise<{
  email_address: string;
  action: string;
  rule_id: string;
  overwritten: boolean;
  total_rules: number;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: SubjectRoute[];
}> {
  const normalized = params.email_address.toLowerCase();
  const action = params.action.toLowerCase();

  const validActions = getValidActions();
  if (!validActions.has(action)) {
    throw new Error(`Invalid action: "${action}". Valid actions: ${[...validActions].join(', ')}`);
  }

  // Validate subject route actions if provided
  const subjectRoutes: SubjectRoute[] | undefined = params.subject_routes?.map(sr => {
    const srAction = sr.action.toLowerCase();
    if (!validActions.has(srAction)) {
      throw new Error(`Invalid subject route action: "${srAction}". Valid actions: ${[...validActions].join(', ')}`);
    }
    if (!sr.pattern || !sr.pattern.trim()) {
      throw new Error('subject_routes pattern must be a non-empty string');
    }
    if (sr.pattern === '^.*$' || sr.pattern === '.*') {
      throw new Error(`Subject route pattern is too broad: "${sr.pattern}"`);
    }
    try { new RegExp(sr.pattern); } catch (e) {
      throw new Error(`Invalid subject route pattern "${sr.pattern}": ${(e as Error).message}`);
    }
    return {
      route_id: generateRuleId(),
      pattern: sr.pattern,
      action: srAction,
      ...(sr.important != null ? { important: sr.important } : {}),
      ...(sr.important_ttl_days != null ? { important_ttl_days: sr.important_ttl_days } : {}),
    };
  });

  const existing = rules.exact.get(normalized);
  const overwritten = !!existing;
  const rule_id = existing?.rule_id ?? generateRuleId();

  // Preserve existing subject_routes if not explicitly provided
  const existingRoutes = existing?.subject_routes;

  rules.exact.set(normalized, {
    action,
    rule_id,
    ...(params.important ? { important: true } : {}),
    ...(params.important_ttl_days != null ? { important_ttl_days: params.important_ttl_days } : {}),
    ...(subjectRoutes ? { subject_routes: subjectRoutes } : existingRoutes?.length ? { subject_routes: existingRoutes } : {}),
  });
  saveSenderRules(rules);

  const savedRule = rules.exact.get(normalized)!;
  logger.info({ email: normalized, action, overwritten, rule_id, important: params.important, subjectRoutes: savedRule.subject_routes?.length ?? 0 }, 'Sender classified');

  return {
    email_address: normalized,
    action,
    rule_id,
    overwritten,
    total_rules: rules.exact.size + rules.regex.length,
    ...(params.important ? { important: true } : {}),
    ...(params.important_ttl_days != null ? { important_ttl_days: params.important_ttl_days } : {}),
    ...(savedRule.subject_routes?.length ? { subject_routes: savedRule.subject_routes } : {}),
  };
}
