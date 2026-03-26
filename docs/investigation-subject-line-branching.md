# Investigation: Subject-Line Branching for Rules Engine

**Date:** 2026-03-26
**Status:** Complete
**Story:** `stories/2026-03-26_subject-line-branching-investigation.md`

---

## 1. IMAP Envelope Analysis

### Subject Is Already Available — Zero Additional Cost

The `imapflow` fetch profile used throughout the server requests `{ envelope: true, flags: true, uid: true }`. The IMAP envelope (RFC 2822) includes the subject line by default.

**Evidence from `src/imap/operations.ts`:**
```typescript
const messages = client.fetch(uidRange, { envelope: true, flags: true, uid: true }, { uid: true });
```

The subject is extracted and returned in every email listing:
```typescript
subject: msg.envelope?.subject || ''
```

**Where subject is already available:**

| Tool / Function | Subject in response? | Field |
|---|---|---|
| `listInboxEmails()` | Yes | `email.subject` |
| `listFolderEmails()` | Yes | `email.subject` |
| `getEmail()` | Yes | `email.subject` |
| `process_known_senders` internal loop | Yes | `email.subject` (from `listInboxEmails`) |
| `UnknownSender` return type | Yes | `subject` field included |

**Conclusion:** Adding subject-based branching requires **zero additional IMAP fetches**. The subject string is already in memory for every email during `process_known_senders` processing at line 81 where `lookupSender()` is called. The only change needed is passing `email.subject` into the lookup function.

---

## 2. Current Rule Inventory

| Metric | Count |
|---|---|
| Exact rules | 422 |
| Regex rules | 29 |
| Total rules | 451 |
| Distinct actions | 23 |

### Domains With Multiple Actions (Subject Branching Candidates)

Analysis of 422 exact rules found **16 domains** where different sender addresses at the same domain route to different actions. Key examples:

| Domain | Actions | Senders | Branching Need |
|---|---|---|---|
| `email.apple.com` | apple, delete, invoice | 4 | Moderate — different addresses, but same-address branching would help for `no_reply@` |
| `marriott.com` | marriott, passwords | 7 | Low — already differentiated by sender address |
| `email-marriott.com` | marriott, subscriptions | 7 | Moderate — transactional vs marketing from same domain |
| `linkedin.com` | linkedin, subscriptions | 4 | Low — different functional addresses |
| `uber.com` | delete, subscriptions | 3 | Low — different addresses |
| `info.telus.com` | subscriptions, telus | 2 | Low — different addresses |

**Estimate of senders that would benefit from subject branching:** ~5-15 senders. The current workaround (separate rules per sender address) works for most domains because brands use distinct `from` addresses for transactional vs marketing. Subject branching is most valuable for:

1. **Senders that genuinely use one address for mixed content** (e.g., `noreply@` addresses at retailers)
2. **Future senders** not yet classified where the pattern emerges
3. **Reducing false positives** on important-flagged rules where only some subjects warrant inbox hold

---

## 3. Architecture Options Analysis

### Option A: Inline Subject Routes on Sender Rule (RECOMMENDED)

**Data structure change to `ExactRule`:**
```typescript
interface ExactRule {
  action: string;
  rule_id: string;
  important?: boolean;
  important_ttl_days?: number;
  subject_routes?: SubjectRoute[];  // NEW
}

interface SubjectRoute {
  route_id: string;            // unique ID for removal
  contains: string[];          // case-insensitive substring matches (OR logic)
  action: string;
  important?: boolean;
  important_ttl_days?: number;
}
```

