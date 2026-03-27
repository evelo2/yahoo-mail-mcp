# Story: `important` as a Boolean Modifier with TTL on Rules

**Date added:** 2026-03-26
**Date actioned:** 2026-03-26
**Status:** Complete (Phase 1)

---

## Preamble

This is a significant architectural change to the rules engine, the action execution pipeline, and the session processing model. It should be treated as a multi-phase implementation with careful data migration.

## Current State

Today, `important` is a standalone action. Emails from classified senders land in the inbox, flagged, and stay there indefinitely. There is no onward routing and no expiry — the only way an important email leaves the inbox is by manual intervention.

There is also a separate `alert` action which uses a folder (Alerts), flags emails, and relies on a manual TTL sweep at the start of each session (3-day threshold). The `alert` action is conceptually a special case of the pattern being formalised here.

## What Changes

`important` stops being a standalone action and becomes a boolean modifier that can be applied to any rule — exact or regex. It works in combination with a TTL (time-to-live) value, also stored on the rule.

### The new flow:

1. An email arrives from a sender whose rule has `important: true` and `important_ttl_days: N`.
2. The email is placed in the inbox, flagged — same as today.
3. A TTL timestamp is recorded against the email (arrival date + N days).
4. At the start of each session, the system checks the inbox for flagged emails past their TTL.
5. Expired emails are moved to the folder defined by their underlying action (e.g. `bank`, `flights`, `bctax`) and unflagged.
6. Emails whose TTL has not yet expired remain in the inbox, flagged, untouched.

### Example:

* `ibanking@ib.example-bank.com` → action: `bank`, important: true, ttl: 7 days → sits flagged in inbox for 7 days, then moves to Banking
* `donotreply@tax.gov.example.ca` → action: `govtax`, important: true, ttl: 30 days → stays visible for 30 days, then archives to Gov Tax
* `notifications@airline.example.com` → action: `flights`, important: false → routes directly to Flights and Airlines immediately, no hold

## Relationship to `alert`

The `alert` action is a precursor to this model — it is `important: true` with a 3-day TTL routing to the Alerts folder, then swept to `for-delete`. Once this feature is implemented, `alert` may be expressible as a regular action with `important: true` and `ttl: 3`, with its expiry destination being `for-delete`. Whether to fully converge `alert` into this model or keep it as a first-class action is an implementation decision left to the developer.

## Relationship to the existing `important` action

The existing standalone `important` action must be retired as part of this change. All senders currently classified as `important` need to be migrated: each must be reclassified to an appropriate underlying action (e.g. `bank`, `flights`, `govtax`) with `important: true` and a sensible default TTL.

## Rules Schema Changes

Current exact rule shape:
```json
{
  "rule_id": "abc123",
  "type": "exact",
  "email_address": "ibanking@ib.example-bank.com",
  "action": "bank"
}
```

New shape (backward compatible — new fields are optional):
```json
{
  "rule_id": "abc123",
  "type": "exact",
  "email_address": "ibanking@ib.example-bank.com",
  "action": "bank",
  "important": true,
  "important_ttl_days": 7
}
```

Same extension applies to regex rules. No breaking change to existing rules that omit the new fields — they default to `important: false`.

## TTL Tracking Store

A new persistent store tracks which inbox emails are being held under the important modifier:

```json
{
  "ttl_records": [
    {
      "uid": 10001,
      "action": "example-action",
      "arrived_at": "2026-01-15T10:00:00.000Z",
      "expires_at": "2026-02-15T10:00:00.000Z",
      "folder": "Example Folder"
    }
  ]
}
```

Key design decisions:
* UID alone is not globally unique across all time (Yahoo IMAP UIDs are per-folder and can be reused). Store `arrived_at` as a secondary check.
* The store is append-only during a session. Cleanup (removing expired records after move) happens during the TTL sweep.
* If an email is manually moved out of the inbox before TTL expiry, the orphan record should be detected and pruned during the sweep.

## TTL Expiry Sweep — `process_ttl_expirations`

New MCP tool and session setup step:

1. Load all records from the TTL tracking store
2. For each record where `expires_at <= now`:
   a. Verify the UID still exists in INBOX
   b. If yes: apply action — move to action folder, unflag
   c. Remove record from store (whether moved or not found)
3. Report: `{ checked, moved, orphaned }`

## Tool Parameter Updates

`classify_sender` / `classify_senders` — add optional fields:
```json
{
  "email_address": "ibanking@ib.example-bank.com",
  "action": "bank",
  "important": true,
  "important_ttl_days": 7
}
```

`add_regex_rule` — add optional fields:
```json
{
  "pattern": "@.*example-bank\\.com$",
  "action": "bank",
  "important": true,
  "important_ttl_days": 7,
  "description": "Example Bank — all addresses, hold 7 days"
}
```

`list_rules` — response includes `important` and `important_ttl_days` where set.

## Default TTL Values (Suggested)

| Action type | Suggested default TTL |
|---|---|
| bank | 7 days |
| govtax, passwords | 30 days |
| flights | 14 days |
| health | 14 days |
| important (legacy, during transition) | 7 days |
| alert (if converged) | 3 days |

## Migration

All senders currently classified as `important` must be reclassified to an appropriate underlying action with `important: true` and a TTL. Migration should be done via the updated `classify_senders` tool after implementation, not by directly editing rules.json.

## Test Cases

1. **New email from important-flagged sender** — held in INBOX, flagged, TTL record written
2. **TTL not yet expired** — email still in INBOX after sweep
3. **TTL expired** — email moved to action folder, unflagged, record removed
4. **Orphan handling** — email manually moved before TTL expiry → record pruned
5. **Regex rule with important modifier** — all matching senders held
6. **Rule without important** — existing behaviour unchanged, no inbox hold
7. **list_rules shows important fields** — visible in response

## Implementation Phases

**Phase 1 — Core mechanics (this story)**
* Rules schema extension (`important`, `important_ttl_days`)
* TTL tracking store
* `process_ttl_expirations` tool
* `process_known_senders` hold-in-inbox behaviour
* Updated tool parameters for `classify_sender/s` and `add_regex_rule`
* Migration of existing `important`-classified senders

**Phase 2 — alert convergence (separate story, optional)**
* Evaluate whether `alert` action should be expressed as a regular action with `important: true`, `ttl: 3`, `expiry_action: delete`
