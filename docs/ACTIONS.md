# Actions Reference

Complete reference for all 23 actions in the Yahoo Mail MCP Server.

Actions define what happens to an email when a matching rule is applied: which folder to move it to, whether to mark it read, and whether to flag/star it.

---

## Action Properties

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier (lowercase, no spaces) |
| `folder` | string or null | Target IMAP folder. `null` = stays in current folder |
| `mark_read` | boolean | Add `\Seen` flag (mark as read) |
| `flag` | boolean | Add `\Flagged` flag (star) |
| `built_in` | boolean | Hardcoded in source; cannot be removed |

---

## Complete Action Table

Data verified against the live `get_actions` response (2026-03-26).

### Built-In Actions (7)

| Action | Folder | mark_read | flag | important TTL | Notes |
|---|---|---|---|---|---|
| `important` | _(null — stays in INBOX)_ | false | true | 14d (catch-all) | Deprecated as routing target. Still valid as catch-all for senders without a better folder. Use the `important` **modifier** on other actions instead. |
| `doubleclick` | _(null — stays in INBOX)_ | false | false | — | Marks sender as "known" but takes no action on the email. Email stays in INBOX unmodified. |
| `unknown` | _(null — stays in INBOX)_ | false | false | — | Default for unclassified senders. Surfaced to Claude for classification. |
| `invoice` | `invoices` | true | false | 1d | Bills, receipts, payment confirmations, purchase orders. |
| `subscriptions` | `subscriptions` | true | false | — | Mailing lists, newsletters, marketing, promotional. |
| `news` | `news` | true | false | — | News digests, blog updates, aggregator summaries. |
| `delete` | `for-delete` | true | false | — | Junk, spam, unwanted. Staged for review before permanent deletion. |

### Custom Actions (16)

| Action | Folder | mark_read | flag | important TTL | Notes |
|---|---|---|---|---|---|
| `social` | `Social Media` | true | false | — | Social platform notifications (Facebook, Instagram, etc.) |
| `watches` | `Watches` | true | false | — | Watch brand emails, marketing + notifications |
| `bank` | `Banking` | false | false | 1d | Financial institution transactional emails only |
| `amazon` | `Amazon` | false | false | 1d | Amazon order/transactional emails only |
| `hd` | `HomeDepot` | false | false | 1d | Home Depot order/transactional emails |
| `health` | `Health` | false | false | 2d | Medical, health, pharmacy notifications |
| `shipping` | `Shipping` | false | false | 1d | Carrier and order shipping notifications |
| `marriott` | `Marriott` | true | false | 2d | Hotel reservations, stay communications, guest relations |
| `linkedin` | `LinkedIn` | true | false | — | LinkedIn notifications, messages, job alerts |
| `passwords` | `PasswordStuff` | true | false | 7d | Password resets, MFA codes, security notifications |
| `flights` | `Flights and Airlines` | true | false | 3d | Flight confirmations, check-in, gate changes |
| `hermes` | `Hermes` | true | false | 7d | Hermes invitations, purchase communications, access links |
| `telus` | `Telus` | true | false | — | TELUS billing, service notifications |
| `alert` | `Alerts` | false | true | 3d (sweep) | Time-sensitive home/vehicle/security alerts. Swept to `for-delete` at session start after 3d. |
| `bctax` | `BC Tax` | false | true | 30d | BC government tax correspondence |
| `apple` | `Apple` | false | false | 14d | Apple Support, AppleCare communications |

---

## The `important` Modifier

The `important` modifier is a boolean flag on any rule (exact or regex) — it is **not** a standalone action. It controls whether an email is held in INBOX before being routed to its action folder.

### How It Works

When a rule has `important: true`:
1. Email is **flagged** (`\Flagged` / starred) for visibility
2. Email **stays in INBOX** instead of moving to the action folder
3. A **TTL record** is created: `expires_at = now + important_ttl_days`
4. When `process_ttl_expirations` runs and the TTL has expired:
   - Email is **unflagged** and **moved** to the action folder
   - TTL record is pruned

### Default TTL

If `important: true` is set without `important_ttl_days`, the default is **7 days**.

### TTL Values by Action

These values are operational guidance from the runtime prompt (v5), not enforced in code. They are set per-rule when classifying senders.

| Action | TTL | Rationale |
|---|---|---|
| `bank` | 1d | Transactional — review within a day |
| `invoice` | 1d | Receipts — quick confirmation needed |
| `shipping` | 1d | Tracking — time-sensitive |
| `amazon` | 1d | Order confirmations |
| `hd` | 1d | Home Depot orders |
| `flights` | 3d | Travel — check-in windows |
| `marriott` | 2d | Reservations — pre-arrival review |
| `health` | 2d | Medical — moderate urgency |
| `hermes` | 7d | Luxury — invitations need response time |
| `passwords` | 7d | Security — may need follow-up |
| `bctax` | 30d | Government — long response windows |
| `apple` | 14d | Support cases — extended timelines |
| `important` (catch-all) | 14d | General important — no specific folder |
| `alert` | 3d | Time-sensitive — swept to delete after 3d |

---

## Transactional vs Marketing Distinction

Within the same brand, different sender addresses may receive different treatment:

| Brand | Transactional sender → | Marketing sender → |
|---|---|---|
| Amazon | `ship-confirm@amazon.ca` → `amazon`, important: true, 1d | `store-news@amazon.ca` → `subscriptions` (no important) |
| Banks | `alerts@td.com` → `bank`, important: true, 1d | `offers@td.com` → `subscriptions` or `delete` |
| Airlines | `noreply@united.com` (confirmation) → `flights`, important: true, 3d | `deals@united.com` → `subscriptions` |

The key principle: transactional emails get `important: true` with a TTL; marketing emails route directly to their folder without the important modifier.

---

## Adding Custom Actions

Use the `add_action` MCP tool:

```
add_action(name: "travel", folder: "Travel", mark_read: false, flag: true)
```

This:
1. Registers the action in the in-memory action table
2. Persists to `config/custom-actions.json`
3. Creates the IMAP folder if it doesn't exist

Action names must be unique, lowercase, no spaces. Re-adding an existing action is idempotent.

---

## `alert` Action — Special Behaviour

The `alert` action is unique: it routes to the `Alerts` folder with `flag: true` and `mark_read: false`, but stale alerts are **swept to `for-delete`** at session startup.

Session setup procedure:
1. `list_folder_emails("Alerts", before_date: 3 days ago)`
2. Batch-delete in chunks of 20: `apply_action("delete", uids, source_folder: "Alerts")`
3. Repeat until all stale alerts are cleared

This keeps the Alerts folder focused on recent, actionable notifications (Telus SmartHome, vehicle alerts, login codes, etc.).