**Lookup change in `engine.ts`:**
```typescript
function lookupSender(rules, emailAddress, subject?: string): LookupResult {
  const normalized = emailAddress.toLowerCase();
  const exactRule = rules.exact.get(normalized);

  if (exactRule) {
    // NEW: Check subject routes if subject provided and routes exist
    if (subject && exactRule.subject_routes?.length) {
      const normalizedSubject = subject.toLowerCase();
      for (const route of exactRule.subject_routes) {
        if (route.contains.some(kw => normalizedSubject.includes(kw.toLowerCase()))) {
          return {
            email_address: emailAddress,
            action: route.action,
            matched: true,
            match_type: 'exact',
            rule_id: exactRule.rule_id,
            route_id: route.route_id,
            ...(route.important ? { important: true, important_ttl_days: route.important_ttl_days ?? 7 } : {}),
          };
        }
      }
    }
    // Fallback to base action (unchanged)
    return { /* existing exact match return */ };
  }
  // ... regex and unknown paths unchanged
}
```

**Performance analysis:**

| Scenario | Current | With Option A |
|---|---|---|
| Non-branching sender (422 of 422 today) | O(1) Map lookup | O(1) Map lookup — identical |
| Branching sender, k routes | N/A | O(1) + O(k) substring checks |
| No exact match → regex | O(n) iterate regex | O(n) — unchanged |
| Unknown sender | O(1) + O(n) | O(1) + O(n) — unchanged |

For k=3 subject routes (typical), the added cost is 3 `String.includes()` calls per email — negligible. The O(1) Map lookup for all non-branching senders is completely preserved.

**Config ergonomics:**
```json
{
  "noreply@bigretailer.com": {
    "action": "subscriptions",
    "rule_id": "00000100",
    "subject_routes": [
      {
        "route_id": "00000101",
        "contains": ["shipped", "delivered", "tracking", "out for delivery"],
        "action": "shipping",
        "important": true,
        "important_ttl_days": 1
      },
      {
        "route_id": "00000102",
        "contains": ["order confirmed", "payment received", "receipt"],
        "action": "invoice",
        "important": true,
        "important_ttl_days": 1
      }
    ]
  }
}
```

**Migration path:** None required. Existing rules work unchanged. `subject_routes` is optional — absent means current behaviour.

**Verdict:** Cleanest option. Zero impact on non-branching paths. Subject available for free.

---

### Option B: Separate Subject Rules Table

**Data structure:**
```json
{
  "subject_rules": {
    "noreply@bigretailer.com": [
      { "route_id": "...", "contains": ["shipped"], "action": "shipping" }
    ]
  }
}
```

**Lookup change:** After exact match, check `subjectRules.has(normalized)` before returning.

**Performance:** Identical to Option A — one additional `Map.has()` call (O(1)) for every exact match, plus O(k) substring checks only for branching senders.

**Pros:**
- Clean separation of concerns — base rules stay simple
- Could live in a separate JSON file (`subject-rules.json`)

**Cons:**
- **Two data structures to keep in sync.** If an exact rule is removed, orphaned subject rules remain unless a cleanup pass runs.
- **Two files to load/save atomically.** Currently `saveSenderRules()` writes a single atomic file with rotation. Adding a second file doubles the persistence complexity and introduces potential inconsistency on crash.
- **Tool complexity.** `list_rules` must merge data from two sources. `classify_sender` must accept subject routes but store them elsewhere. `remove_rule` must check both files.
- **No meaningful benefit over Option A** since the subject routes are inherently per-sender and logically belong on the sender rule.

**Verdict:** Rejected. All the complexity of Option A plus data consistency problems, with no compensating advantage.

---

### Option C: Subject-Aware Regex Rules

**Data structure:**
```json
{
  "regex_rules": [
    {
      "pattern": "^noreply@bigretailer\\.com$",
      "subject_pattern": "(shipped|delivered|tracking)",
      "action": "shipping",
      "important": true
    }
  ]
}
```

**Lookup change:** During regex iteration, if `subject_pattern` is present, also test against subject.

**Performance analysis — PROBLEMATIC:**

The core issue is that regex rules are the **slow path** (O(n) iteration over 29 rules). Senders that need subject branching are typically known senders with exact rules. Option C forces them into the regex path, which:

1. **Removes them from O(1) exact lookup.** The exact rule must be removed (or produce a miss) for the regex path to evaluate.
2. **Slows the regex path.** Adding sender+subject regex patterns increases n.
3. **Breaks the evaluation model.** Today: exact = fast, regex = fallback for patterns. Option C mixes individual-sender routing into the pattern-matching layer.

