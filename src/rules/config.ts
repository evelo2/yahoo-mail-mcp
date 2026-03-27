import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { ConfigError } from '../utils/errors.js';
import { atomicWriteFileSync, rotateBackups } from '../utils/fs.js';
import { getActionTable, registerAction, type ActionDef } from '../imap/operations.js';
import { logger } from '../utils/logger.js';

// safe-regex2 is a CJS module — use createRequire for ESM compat
const require = createRequire(import.meta.url);
const isSafeRegex: (pattern: string) => boolean = require('safe-regex2');

// ── Types ──

export type Action = string;

export interface SubjectRoute {
  route_id: string;
  pattern: string;             // regex pattern, matched with 'i' flag
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}

export interface ExactRule {
  action: string;
  rule_id: string;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: SubjectRoute[];
}

export interface RegexRule {
  rule_id: string;
  pattern: string;
  action: string;
  description?: string;
  important?: boolean;
  important_ttl_days?: number;
}

export interface SenderRules {
  exact: Map<string, ExactRule>;   // keyed by lowercase email
  regex: RegexRule[];              // ordered, first match wins
  configPath: string;
}

// On-disk JSON format
interface SenderRulesJSON {
  exact: Record<string, { action: string; rule_id: string; important?: boolean; important_ttl_days?: number; subject_routes?: SubjectRoute[] }>;
  regex: Array<{ rule_id: string; pattern: string; action: string; description?: string; important?: boolean; important_ttl_days?: number }>;
}

// ── ID generation ──

export function generateRuleId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

// ── Validation ──

export function getValidActions(): Set<string> {
  return new Set(Object.keys(getActionTable()));
}

// ── Load / Save ──

function isNewFormat(parsed: any): parsed is SenderRulesJSON {
  return parsed && typeof parsed.exact === 'object' && !Array.isArray(parsed.exact)
    && typeof Object.values(parsed.exact)[0] !== 'string'
    && (Object.keys(parsed.exact).length === 0 || typeof (Object.values(parsed.exact)[0] as any)?.action === 'string');
}

export function loadSenderRules(configPath: string): SenderRules {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    throw new ConfigError(`Rules config not found at: ${configPath}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse rules config: ${(err as Error).message}`);
  }

  const rules: SenderRules = {
    exact: new Map(),
    regex: [],
    configPath,
  };

  if (isNewFormat(parsed)) {
    // New structured format
    for (const [email, entry] of Object.entries(parsed.exact)) {
      const rule = entry as { action: string; rule_id?: string; important?: boolean; important_ttl_days?: number; subject_routes?: SubjectRoute[] };
      rules.exact.set(email.toLowerCase(), {
        action: rule.action,
        rule_id: rule.rule_id || generateRuleId(),
        ...(rule.important ? { important: true } : {}),
        ...(rule.important_ttl_days != null ? { important_ttl_days: rule.important_ttl_days } : {}),
        ...(rule.subject_routes?.length ? { subject_routes: rule.subject_routes } : {}),
      });
    }
    if (Array.isArray(parsed.regex)) {
      for (const r of parsed.regex) {
        rules.regex.push({
          rule_id: r.rule_id || generateRuleId(),
          pattern: r.pattern,
          action: r.action,
          description: r.description,
          ...(r.important ? { important: true } : {}),
          ...(r.important_ttl_days != null ? { important_ttl_days: r.important_ttl_days } : {}),
        });
      }
    }
  } else {
    // Legacy flat format: Record<string, string>
    logger.info({ configPath }, 'Detected legacy flat rules format — migrating to structured format');

    // Backup before migration
    const backupPath = join(dirname(configPath), 'sender-rules.backup.json');
    try {
      copyFileSync(configPath, backupPath);
      logger.info({ backupPath }, 'Backup of legacy rules saved');
    } catch (err) {
      logger.warn({ err, backupPath }, 'Could not create backup of legacy rules');
    }

    for (const [email, action] of Object.entries(parsed as Record<string, string>)) {
      rules.exact.set(email.toLowerCase(), {
        action: action as string,
        rule_id: generateRuleId(),
      });
    }

    // Save migrated format
    saveSenderRules(rules);
    logger.info({ exactCount: rules.exact.size }, 'Migration complete — rules saved in new format');
  }

  return rules;
}

