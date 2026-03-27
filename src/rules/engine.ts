import type { Action, SenderRules } from './config.js';
import { logger } from '../utils/logger.js';

export interface LookupResult {
  email_address: string;
  action: Action;
  matched: boolean;
  match_type?: 'exact' | 'regex';
  matched_pattern?: string;
  rule_id?: string;
  route_id?: string;
  important?: boolean;
  important_ttl_days?: number;
}

// Cache compiled RegExp objects to avoid recompilation on every lookup.
// Capped at 500 entries — evict oldest on overflow.
const MAX_REGEX_CACHE_SIZE = 500;
const regexCache = new Map<string, RegExp | null>(); // null = invalid pattern

function getCompiledRegex(pattern: string): RegExp | null {
  if (regexCache.has(pattern)) return regexCache.get(pattern)!;
  try {
    const re = new RegExp(pattern, 'i');
    if (regexCache.size >= MAX_REGEX_CACHE_SIZE) {
      // Evict oldest entry (first key in Map iteration order)
      const oldest = regexCache.keys().next().value;
      if (oldest !== undefined) regexCache.delete(oldest);
    }
    regexCache.set(pattern, re);
    return re;
  } catch (err) {
    logger.warn({ pattern, err }, 'Invalid regex pattern in rules — skipping');
    regexCache.set(pattern, null);
    return null;
  }
}

export function clearRegexCache(): void {
  regexCache.clear();
}

export function lookupSender(rules: SenderRules, emailAddress: string, subject?: string): LookupResult {
  const normalized = emailAddress.toLowerCase();

  // 1. Exact match takes priority
  const exactRule = rules.exact.get(normalized);
  if (exactRule) {
    // 1a. Check subject routes if subject provided and routes exist (first match wins)
    if (subject && exactRule.subject_routes?.length) {
      const lowerSubject = subject.toLowerCase();
      for (const route of exactRule.subject_routes) {
        if (route.contains.some(kw => lowerSubject.includes(kw.toLowerCase()))) {
          // Subject route can override or inherit the sender-level important setting
          const important = route.important ?? exactRule.important;
          const ttlDays = route.important_ttl_days ?? (route.important != null ? 7 : exactRule.important_ttl_days ?? 7);
          return {
            email_address: emailAddress,
            action: route.action,
            matched: true,
            match_type: 'exact',
            rule_id: exactRule.rule_id,
            route_id: route.route_id,
            ...(important ? { important: true, important_ttl_days: ttlDays } : {}),
          };
        }
      }
    }
    // 1b. No subject route matched — use base action
    return {
      email_address: emailAddress,
      action: exactRule.action,
      matched: true,
      match_type: 'exact',
      rule_id: exactRule.rule_id,
      ...(exactRule.important ? { important: true, important_ttl_days: exactRule.important_ttl_days ?? 7 } : {}),
    };
  }

  // 2. Regex rules — first match wins
  for (const rule of rules.regex) {
    const re = getCompiledRegex(rule.pattern);
    if (re && re.test(normalized)) {
      return {
        email_address: emailAddress,
        action: rule.action,
        matched: true,
        match_type: 'regex',
        matched_pattern: rule.pattern,
        rule_id: rule.rule_id,
        ...(rule.important ? { important: true, important_ttl_days: rule.important_ttl_days ?? 7 } : {}),
      };
    }
  }

  // 3. No match
  return { email_address: emailAddress, action: 'unknown', matched: false };
}
