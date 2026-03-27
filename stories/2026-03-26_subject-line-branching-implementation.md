# Story: Implement Subject-Line Branching (Option A — Inline Routes)

**Type:** Feature
**Priority:** High
**Status:** COMPLETE
**Created:** 2026-03-26
**Depends on:** Investigation complete (`docs/investigation-subject-line-branching.md`)

---

## Summary

Add optional `subject_routes` to exact sender rules, enabling different actions
based on email subject keywords. When a sender has subject routes defined,
the engine checks the subject against each route's `contains` keywords (in order,
first match wins) before falling back to the sender's base action.

---

## Data Structure Changes

### `ExactRule` (in `src/rules/config.ts`)

```typescript
interface SubjectRoute {
  route_id: string;
  contains: string[];          // case-insensitive substring matches, OR logic
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}

interface ExactRule {
  action: string;
  rule_id: string;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: SubjectRoute[];  // NEW — optional
}
```

### `LookupResult` (in `src/rules/engine.ts`)

```typescript
interface LookupResult {
  email_address: string;
  action: Action;
  matched: boolean;
  match_type?: 'exact' | 'regex';
  matched_pattern?: string;
  rule_id?: string;
  route_id?: string;              // NEW — present when subject route matched
  important?: boolean;
  important_ttl_days?: number;
}
```

### On-disk format (`config/sender-rules.json`)

```json
{
  "exact": {
    "noreply@store.com": {
      "action": "subscriptions",
      "rule_id": "00000100",
      "subject_routes": [
        {
          "route_id": "00000101",
          "contains": ["shipped", "delivered", "tracking"],
          "action": "shipping",
          "important": true,
          "important_ttl_days": 1
        }
      ]
    }
  }
}
```

---

## Engine Changes

### `lookupSender()` — `src/rules/engine.ts`

Add optional `subject` parameter:

```typescript
export function lookupSender(
  rules: SenderRules,
  emailAddress: string,
  subject?: string,
): LookupResult {
  const normalized = emailAddress.toLowerCase();
  const exactRule = rules.exact.get(normalized);

  if (exactRule) {
    // Check subject routes if subject provided and routes exist
    if (subject && exactRule.subject_routes?.length) {
      const lowerSubject = subject.toLowerCase();
      for (const route of exactRule.subject_routes) {
        if (route.contains.some(kw => lowerSubject.includes(kw.toLowerCase()))) {
          return {
            email_address: emailAddress,
            action: route.action,
            matched: true,
            match_type: 'exact',
            rule_id: exactRule.rule_id,
            route_id: route.route_id,
            ...(route.important != null
              ? { important: route.important, important_ttl_days: route.important_ttl_days ?? 7 }
              : exactRule.important
                ? { important: true, important_ttl_days: exactRule.important_ttl_days ?? 7 }
                : {}),
          };
        }
      }
    }
    // Fallback to base action (unchanged from current code)
    return {
      email_address: emailAddress,
      action: exactRule.action,
      matched: true,
      match_type: 'exact',
      rule_id: exactRule.rule_id,
      ...(exactRule.important
        ? { important: true, important_ttl_days: exactRule.important_ttl_days ?? 7 }
        : {}),
    };
  }

  // Regex and unknown paths — unchanged
  // ...
}
```

**Important modifier inheritance:** If a subject route has `important` explicitly
set, use it. If not set, inherit the sender's base `important` setting. This
lets routes override (e.g., base is `important: true` but a promotional route
sets `important: false`).

---

## Tool API Changes

### Modified Tools

#### 1. `lookup_sender`
- **New optional param:** `subject: string`
- **New response field:** `route_id?: string`
- Backward compatible — omitting `subject` produces identical results

#### 2. `process_known_senders` (internal change only)
- Pass `email.subject` to `lookupSender()` (line 81)
- No schema change — subject is already fetched internally
- Response unchanged (actions_summary will reflect subject-routed actions)

#### 3. `process_email`
- **New optional param:** `subject: string`
- When provided, passed to `lookupSender()` for subject routing
- Backward compatible

#### 4. `classify_sender`
- **New optional param:** `subject_routes: SubjectRoute[]` (without `route_id` — auto-generated)
- When provided, replaces entire `subject_routes` array on the rule
- Omitting `subject_routes` preserves existing routes (no-op, not clear)

#### 5. `classify_senders` (bulk)
- Each classification item can include optional `subject_routes`
- Same semantics as singular version

#### 6. `list_rules`
- Include `subject_routes` in response for rules that have them
- `search` filter matches against `contains` keywords
- No new params needed

#### 7. `remove_rule`
- **New optional param:** `route_id: string`
- When provided, removes only that subject route (not the whole sender rule)
- Existing params (`rule_id`, `email_address`, `pattern`) unchanged

### New Tool

#### `add_subject_route`

Dedicated tool for adding a subject route to an existing sender rule.