export function saveSenderRules(rules: SenderRules): void {
  const exactObj: SenderRulesJSON['exact'] = {};
  for (const [email, rule] of rules.exact) {
    exactObj[email] = {
      action: rule.action,
      rule_id: rule.rule_id,
      ...(rule.important ? { important: true } : {}),
      ...(rule.important_ttl_days != null ? { important_ttl_days: rule.important_ttl_days } : {}),
      ...(rule.subject_routes?.length ? { subject_routes: rule.subject_routes } : {}),
    };
  }

  const json: SenderRulesJSON = {
    exact: exactObj,
    regex: rules.regex.map(r => ({
      rule_id: r.rule_id,
      pattern: r.pattern,
      action: r.action,
      ...(r.description ? { description: r.description } : {}),
      ...(r.important ? { important: true } : {}),
      ...(r.important_ttl_days != null ? { important_ttl_days: r.important_ttl_days } : {}),
    })),
  };

  const text = JSON.stringify(json, null, 2) + '\n';
  try {
    rotateBackups(rules.configPath, 5);
    atomicWriteFileSync(rules.configPath, text);
    logger.info({
      exactCount: rules.exact.size,
      regexCount: rules.regex.length,
    }, 'Sender rules saved');
  } catch (err) {
    throw new ConfigError(`Failed to save rules config: ${(err as Error).message}`);
  }
}

// ── Regex rule helpers ──