A hybrid could work (exact match first, then check regex with subject), but this is just Option A with worse ergonomics — the subject check happens in the regex array instead of inline on the exact rule.

**Verdict:** Rejected. Moves individual senders from O(1) to O(n) path with no benefit.

---

## 4. Tool Impact Assessment (Option A)

### `lookupSender()` / `lookup_sender` tool

**Change:** Add optional `subject` parameter.

```typescript
// Engine function signature change:
lookupSender(rules, emailAddress, subject?: string): LookupResult

// LookupResult addition:
route_id?: string;  // present when subject route matched
```

**MCP tool schema change:**
```json
{
  "email_address": "string (required)",
  "subject": "string (optional) — if provided, evaluates subject routes"
}
```

Response gains optional `route_id` field. Backward compatible — omitting subject produces identical behaviour to today.

### `classify_sender` / `classify_senders`

**Change:** Accept optional `subject_routes` array.

```json
{
  "email_address": "noreply@store.com",
  "action": "subscriptions",
  "subject_routes": [
    {
      "contains": ["shipped", "tracking"],
      "action": "shipping",
      "important": true,
      "important_ttl_days": 1
    }
  ]
}
```

For `classify_senders` (bulk), each classification item can optionally include `subject_routes`. Routes get auto-generated `route_id` values.

**Ergonomics consideration:** Claude typically classifies senders in bulk after reviewing unknowns. Subject routes would be added post-classification when the user identifies a sender that needs branching. A separate `add_subject_route` tool may be cleaner for the common workflow (classify first, add routes later).

### `list_rules`

**Change:** Include `subject_routes` in response for rules that have them.

```json
{
  "type": "exact",
  "rule_id": "00000100",
  "email_address": "noreply@store.com",
  "action": "subscriptions",
  "subject_routes": [
    {
      "route_id": "00000101",
      "contains": ["shipped", "tracking"],
      "action": "shipping",
      "important": true,
      "important_ttl_days": 1
    }
  ]
}
```

**Search:** The `search` filter should also match against `contains` keywords in subject routes.

**Context budget:** For 451 rules, adding subject routes to ~10-15 senders adds minimal token overhead. Each route is ~40 tokens. Even 50 routes across all senders adds ~2K tokens — acceptable.

### `process_known_senders`

**Change:** Pass `email.subject` to `lookupSender()`.

Current code (line 81):
```typescript
const lookup = lookupSender(rules, email.from_address);
```

New code:
```typescript
const lookup = lookupSender(rules, email.from_address, email.subject);
```

Single line change. The subject is already available on the `email` object. All downstream processing (important hold, batch action apply) works unchanged because they operate on the resolved `action` string.

### `process_email`

**Change:** Must also pass subject. Currently only receives `uid` and `from_address`. Two options:

1. **Add `subject` parameter** to the tool schema (optional, for backward compat)
2. **Fetch subject from IMAP** inside the handler using the UID

Option 1 is simpler and avoids an extra IMAP fetch. The caller (Claude) already has the subject from prior listing.

### `remove_rule`

**Change:** Add ability to remove a single subject route.

New parameter: `route_id` (optional). When provided, removes only that subject route from its parent rule instead of removing the entire sender rule.

```typescript
// New identifier option:
{ route_id?: string; rule_id?: string; email_address?: string; pattern?: string }
```

Current `removeRule()` searches by `rule_id`, `email_address`, or `pattern`. Adding `route_id` search is straightforward — iterate exact rules, check `subject_routes` for matching `route_id`, splice it out.

### New Tool: `add_subject_route` (recommended)

A dedicated tool simplifies the workflow:
```json
{
  "email_address": "noreply@store.com",
  "contains": ["shipped", "tracking", "delivered"],
  "action": "shipping",
  "important": true,
  "important_ttl_days": 1
}
```

This is cleaner than overloading `classify_sender` because:
- Subject routes are typically added after initial classification
- The tool can validate that the sender already has an exact rule
- It avoids requiring the caller to re-specify the base action

