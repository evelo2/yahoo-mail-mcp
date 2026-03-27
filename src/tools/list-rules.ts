import type { SenderRules, SubjectRoute } from '../rules/config.js';

let rules: SenderRules;

export function initListRules(senderRules: SenderRules) {
  rules = senderRules;
}

interface RuleResult {
  type: 'exact' | 'regex';
  rule_id: string;
  action: string;
  email_address?: string;
  pattern?: string;
  description?: string;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: SubjectRoute[];
}

export async function handleListRules(params: {
  action?: string;
  type?: 'exact' | 'regex' | 'all';
  search?: string;
  limit?: number;
  offset?: number;
}) {
  const filterType = params.type ?? 'all';
  const filterAction = params.action?.toLowerCase();
  const search = params.search?.toLowerCase();
  const limit = Math.min(params.limit ?? 100, 500);
  const offset = params.offset ?? 0;

  const results: RuleResult[] = [];

  // Regex rules first (definition order)
  if (filterType === 'all' || filterType === 'regex') {
    for (const rule of rules.regex) {
      if (filterAction && rule.action !== filterAction) continue;
      if (search) {
        const haystack = `${rule.pattern} ${rule.description ?? ''} ${rule.action}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      results.push({
        type: 'regex',
        rule_id: rule.rule_id,
        action: rule.action,
        pattern: rule.pattern,
        description: rule.description,
        ...(rule.important ? { important: true, important_ttl_days: rule.important_ttl_days ?? 7 } : {}),
      });
    }
  }

  // Exact rules (alphabetical by email)
  if (filterType === 'all' || filterType === 'exact') {
    const sortedExact = [...rules.exact.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [email, rule] of sortedExact) {
      if (filterAction && rule.action !== filterAction) {
        // Also check if any subject route matches the action filter
        const hasMatchingRoute = rule.subject_routes?.some(sr => sr.action === filterAction);
        if (!hasMatchingRoute) continue;
      }
      if (search) {
        const routeKeywords = rule.subject_routes?.flatMap(sr => sr.contains).join(' ') ?? '';
        const haystack = `${email} ${rule.action} ${routeKeywords}`.toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      results.push({
        type: 'exact',
        rule_id: rule.rule_id,
        action: rule.action,
        email_address: email,
        ...(rule.important ? { important: true, important_ttl_days: rule.important_ttl_days ?? 7 } : {}),
        ...(rule.subject_routes?.length ? { subject_routes: rule.subject_routes } : {}),
      });
    }
  }

  const total = results.length;
  const paginated = results.slice(offset, offset + limit);

  return {
    total_exact: rules.exact.size,
    total_regex: rules.regex.length,
    total,
    returned: paginated.length,
    offset,
    results: paginated,
  };
}