**Schema:**
```json
{
  "email_address": "string (required) — sender must have existing exact rule",
  "contains": "string[] (required) — keywords to match in subject (OR logic)",
  "action": "string (required) — must be a valid action",
  "important": "boolean (optional)",
  "important_ttl_days": "number (optional, min 1)"
}
```

**Response:**
```json
{
  "email_address": "noreply@store.com",
  "route_id": "00000101",
  "contains": ["shipped", "tracking"],
  "action": "shipping",
  "base_action": "subscriptions",
  "total_routes": 1
}
```

**Validation:**
- Sender must have an existing exact rule (error if not)
- Action must be valid
- `contains` must be non-empty array of non-empty strings
- Auto-generates `route_id`

---

## Config Persistence Changes

### `saveSenderRules()` — `src/rules/config.ts`

Serialize `subject_routes` when present:

```typescript
exactObj[email] = {
  action: rule.action,
  rule_id: rule.rule_id,
  ...(rule.important ? { important: true } : {}),
  ...(rule.important_ttl_days != null ? { important_ttl_days: rule.important_ttl_days } : {}),
  ...(rule.subject_routes?.length ? { subject_routes: rule.subject_routes } : {}),
};
```

### `loadSenderRules()` — `src/rules/config.ts`

Deserialize `subject_routes` when present:

```typescript
const exactRule: ExactRule = {
  action: data.action,
  rule_id: data.rule_id || generateRuleId(),
  ...(data.important ? { important: true } : {}),
  ...(data.important_ttl_days != null ? { important_ttl_days: data.important_ttl_days } : {}),
  ...(data.subject_routes ? { subject_routes: data.subject_routes } : {}),
};
```

---

## Migration Plan

**No migration required.** The `subject_routes` field is optional. Existing
rules without it work identically to today. The on-disk format is backward
compatible — old versions of the server will ignore the unknown field.

---

## Files to Modify

| File | Change |
|---|---|
| `src/rules/config.ts` | Add `SubjectRoute` type, update `ExactRule`, update save/load |
| `src/rules/engine.ts` | Add `subject` param to `lookupSender()`, add route matching logic |
| `src/tools/process-known-senders.ts` | Pass `email.subject` to `lookupSender()` (1 line) |
| `src/tools/process-email.ts` | Add `subject` param, pass to `lookupSender()` |
| `src/tools/lookup-sender.ts` | Add `subject` param, pass to `lookupSender()` |
| `src/tools/classify-sender.ts` | Accept `subject_routes`, store on rule |
| `src/tools/classify-senders.ts` | Accept `subject_routes` per classification |
| `src/tools/list-rules.ts` | Include `subject_routes` in output, search keywords |
| `src/tools/remove-rule.ts` | Add `route_id` support |
| `src/tools/add-subject-route.ts` | **NEW** — dedicated tool for adding routes |
| `src/server.ts` | Register new tool, update schemas for modified tools |

---

## Test Plan

### Unit Tests

1. **`lookupSender()` without subject** — unchanged behaviour (regression)
2. **`lookupSender()` with subject, no routes** — falls back to base action
3. **`lookupSender()` with subject, matching route** — returns route's action + route_id
4. **`lookupSender()` with subject, no route match** — falls back to base action
5. **First-match-wins** — verify first matching route is selected when multiple match
6. **Case insensitivity** — subject "YOUR ORDER HAS SHIPPED" matches contains: ["shipped"]
7. **Important override** — route with `important: false` overrides sender's `important: true`
8. **Important inheritance** — route without `important` inherits sender's setting

### Integration Tests

9. **`process_known_senders`** — emails from branching sender route to different folders based on subject
10. **`process_email`** — single email with subject routes to correct action
11. **`add_subject_route`** — creates route, persists to disk, visible in `list_rules`
12. **`remove_rule` with `route_id`** — removes single route, leaves sender rule intact
13. **`classify_sender` with `subject_routes`** — stores routes, visible in `lookup_sender`
14. **TTL interaction** — subject route with `important: true` creates correct TTL record

### Edge Cases

15. **Empty subject** — no route matches, falls back to base action
16. **Sender has routes but subject is undefined** — falls back to base action (backward compat)
17. **All routes removed** — `subject_routes` becomes empty array or undefined, base action applies
18. **Route action is invalid** — validation error on add
19. **Concurrent batch processing** — subject routes don't affect batch IMAP operations

---

## Prompt Update (Separate Story)

After implementation, the runtime prompt must be updated via `update_prompt` to
document subject route classification workflow:
- When to suggest subject routes (same sender, different content types)
- How to present subject route options to the user
- How to use `add_subject_route` in the classification flow

This is a separate story to keep implementation and prompt changes atomic.

---

## Estimated Scope

- **Engine + config changes:** ~100 lines
- **Tool modifications:** ~150 lines across 8 files
- **New tool (`add_subject_route`):** ~60 lines
- **Tests:** ~200 lines
- **Total:** ~510 lines

Estimated effort: 1 session.