export function addRegexRule(
  rules: SenderRules,
  pattern: string,
  action: string,
  description?: string,
  options?: { important?: boolean; important_ttl_days?: number },
): RegexRule {
  // Validate regex compiles
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${(err as Error).message}`);
  }

  // Validate regex is safe from catastrophic backtracking (ReDoS)
  if (!isSafeRegex(pattern)) {
    throw new Error(`Unsafe regex pattern (potential ReDoS): "${pattern}". Avoid nested quantifiers like (a+)+ or (a|b)*c*.`);
  }

  // Validate action exists
  const validActions = getValidActions();
  if (!validActions.has(action.toLowerCase())) {
    throw new Error(`Invalid action: "${action}". Valid actions: ${[...validActions].join(', ')}`);
  }

  const rule: RegexRule = {
    rule_id: generateRuleId(),
    pattern,
    action: action.toLowerCase(),
    description,
    ...(options?.important ? { important: true } : {}),
    ...(options?.important_ttl_days != null ? { important_ttl_days: options.important_ttl_days } : {}),
  };

  rules.regex.push(rule);
  saveSenderRules(rules);
  return rule;
}

// ── Unified rule removal ──

export interface RemoveRuleResult {
  removed: boolean;
  rule_id?: string;
  type?: 'exact' | 'regex';
  email_address?: string;
  pattern?: string;
  action?: string;
}

export function removeRule(
  rules: SenderRules,
  identifier: { rule_id?: string; email_address?: string; pattern?: string; route_id?: string },
): RemoveRuleResult {
  // 0. Try route_id first — removes a single subject route, not the whole rule
  if (identifier.route_id) {
    for (const [email, rule] of rules.exact) {
      if (!rule.subject_routes) continue;
      const idx = rule.subject_routes.findIndex(r => r.route_id === identifier.route_id);
      if (idx !== -1) {
        const removed = rule.subject_routes.splice(idx, 1)[0];
        if (rule.subject_routes.length === 0) delete rule.subject_routes;
        saveSenderRules(rules);
        return { removed: true, rule_id: rule.rule_id, type: 'exact', email_address: email, action: removed.action };
      }
    }
  }

  // 1. Try rule_id first (works for both exact and regex)
  if (identifier.rule_id) {
    // Check exact rules
    for (const [email, rule] of rules.exact) {
      if (rule.rule_id === identifier.rule_id) {
        rules.exact.delete(email);
        saveSenderRules(rules);
        return { removed: true, rule_id: rule.rule_id, type: 'exact', email_address: email, action: rule.action };
      }
    }
    // Check regex rules
    const regexIdx = rules.regex.findIndex(r => r.rule_id === identifier.rule_id);
    if (regexIdx !== -1) {
      const removed = rules.regex.splice(regexIdx, 1)[0];
      saveSenderRules(rules);
      return { removed: true, rule_id: removed.rule_id, type: 'regex', pattern: removed.pattern, action: removed.action };
    }
  }

  // 2. Try email_address (exact rules only)
  if (identifier.email_address) {
    const normalized = identifier.email_address.toLowerCase();
    const rule = rules.exact.get(normalized);
    if (rule) {
      rules.exact.delete(normalized);
      saveSenderRules(rules);
      return { removed: true, rule_id: rule.rule_id, type: 'exact', email_address: normalized, action: rule.action };
    }
  }

  // 3. Try pattern (regex rules only)
  if (identifier.pattern) {
    const regexIdx = rules.regex.findIndex(r => r.pattern === identifier.pattern);
    if (regexIdx !== -1) {
      const removed = rules.regex.splice(regexIdx, 1)[0];
      saveSenderRules(rules);
      return { removed: true, rule_id: removed.rule_id, type: 'regex', pattern: removed.pattern, action: removed.action };
    }
  }

  return { removed: false };
}

// ── Subject route helpers ──

export interface AddSubjectRouteResult {
  email_address: string;
  route_id: string;
  pattern: string;
  action: string;
  base_action: string;
  total_routes: number;
  important?: boolean;
  important_ttl_days?: number;
}

function validateSubjectPattern(pattern: string): void {
  if (!pattern || !pattern.trim()) {
    throw new Error('Subject route pattern must be a non-empty string');
  }
  if (pattern === '^.*$' || pattern === '.*') {
    throw new Error('Subject route pattern is too broad. Use a specific pattern that matches meaningful subject content.');
  }
  try {
    new RegExp(pattern);
  } catch (e) {
    throw new Error(`Invalid regex pattern "${pattern}": ${(e as Error).message}`);
  }
}

export function addSubjectRoute(
  rules: SenderRules,
  emailAddress: string,
  route: { pattern: string; action: string; important?: boolean; important_ttl_days?: number },
): AddSubjectRouteResult {
  const normalized = emailAddress.toLowerCase();
  const exactRule = rules.exact.get(normalized);
  if (!exactRule) {
    throw new Error(`No exact rule found for "${emailAddress}". Create a sender rule first with classify_sender.`);
  }

  const action = route.action.toLowerCase();
  const validActions = getValidActions();
  if (!validActions.has(action)) {
    throw new Error(`Invalid action: "${action}". Valid actions: ${[...validActions].join(', ')}`);
  }

  validateSubjectPattern(route.pattern);

  const subjectRoute: SubjectRoute = {
    route_id: generateRuleId(),
    pattern: route.pattern,
    action,
    ...(route.important != null ? { important: route.important } : {}),
    ...(route.important_ttl_days != null ? { important_ttl_days: route.important_ttl_days } : {}),
  };

  if (!exactRule.subject_routes) exactRule.subject_routes = [];
  exactRule.subject_routes.push(subjectRoute);
  saveSenderRules(rules);

  logger.info({ email: normalized, route_id: subjectRoute.route_id, action, pattern: route.pattern }, 'Subject route added');

  return {
    email_address: normalized,
    route_id: subjectRoute.route_id,
    pattern: route.pattern,
    action,
    base_action: exactRule.action,
    total_routes: exactRule.subject_routes.length,
    ...(route.important != null ? { important: route.important } : {}),
    ...(route.important_ttl_days != null ? { important_ttl_days: route.important_ttl_days } : {}),
  };
}

// ── Startup migration: contains[] → pattern ──

/**
 * One-time migration: any subject route written with the old `contains: string[]`
 * format is converted to `pattern: string` (each literal joined with `|`).
 * Idempotent — routes that already have `pattern` are skipped.
 * Returns the number of routes migrated.
 */
export function migrateSubjectRoutesToPattern(rules: SenderRules): number {
  let migrated = 0;
  for (const [, rule] of rules.exact) {
    if (!rule.subject_routes?.length) continue;
    for (const route of rule.subject_routes) {
      const legacy = route as unknown as { contains?: string[] };
      if (!legacy.contains?.length) continue;
      // Escape special regex chars in each literal, join with |
      const escaped = legacy.contains.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      (route as any).pattern = escaped.join('|');
      delete legacy.contains;
      migrated++;
    }
  }
  if (migrated > 0) {
    saveSenderRules(rules);
  }
  return migrated;
}

// ── Custom Actions persistence ──

interface StoredAction {
  folder: string;
  mark_read?: boolean;
  flag?: boolean;
}

export function loadCustomActions(configPath: string): number {
  if (!existsSync(configPath)) return 0;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    logger.warn({ configPath, err }, 'Could not read custom actions file');
    return 0;
  }

  let parsed: Record<string, StoredAction>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`Failed to parse custom actions config: ${(err as Error).message}`);
  }

  let count = 0;
  for (const [name, def] of Object.entries(parsed)) {
    const result = registerAction(name, {
      moveToFolder: def.folder,
      markRead: def.mark_read ?? false,
      flag: def.flag ?? false,
    });
    if (result.created) count++;
  }

  logger.info({ configPath, loaded: count }, 'Custom actions loaded');
  return count;
}

export function saveCustomActions(configPath: string): void {
  const table = getActionTable();
  const custom: Record<string, StoredAction> = {};

  for (const [name, def] of Object.entries(table)) {
    if (def.builtIn) continue;
    custom[name] = {
      folder: def.moveToFolder!,
      mark_read: def.markRead ?? false,
      flag: def.flag ?? false,
    };
  }

  const json = JSON.stringify(custom, null, 2) + '\n';
  try {
    atomicWriteFileSync(configPath, json);
    logger.info({ actionCount: Object.keys(custom).length }, 'Custom actions saved');
  } catch (err) {
    throw new ConfigError(`Failed to save custom actions: ${(err as Error).message}`);
  }
}
