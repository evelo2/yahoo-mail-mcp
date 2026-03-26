# Story: Investigate Subject-Line Branching for Rules Engine

**Type:** Investigation / Spike
**Priority:** High
**Status:** PENDING
**Created:** 2026-03-26

---

## Problem Statement

Some senders use a single email address for both transactional and promotional
content. The current rules engine resolves sender → action in a flat lookup
(exact match O(1), then regex fallback). There is no mechanism to differentiate
intent when the sender address is the same but the subject line determines
whether the email is, for example, an order confirmation vs. a marketing blast.

**Example:** `orders@bigretailer.com` sends both shipping confirmations
("Your order has shipped") and promotional emails ("50% off everything today!").
Today, both land in the same action — either the transactional one misses
important routing, or the promotional one gets flagged as important.

---

## Current Architecture (Context for Investigation)

### Lookup Flow
```
Email arrives
  → exact sender match (flat JSON object, O(1))
    → if found: apply action, done
  → regex rules (array, iterated in order)
    → if matched: apply action, done
  → no match: action = "unknown"
```

### Rules Config Structure (sender_rules.json)
```json
{
  "rules": {
    "sender@example.com": {
      "action": "subscriptions",
      "important": false
    }
  },
  "regex_rules": [
    {
      "pattern": "@example\\.com$",
      "action": "subscriptions",
      "important": false
    }
  ]
}
```

### Key Constraints
- **Performance is critical.** The system processes emails in batches of 50
  via `process_known_senders`. Subject-line checks must not degrade throughput
  for the ~450 senders that don't need branching.
- **IMAP fetch cost.** `process_known_senders` currently fetches envelope data
  (sender, date, flags, UID). Subject is part of the IMAP envelope, so it may
  already be available — investigate whether `imapflow` includes it in the
  current fetch profile.
- **Flat lookup advantage.** The existing O(1) sender lookup is the performance
  backbone. Any branching mechanism should preserve this for non-branching rules.
- **MCP tool context budget.** Rules are loaded into Claude's context via
  `list_rules` and `lookup_sender`. The data format must remain efficient for
  LLM context consumption.

---

## Investigation Goals

### 1. IMAP Envelope Analysis
- Confirm whether `imapflow`'s current fetch in `process_known_senders` already
  retrieves the subject line (it's part of the RFC 2822 envelope).
- If not, determine the cost of adding it to the fetch profile.
- Document whether subject is available in `list_inbox_emails` and
  `list_folder_emails` responses.

### 2. Branching Architecture Options

Evaluate at least the following three approaches. For each, document: data
structure, lookup complexity, config ergonomics, and migration path.

#### Option A: Inline Subject Branches on Sender Rule
Extend the existing sender rule with an optional `subject_routes` array.
The flat lookup still resolves to the sender first (O(1)), then subject
checks only run for senders that have branches defined.

```json
{
  "sender@example.com": {
    "action": "subscriptions",
    "subject_routes": [
      {
        "contains": ["shipped", "delivered", "tracking"],
        "action": "shipping",
        "important": true,
        "important_ttl_days": 1
      },
      {
        "contains": ["order confirmed", "payment received"],
        "action": "invoice",
        "important": true,
        "important_ttl_days": 1
      }
    ]
  }
}
```
- **Lookup:** O(1) sender → O(k) subject checks (only for branching senders,
  where k = number of subject routes on that sender)
- **Fallback:** If no subject route matches, use the base `action`
- **Pro:** No performance impact on non-branching senders
- **Con:** Investigate whether nested structure complicates `list_rules` output

#### Option B: Separate Subject Rules Table
A second lookup table keyed by sender, containing subject rules.
`process_known_senders` checks the subject table only if the sender appears
in it.

```json
{
  "subject_rules": {
    "sender@example.com": [
      {
        "contains": ["shipped"],
        "action": "shipping",
        "important": true,
        "important_ttl_days": 1
      }
    ]
  }
}
```
- **Lookup:** O(1) check if sender has subject rules → O(k) subject checks
- **Fallback:** Falls through to normal sender rule if no subject match
- **Pro:** Clean separation, doesn't bloat the main rules table
- **Con:** Two lookups, two data structures to maintain

#### Option C: Subject-Aware Regex Rules
Extend regex rules to optionally match on a combined `sender + " | " + subject`
string. Regex rules already iterate, so this adds no new iteration — just a
wider match target.

```json
{
  "regex_rules": [
    {
      "pattern": "^orders@bigretailer\\.com$",
      "subject_pattern": "(shipped|delivered|tracking)",
      "action": "shipping",
      "important": true,
      "important_ttl_days": 1
    }
  ]
}
```
- **Lookup:** Only evaluated during regex phase (after exact match miss or
  when exact match has no subject routes)
- **Pro:** Leverages existing regex infrastructure
- **Con:** Regex iteration is already the slow path; adding subject matching
  here may not help the common case

### 3. Tool Impact Assessment

For each option, assess impact on these MCP tools:
- `classify_sender` / `classify_senders` — how does the tool accept subject
  branch definitions?
- `lookup_sender` — should it return subject branches?
- `list_rules` — how are subject branches displayed? Search implications?
- `process_known_senders` — core processing loop changes
- `process_email` — single-email processing changes
- `remove_rule` — how to remove a single subject branch vs. the whole sender

### 4. Edge Cases to Address
- What happens when a subject matches multiple routes? (First match? Most
  specific? Error?)
- Case sensitivity of subject matching
- Should `contains` support regex, or strictly substring?
- Interaction with `important` modifier — can a subject branch override
  the sender-level `important` setting?
- Can regex rules also have subject branches?
- How does `process_ttl_expirations` interact with subject-branched rules
  that have different TTLs per branch?

### 5. Performance Benchmarking Plan
- Measure current `process_known_senders` throughput (emails/second) as baseline
- Define test: add subject branches to 10, 50, 100 senders and measure impact
- Identify the break-even point where subject scanning becomes a bottleneck
- Consider caching: once a sender+subject is resolved, should the result be
  cached for the batch?

---

## Deliverables

1. **Findings document** answering all investigation goals above
2. **Recommendation** for which option (A, B, C, or hybrid) to implement,
   with rationale
3. **Implementation story** (separate file) with the chosen approach's:
   - Data structure changes
   - Tool API changes (new params, modified responses)
   - Migration plan for existing rules
   - Test plan

---

## Out of Scope

- Actual implementation (this is investigation only)
- Body-content matching (subject only for now)
- Machine learning or NLP-based classification
- Changes to the runtime prompt (will be a separate story post-implementation)

---

## Notes

- The `important` modifier is a boolean on a rule, not a standalone action.
  Subject branches must support `important` and `important_ttl_days` independently
  per branch.
- Option A is the current leading candidate due to its O(1) preservation for
  non-branching senders and clean fallback semantics. The investigation should
  confirm or challenge this.
- Existing rule count: 451 (422 exact, 29 regex). Estimate how many would
  benefit from subject branching to size the feature appropriately.