---

## 5. Edge Cases

### Multiple route matches
**Recommendation:** First match wins (consistent with regex rule behaviour). Routes are evaluated in definition order. Document this clearly.

### Case sensitivity
**Recommendation:** Case-insensitive. Both the subject and `contains` keywords are lowercased before comparison. This is the only sensible default for email subjects.

### Should `contains` support regex?
**Recommendation:** No, strictly substring for v1. Reasons:
- Substring matching is O(m) where m = subject length. Regex compilation + matching is slower.
- `contains` arrays with 3-5 keywords cover the vast majority of use cases
- If regex is needed later, add a `subject_pattern` field as an escape hatch (not in v1)
- Substring is also more LLM-friendly — Claude can reason about keywords more easily than regex patterns

### Important modifier override
**Recommendation:** Subject routes have independent `important` and `important_ttl_days` fields that fully override the sender-level settings. This is the whole point — a promotional email from `noreply@store.com` should NOT be flagged important just because the sender's base rule has `important: true`.

### Regex rules with subject branches
**Recommendation:** Not in v1. Regex rules are the fallback path for pattern matching (domain-wide rules). Subject branching on regex rules would be:
- Rarely needed (regex rules match entire domains, not individual senders)
- Complex to implement (regex match + subject check = two-dimensional matching)
- Confusing to configure

If needed later, the same `subject_routes` structure could be added to `RegexRule`.

### TTL interaction
**Recommendation:** Each subject route has its own `important` / `important_ttl_days`. The `process_ttl_expirations` logic is unaffected — it operates on TTL records which already store the resolved `action` and `folder`. It doesn't need to re-evaluate subject routes at expiry time.

---

## 6. Performance Assessment

### Baseline
`process_known_senders` processes emails in batches of 50 with a max of 20 batches (1000 emails). The bottleneck is IMAP I/O (fetch, flag, move), not rule lookup. Rule lookup is in-memory and takes microseconds per email.

### Added cost for subject branching
For a sender with k subject routes:
- k calls to `String.prototype.includes()` per route keyword
- Each keyword check is O(m) where m = subject length (~50-100 chars typical)
- For k=5 routes with 3 keywords each = 15 substring checks = ~microseconds

### Projected impact
| Branching senders | Added time per 50-email batch | % overhead |
|---|---|---|
| 0 | 0 | 0% |
| 10 | ~50μs | <0.001% |
| 50 | ~250μs | <0.01% |
| 100 | ~500μs | <0.01% |

**IMAP operations per batch** (flag, move, lock) take 100-500ms. Subject branching overhead is **unmeasurable** relative to IMAP I/O.

### Caching
Not needed. The computation is trivially cheap and operates on already-fetched data. A sender+subject cache would add complexity (cache invalidation when routes change) for zero measurable benefit.

### Formal benchmarking
Not recommended for this feature. The added computation is pure in-memory string matching, orders of magnitude faster than the IMAP operations that dominate processing time. A benchmark would show noise, not signal.

---

## 7. Recommendation

### Implement Option A: Inline Subject Routes on Sender Rule

**Rationale:**
1. **Zero IMAP cost.** Subject is already fetched.
2. **Zero impact on non-branching senders.** O(1) exact lookup unchanged.
3. **Minimal code change.** One parameter added to `lookupSender()`, one line changed in `process_known_senders`.
4. **Clean data model.** Subject routes live on the sender rule — no sync issues, single atomic save.
5. **Backward compatible.** `subject_routes` is optional. All existing rules and tools work unchanged.
6. **Right-sized.** ~5-15 senders need this today. The feature should be simple and targeted, not a general-purpose rule engine overhaul.

**Rejected alternatives:**
- **Option B (separate table):** Same performance, worse data consistency, more tool complexity.
- **Option C (regex subject):** Moves senders from O(1) to O(n) path. Wrong architectural layer.

---

## 8. Implementation Story

See: `stories/2026-03-26_subject-line-branching-implementation.md`
