import type { SenderRules } from '../rules/config.js';
import { getConnection } from '../imap/client.js';
import { listInboxEmails } from '../imap/operations.js';

let rules: SenderRules;

export function initEvaluateRegex(senderRules: SenderRules) {
  rules = senderRules;
}

interface ExactMatch {
  rule_id: string;
  type: 'exact';
  email_address: string;
  action: string;
  conflict: boolean;
}

interface RegexMatch {
  rule_id: string;
  type: 'regex';
  pattern: string;
  action: string;
  conflict: boolean;
}

interface InboxMatch {
  uid: number;
  from_address: string;
  from_name: string;
  subject: string;
  date: string;
}

export async function handleEvaluateRegex(params: {
  pattern: string;
  action?: string;
  include_inbox_sample?: boolean;
}) {
  // Validate regex
  let re: RegExp;
  try {
    re = new RegExp(params.pattern, 'i');
  } catch (err) {
    return {
      pattern: params.pattern,
      valid: false,
      error: `Invalid regular expression: ${(err as Error).message}`,
    };
  }

  const targetAction = params.action?.toLowerCase();

  // Test against exact rules
  const exactMatches: ExactMatch[] = [];
  for (const [email, rule] of rules.exact) {
    if (re.test(email)) {
      exactMatches.push({
        rule_id: rule.rule_id,
        type: 'exact',
        email_address: email,
        action: rule.action,
        conflict: targetAction ? rule.action !== targetAction : false,
      });
    }
  }

  // Test against existing regex rules (pattern overlap detection)
  const regexMatches: RegexMatch[] = [];
  for (const rule of rules.regex) {
    // Check if patterns could overlap by testing each against the other's pattern string
    // This is a heuristic — true overlap detection is undecidable for general regex
    const otherRe = safeCompile(rule.pattern);
    const patternsOverlap = otherRe
      ? checkPatternOverlap(re, otherRe, [...rules.exact.keys()])
      : false;

    if (patternsOverlap || rule.pattern === params.pattern) {
      regexMatches.push({
        rule_id: rule.rule_id,
        type: 'regex',
        pattern: rule.pattern,
        action: rule.action,
        conflict: targetAction ? rule.action !== targetAction : false,
      });
    }
  }

  // Sort: conflicts first, then alphabetical
  exactMatches.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
    return a.email_address.localeCompare(b.email_address);
  });
  regexMatches.sort((a, b) => {
    if (a.conflict !== b.conflict) return a.conflict ? -1 : 1;
    return a.pattern.localeCompare(b.pattern);
  });

  const conflictCount = exactMatches.filter(m => m.conflict).length
    + regexMatches.filter(m => m.conflict).length;

  // Inbox sample
  let inboxSample: { checked: boolean; total_matches?: number; emails?: InboxMatch[] };
  if (params.include_inbox_sample) {
    const client = await getConnection();
    const emails = await listInboxEmails(client, { limit: 50 });
    const matches: InboxMatch[] = [];
    const seen = new Set<string>();

    for (const email of emails) {
      if (re.test(email.from_address.toLowerCase()) && !seen.has(email.from_address.toLowerCase())) {
        seen.add(email.from_address.toLowerCase());
        matches.push({
          uid: email.uid,
          from_address: email.from_address,
          from_name: email.from_name,
          subject: email.subject,
          date: email.date,
        });
        if (matches.length >= 20) break;
      }
    }

    inboxSample = {
      checked: true,
      total_matches: matches.length,
      emails: matches,
    };
  } else {
    inboxSample = { checked: false };
  }

  return {
    pattern: params.pattern,
    valid: true,
    rule_matches: {
      total: exactMatches.length + regexMatches.length,
      exact_matches: exactMatches,
      regex_matches: regexMatches,
      conflicts: conflictCount,
      conflict_summary: conflictCount > 0
        ? `${conflictCount} existing rule(s) would be shadowed by this pattern but map to a different action`
        : null,
    },
    inbox_sample: inboxSample,
  };
}

function safeCompile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

/**
 * Heuristic overlap check: test both patterns against known email addresses
 * and see if they match any of the same inputs.
 */
function checkPatternOverlap(a: RegExp, b: RegExp, sampleEmails: string[]): boolean {
  for (const email of sampleEmails) {
    if (a.test(email) && b.test(email)) return true;
  }
  return false;
}
