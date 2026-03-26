# MCP Tools Reference

This document covers all 24 MCP-exposed tools: their parameters, internal flow logic, return types, and error conditions.

All tools return JSON via `{ content: [{ type: "text", text: "<json>" }] }`. On error, responses include `isError: true` with a `{ success: false, error: "<message>" }` payload.

---

## Table of Contents

- [Email Operations](#email-operations)
  - [list_inbox_emails](#list_inbox_emails)
  - [get_email](#get_email)
  - [apply_action](#apply_action)
  - [process_email](#process_email)
  - [process_known_senders](#process_known_senders)
  - [list_folder_emails](#list_folder_emails)
- [Sender Classification](#sender-classification)
  - [lookup_sender](#lookup_sender)
  - [classify_sender](#classify_sender)
  - [classify_senders](#classify_senders)
- [Rule Management](#rule-management)
  - [add_regex_rule](#add_regex_rule)
  - [remove_rule](#remove_rule)
  - [list_rules](#list_rules)
  - [evaluate_regex](#evaluate_regex)
- [Action Management](#action-management)
  - [add_action](#add_action)
  - [get_actions](#get_actions)
- [System Operations](#system-operations)
  - [ensure_folders](#ensure_folders)
  - [get_run_summary](#get_run_summary)
  - [health_check](#health_check)
- [TTL Management](#ttl-management)
  - [process_ttl_expirations](#process_ttl_expirations)
- [Prompt Management](#prompt-management)
  - [get_prompt](#get_prompt)
  - [update_prompt](#update_prompt)
  - [list_prompt_versions](#list_prompt_versions)
  - [get_prompt_version](#get_prompt_version)
  - [rollback_prompt](#rollback_prompt)

---

## Email Operations

### `list_inbox_emails`

List emails in the INBOX that have not been processed (triaged). Returns envelope data only (no body content).

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `limit` | `number` | No | `10` | Max emails to return. Range: 1-50. |
| `since_date` | `string` | No | — | ISO 8601 date. Only return emails received on or after this date. |
| `before_date` | `string` | No | — | ISO 8601 date. Only return emails received before this date. |

#### Flow Logic

```
1. Acquire INBOX mailbox lock
2. Build IMAP SEARCH query:
   - No date filters → { all: true }
   - One filter → { since: Date } or { before: Date }
   - Both filters → { and: [{ since: Date }, { before: Date }] }
3. Execute IMAP SEARCH (UID mode)
4. Sort UIDs descending (newest first)
5. Select top N UIDs (where N = limit)
6. FETCH envelope + flags for selected UIDs
7. Sort results by date descending
8. Release lock
9. Return array of email summaries
```

#### Response

```json
[
  {
    "uid": 12345,
    "from_address": "sender@example.com",
    "from_name": "Jane Doe",
    "subject": "Meeting tomorrow",
    "date": "2025-03-15T10:30:00.000Z",
    "flags": ["\\Seen"],
    "labels": []
  }
]
```

#### Errors

- IMAP SEARCH failure: returns empty array (logged, not thrown)
- IMAP connection failure: throws `ImapConnectionError`

---

### `get_email`

Fetch a single email by UID with full details, optionally including the plain text body.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `uid` | `number` | Yes | — | The email UID to fetch. |
| `include_body` | `boolean` | No | `false` | Whether to include the plain text body. |

#### Flow Logic

```
1. Acquire INBOX mailbox lock
2. Build fetch query:
   - Always: envelope, flags, uid
   - If include_body: add bodyParts['text'] and bodyStructure
3. FETCH ONE by UID (uid: true mode)
4. If not found → throw EmailNotFoundError
5. Extract envelope fields (from, to, subject, date)
6. If include_body and bodyParts exist:
   - Extract 'text' part
   - Decode as UTF-8
   - Truncate to 2000 characters
7. Release lock
8. Return email detail
```

#### Response

```json
{
  "uid": 12345,
  "from_address": "sender@example.com",
  "from_name": "Jane Doe",
  "subject": "Meeting tomorrow",
  "date": "2025-03-15T10:30:00.000Z",
  "to": "you@yahoo.com",
  "flags": [],
  "labels": [],
  "body_plain": "Hi, just wanted to confirm..."
}
```

`body_plain` is only present when `include_body` is `true` and the email has a text part. Maximum 2000 characters.

#### Errors

| Error | Condition |
|---|---|
| `EmailNotFoundError` | UID does not exist in INBOX |
| `ImapConnectionError` | IMAP connection lost |

---

### `apply_action`

Apply a rule action to one or more emails. Pass a single `uid` (number) or an array of UIDs for batch processing. Works on emails in any folder via `source_folder`.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `uid` | `number` or `number[]` | Yes | — | The email UID, or an array of UIDs to process in batch. |
| `action` | `string` | Yes | — | Action name (built-in or custom). |
| `source_folder` | `string` | No | `"INBOX"` | The folder containing the email(s). Use for emails already filed in other folders. |

#### Flow Logic

**Single UID:**
```
1. Look up action definition from the action table
2. If action not found → throw InvalidActionError
3. Acquire source_folder mailbox lock
4. FETCH ONE by UID to verify email exists
5. If not found → throw EmailNotFoundError
6. Delegate to applyActionsBatch (1-item batch)
7. Return single-UID response shape
```

**Batch UIDs (array):**
```
1. Validate action exists
2. Build items array: all UIDs × same action
3. Call applyActionsBatch(client, items, source_folder)
   - Single lock acquisition, bulk flag/move ops
4. Return batch response shape with per-UID results
```

Actions without a `moveToFolder` (e.g., `important`, `doubleclick`, `unknown`) leave emails in their current folder. Only flag/markRead operations are applied.

#### Response (single UID)

```json
{
  "uid": 12345,
  "action": "subscriptions",
  "operations_performed": ["marked_read", "moved_to_subscriptions"],
  "success": true
}
```

#### Response (batch UIDs)

```json
{
  "action": "delete",
  "source_folder": "Telus",
  "success_count": 3,
  "error_count": 0,
  "results": [
    { "uid": 100, "success": true, "operations_performed": ["marked_read", "moved_to_for-delete"] },
    { "uid": 101, "success": true, "operations_performed": ["marked_read", "moved_to_for-delete"] },
    { "uid": 102, "success": true, "operations_performed": ["marked_read", "moved_to_for-delete"] }
  ]
}
```

Possible operations: `marked_read`, `flagged`, `moved_to_{folder_name}`. Actions without a target folder return an empty operations array.

#### Errors

| Error | Condition |
|---|---|
| `InvalidActionError` | Action name not in action table |
| `EmailNotFoundError` | UID does not exist in source folder (single-UID mode only) |

---

### `process_email`

Combined convenience tool: looks up the sender in the rules, then applies the matching action if found.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `uid` | `number` | Yes | The email UID. |
| `from_address` | `string` | Yes | The sender email address. |

#### Flow Logic

```
1. Call lookupSender(from_address)
2. If matched == false:
   - Return immediately with action: "unknown", no operations
3. If matched == true:
   - Call applyAction(uid, matched_action)
   - Return combined result with operations from applyAction
```

#### Response (known sender — exact match)

```json
{
  "uid": 12345,
  "from_address": "newsletter@example.com",
  "matched": true,
  "action": "subscriptions",
  "match_type": "exact",
  "rule_id": "a1b2c3d4",
  "operations_performed": ["marked_read", "moved_to_subscriptions"],
  "success": true
}
```

#### Response (known sender — regex match)

```json
{
  "uid": 12345,
  "from_address": "promo@marketing.example.com",
  "matched": true,
  "action": "subscriptions",
  "match_type": "regex",
  "rule_id": "e5f6a7b8",
  "matched_pattern": "@marketing\\.example\\.com$",
  "operations_performed": ["marked_read", "moved_to_subscriptions"],
  "success": true
}
```

#### Response (unknown sender)

```json
{
  "uid": 12345,
  "from_address": "new-sender@example.com",
  "matched": false,
  "action": "unknown",
  "operations_performed": [],
  "success": true
}
```

Note: unknown senders are **not** moved or modified. They stay in INBOX. The `match_type`, `rule_id`, and `matched_pattern` fields are only present when the sender is matched.

---

### `process_known_senders`

Batch process the entire inbox. Loops through emails in batches, applies actions for all known senders, and collects up to 50 unique unknown senders for classification.

This is the primary workhorse tool for inbox triage.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `since_date` | `string` | No | — | ISO date. Only process emails received on or after this date. |
| `before_date` | `string` | No | — | ISO date. Only process emails received before this date. |
| `actions_filter` | `string[]` | No | — | Only process known senders whose action matches one of these. Omit to process all. |

#### Flow Logic

```
Constants:
  BATCH_SIZE = 50      (emails per IMAP fetch)
  UNKNOWN_LIMIT = 50   (max unique unknown senders to collect)
  MAX_BATCHES = 20     (safety cap: 1000 emails max)

1. Initialize tracking:
   - unknownAddresses: Map<string, UnknownSender>  (dedup by address)
   - seenUids: Set<number>                          (prevent refetching)
   - actionsSummary: Record<string, number>          (action → count)

2. LOOP while unknownAddresses.size < 50 AND batches < 20:
   a. Fetch up to 50 emails from INBOX
      - Apply since_date/before_date filters
      - Exclude seenUids from results
   b. If no emails returned → break (inbox exhausted)
   c. Increment batch counter

   d. FOR EACH email in batch:
      i.   Add UID to seenUids
      ii.  Look up sender in rules
      iii. If NOT matched (unknown):
           - Normalize address to lowercase
           - If not already in unknownAddresses map:
             add { uid, from_address, from_name, subject }
           - Continue to next email
      iv.  If matched AND actions_filter is set:
           - If action NOT in filter → increment filtered_out, continue
      v.   Apply action to email
           - On success: increment known_processed, update actionsSummary
           - On error: increment error count, log, continue

3. Return summary with unknown_senders list
```

#### Response

```json
{
  "total_fetched": 150,
  "known_processed": 87,
  "known_filtered_out": 12,
  "unknown_skipped": 38,
  "errors": 0,
  "actions_filter": null,
  "batches": 3,
  "actions_summary": {
    "subscriptions": 45,
    "delete": 30,
    "news": 12
  },
  "unknown_senders": [
    {
      "uid": 54321,
      "from_address": "new-sender@example.com",
      "from_name": "New Sender",
      "subject": "Introduction"
    }
  ]
}
```

#### Key Behaviors

- **Deduplication**: Unknown senders are deduplicated by normalized email address. Only the first occurrence (most recent email) is kept.
- **UID tracking**: `seenUids` prevents the same email from being fetched in multiple batches.
- **Safety cap**: Processes at most 1000 emails (20 batches x 50 emails).
- **Actions filter**: When `actions_filter` is set (e.g., `["delete", "subscriptions"]`), known senders whose action doesn't match the filter are skipped but not counted as unknown.
- **Error resilience**: Individual action failures are logged and counted but don't halt the batch.

---

### `list_folder_emails`

List emails from any IMAP folder, not just INBOX. Useful for reviewing emails already moved to action folders (e.g., `subscriptions`, `invoices`, `for-delete`).

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `folder` | `string` | Yes | — | IMAP folder name (e.g., `"subscriptions"`, `"INBOX"`, `"for-delete"`). |
| `limit` | `number` | No | `10` | Max emails to return. Range: 1-50. |
| `since_date` | `string` | No | — | ISO 8601 date. Only return emails received on or after this date. |
| `before_date` | `string` | No | — | ISO 8601 date. Only return emails received before this date. |
| `include_flags` | `boolean` | No | `true` | Include IMAP flags in response. |
| `sort` | `string` | No | `"date_desc"` | Sort order: `"date_desc"` (newest first) or `"date_asc"` (oldest first). |

#### Flow Logic

```
1. Acquire mailbox lock for the specified folder
   - If folder does not exist → throw "Folder not found" error
2. Build IMAP SEARCH query from date filters
   - No filters → { all: true }
   - With filters → { since: Date } and/or { before: Date }
3. Execute IMAP SEARCH (UID mode)
4. Sort UIDs based on sort parameter
5. Select top N UIDs (where N = limit)
6. FETCH envelope + flags for selected UIDs
7. Sort results by date
8. Release lock
9. Return array of email summaries with folder field
```

#### Response

```json
[
  {
    "uid": 12345,
    "from_address": "newsletter@example.com",
    "from_name": "Newsletter",
    "subject": "Weekly digest",
    "date": "2025-03-15T10:30:00.000Z",
    "flags": ["\\Seen"],
    "labels": [],
    "folder": "subscriptions"
  }
]
```

#### Errors

| Error | Condition |
|---|---|
| `Error` | Folder does not exist on the IMAP server |
| `ImapConnectionError` | IMAP connection lost |

---

## Sender Classification

### `lookup_sender`

Look up a sender email address against the rules config. Read-only; does not modify anything. Checks exact rules first, then regex rules (first match wins).

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `email_address` | `string` | Yes | The sender email address to look up. |

#### Flow Logic

```
1. Normalize email to lowercase
2. Check exact rules Map
3. If exact match found → return with match_type: "exact", rule_id
4. If no exact match, iterate regex rules (definition order):
   a. Compile pattern (cached) with case-insensitive flag
   b. If pattern matches → return with match_type: "regex", matched_pattern, rule_id
5. If no match → return { matched: false, action: "unknown" }
```

#### Response (exact match)

```json
{
  "email_address": "newsletter@example.com",
  "action": "subscriptions",
  "matched": true,
  "match_type": "exact",
  "rule_id": "a1b2c3d4"
}
```

#### Response (regex match)

```json
{
  "email_address": "promo-12345@marketing.example.com",
  "action": "subscriptions",
  "matched": true,
  "match_type": "regex",
  "matched_pattern": "@marketing\\.example\\.com$",
  "rule_id": "e5f6a7b8"
}
```

#### Response (not found)

```json
{
  "email_address": "unknown@example.com",
  "action": "unknown",
  "matched": false
}
```

---

### `classify_sender`

Persist a single sender-to-action mapping. Case-insensitive. Overwrites existing mapping if the sender already has a rule.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `email_address` | `string` | Yes | The sender email address to classify. |
| `action` | `string` | Yes | The action to assign. Must be a valid action name. |

#### Flow Logic

```
1. Normalize email and action to lowercase
2. Validate action against current action table
3. If invalid → throw Error with list of valid actions
4. Check if email already exists in rules (for overwritten flag)
5. Set rule: rules.set(normalized_email, action)
6. Save entire rules map to config/sender-rules.json
7. Return result
```

#### Response

```json
{
  "email_address": "newsletter@example.com",
  "action": "subscriptions",
  "rule_id": "a1b2c3d4",
  "overwritten": false,
  "total_rules": 142
}
```

The `rule_id` is a unique 8-character hex identifier. When overwriting an existing rule, the original `rule_id` is preserved. New rules get a freshly generated ID.

#### Errors

| Error | Condition |
|---|---|
| `Error` | Action name is not in the action table |

---

### `classify_senders`

Bulk classify multiple senders in a single atomic write. Invalid entries are collected and reported but don't block valid ones.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `classifications` | `Array<{ email_address, action }>` | Yes | Array of sender-to-action mappings. |

#### Flow Logic

```
1. Get current set of valid actions
2. FOR EACH classification entry:
   a. Normalize email and action to lowercase
   b. If action is invalid:
      - Add to failed[] with error message
      - Continue
   c. Add to validEntries[]
3. FOR EACH valid entry:
   - rules.set(normalized_email, action)
   - Increment saved counter
   (last entry wins if same email appears multiple times)
4. If saved > 0:
   - Single atomic write of entire rules map to disk
5. Return summary
```

#### Response

```json
{
  "saved": 5,
  "failed": [
    {
      "email_address": "bad@example.com",
      "action": "nonexistent",
      "error": "Invalid action: \"nonexistent\". Valid actions: important, invoice, ..."
    }
  ],
  "total_rules": 147
}
```

---

## Rule Management

### `add_regex_rule`

Add a new regex pattern rule for sender matching. Regex rules are evaluated after exact rules, in definition order (first match wins).

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `pattern` | `string` | Yes | Regular expression pattern to match sender email addresses (case-insensitive). |
| `action` | `string` | Yes | Action to assign to matching senders. Must be a valid action name. |
| `description` | `string` | No | Human-readable description of what this pattern matches. |

#### Flow Logic

```
1. Validate that pattern compiles as a valid RegExp
   - If invalid → throw Error with message
2. Validate action against current action table
   - If invalid → throw Error with list of valid actions
3. Generate unique 8-char hex rule_id
4. Append rule to regex rules array (end of list)
5. Save entire rules config to disk
6. Return created rule
```

#### Response

```json
{
  "rule_id": "a1b2c3d4",
  "pattern": "@marketing\\.example\\.com$",
  "action": "subscriptions",
  "description": "All marketing.example.com senders",
  "total_regex_rules": 5,
  "total_exact_rules": 142
}
```

#### Errors

| Error | Condition |
|---|---|
| `Error` | Pattern is not a valid regular expression |
| `Error` | Action name is not in the action table |

---

### `remove_rule`

Remove a classification rule (exact or regex) by `rule_id`, `email_address`, or `pattern`. Unified tool that replaces the earlier `remove_regex_rule`.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `rule_id` | `string` | No* | The rule_id of the rule to remove (works for both exact and regex rules). Takes precedence. |
| `email_address` | `string` | No* | The email address of an exact rule to remove. |
| `pattern` | `string` | No* | The pattern string of a regex rule to remove. |

\* At least one of `rule_id`, `email_address`, or `pattern` must be provided.

#### Flow Logic

```
1. If none of rule_id, email_address, pattern provided → throw Error
2. If rule_id provided:
   a. Search exact rules by rule_id → if found, remove and return
   b. Search regex rules by rule_id → if found, remove and return
3. If email_address provided:
   a. Normalize to lowercase
   b. Search exact rules by email → if found, remove and return
4. If pattern provided:
   a. Search regex rules by pattern string → if found, remove and return
5. If not found → return { removed: false }
```

#### Response (exact rule removed)

```json
{
  "removed": true,
  "rule_id": "a3f7c1b2",
  "type": "exact",
  "email_address": "noreply@marriott.com",
  "action": "marriott"
}
```

#### Response (regex rule removed)

```json
{
  "removed": true,
  "rule_id": "b1c4e823",
  "type": "regex",
  "pattern": "@.*marriott\\.com$",
  "action": "marriott"
}
```

#### Response (not found)

```json
{
  "removed": false
}
```

---

### `list_rules`

Browse all classification rules (exact and regex) with filtering, search, and pagination.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | `string` | No | — | Filter to rules matching this action name. |
| `type` | `string` | No | `"all"` | Filter by rule type: `"exact"`, `"regex"`, or `"all"`. |
| `search` | `string` | No | — | Case-insensitive substring search across email addresses, patterns, descriptions, and action names. |
| `limit` | `number` | No | `100` | Max results to return. Range: 1-500. |
| `offset` | `number` | No | `0` | Offset for pagination. |

#### Flow Logic

```
1. Collect matching regex rules (definition order):
   - Apply action filter if set
   - Apply search filter (against pattern, description, action)
2. Collect matching exact rules (alphabetical by email):
   - Apply action filter if set
   - Apply search filter (against email, action)
3. Concatenate: regex rules first, then exact rules
4. Apply offset and limit for pagination
5. Return paginated results with totals
```

#### Response

```json
{
  "total_exact": 142,
  "total_regex": 5,
  "total": 147,
  "returned": 10,
  "offset": 0,
  "results": [
    {
      "type": "regex",
      "rule_id": "a1b2c3d4",
      "action": "subscriptions",
      "pattern": "@marketing\\.example\\.com$",
      "description": "All marketing.example.com senders"
    },
    {
      "type": "exact",
      "rule_id": "e5f6a7b8",
      "action": "subscriptions",
      "email_address": "newsletter@example.com"
    }
  ]
}
```

Each result has a `type` field (`"exact"` or `"regex"`). Exact rules include `email_address`; regex rules include `pattern` and optionally `description`.

---

### `evaluate_regex`

Test and preview a regex pattern against the existing ruleset and optionally the inbox. Does not modify any rules. Use this before `add_regex_rule` to understand the impact of a new pattern.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `pattern` | `string` | Yes | — | The regex pattern to evaluate (same syntax as `add_regex_rule`). |
| `action` | `string` | No | — | If provided, highlight conflicts where existing rules map to a different action. |
| `include_inbox_sample` | `boolean` | No | `false` | If true, test the pattern against current inbox emails (up to 50 fetched, up to 20 unique matches returned). |

#### Flow Logic

```
1. Validate that pattern compiles as a valid RegExp
   - If invalid → return { valid: false, error: "..." }
2. Test against all exact rules:
   - For each email in exact rules, if regex matches:
     - Record as exact_match with conflict flag (if action differs from target)
3. Test against existing regex rules:
   - For each regex rule, check for pattern overlap
     - Overlap detected via heuristic: both patterns tested against all known emails
     - Exact pattern string match also counts as overlap
   - Record overlaps with conflict flag
4. If include_inbox_sample:
   - Fetch up to 50 inbox emails
   - Test regex against each from_address
   - Collect up to 20 unique matching senders
5. Return analysis with conflict summary
```

#### Response (valid pattern)

```json
{
  "pattern": "@example\\.com$",
  "valid": true,
  "rule_matches": {
    "total": 3,
    "exact_matches": [
      {
        "rule_id": "a1b2c3d4",
        "type": "exact",
        "email_address": "newsletter@example.com",
        "action": "subscriptions",
        "conflict": true
      }
    ],
    "regex_matches": [
      {
        "rule_id": "e5f6a7b8",
        "type": "regex",
        "pattern": "newsletter@",
        "action": "subscriptions",
        "conflict": false
      }
    ],
    "conflicts": 1,
    "conflict_summary": "1 existing rule(s) would be shadowed by this pattern but map to a different action"
  },
  "inbox_sample": {
    "checked": true,
    "total_matches": 5,
    "emails": [
      {
        "uid": 12345,
        "from_address": "promo@example.com",
        "from_name": "Promo Team",
        "subject": "Special offer",
        "date": "2025-03-15T10:30:00.000Z"
      }
    ]
  }
}
```

#### Response (invalid pattern)

```json
{
  "pattern": "[invalid",
  "valid": false,
  "error": "Invalid regular expression: Unterminated character class"
}
```

#### Key Behaviors

- **Exact matches are informational**: Exact rules always take priority at lookup time, so the regex would not actually override them. The report shows them so you can see which senders are already covered.
- **Conflict detection**: When `action` is provided, any existing rule with a different action is flagged as a `conflict`. Rules with the same action are flagged `conflict: false`.
- **Inbox sample**: When enabled, fetches the latest 50 inbox emails and tests the pattern against each `from_address`. Returns up to 20 unique matches (deduplicated by email address).

---

## Action Management

### `add_action`

Define a new custom action type with a target folder and optional flags. Creates the IMAP folder if it doesn't exist.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | `string` | Yes | — | Action name (lowercase, no spaces). |
| `folder` | `string` | Yes | — | IMAP folder to move emails to. |
| `mark_read` | `boolean` | No | `false` | Whether to mark emails as read. |
| `flag` | `boolean` | No | `false` | Whether to flag/star emails. |

#### Flow Logic

```
1. Normalize name to lowercase
2. Reload custom actions from disk (picks up manual edits)
3. Attempt to register action in memory:
   - If action name already exists → return { created: false, existed: true }
4. If created:
   a. Save all custom actions to config/custom-actions.json
   b. Connect to IMAP
   c. Ensure target folder exists (create if missing)
5. Return result
```

#### Response (created)

```json
{
  "name": "receipts",
  "folder": "receipts",
  "mark_read": true,
  "flag": false,
  "created": true,
  "existed": false
}
```

#### Response (already exists)

```json
{
  "name": "important",
  "folder": "triaged",
  "mark_read": false,
  "flag": false,
  "created": false,
  "existed": true
}
```

---

### `get_actions`

Return all currently defined actions (both built-in and user-created) with their configuration.

#### Parameters

None.

#### Flow Logic

```
1. Reload custom actions from disk (picks up manual edits)
2. Merge built-in actions with custom actions
   (custom actions override built-in if same name)
3. Map to response format
4. Return all actions with total count
```

#### Response

```json
{
  "actions": [
    {
      "name": "important",
      "folder": null,
      "mark_read": false,
      "flag": true,
      "built_in": true
    },
    {
      "name": "receipts",
      "folder": "receipts",
      "mark_read": true,
      "flag": false,
      "built_in": false
    }
  ],
  "total": 8
}
```

---

## System Operations

### `ensure_folders`

Create any missing IMAP folders required by the rules engine.

#### Parameters

None.

#### Required Folders

`invoices`, `subscriptions`, `news`, `for-delete`

#### Flow Logic

```
1. LIST all existing mailboxes from IMAP server
2. Build set of existing folder paths (lowercase)
3. FOR EACH required folder:
   a. If exists in set → add to already_existed[]
   b. If missing:
      - Attempt mailboxCreate
      - On success → add to created[]
      - On ALREADYEXISTS error → add to already_existed[]
      - On other error → throw
   c. Wait IMAP_OP_DELAY_MS between operations
4. Return result
```

#### Response

```json
{
  "checked": ["invoices", "subscriptions", "news", "for-delete"],
  "created": [],
  "already_existed": ["invoices", "subscriptions", "news", "for-delete"]
}
```

---

### `get_run_summary`

Return a summary of the current mailbox state, including message counts for INBOX and all managed folders.

#### Parameters

None.

#### Flow Logic

```
1. Acquire INBOX mailbox lock
2. Read mailbox.exists for inbox total
3. Release lock
4. FOR EACH required folder (invoices, subscriptions, news, for-delete, triaged):
   - Query IMAP STATUS for message count
   - On error → default to 0
5. Return counts
```

#### Response

```json
{
  "inbox_total": 245,
  "inbox_unprocessed": 245,
  "folder_counts": {
    "invoices": 89,
    "subscriptions": 567,
    "news": 234,
    "for-delete": 1200
  }
}
```

Note: `inbox_unprocessed` equals `inbox_total` because all emails in INBOX are considered unprocessed. Emails from `important`, `doubleclick`, and `unknown` senders remain in INBOX.

---

### `health_check`

Comprehensive operational verification. Tests IMAP connectivity, inbox access, folder presence, rules config, and actions config.

#### Parameters

None.

#### Flow Logic

```
1. IMAP CONNECTIVITY:
   - Use shared connection via getConnection()
   - Measure latency in milliseconds
   - On auth error → record error
   - On connection error → record error

2. INBOX ACCESS (skipped if IMAP failed):
   - Acquire INBOX lock
   - Read mailbox.exists for message count
   - Release lock

3. REQUIRED FOLDERS (skipped if IMAP failed):
   - Collect all required folders:
     built-in: invoices, subscriptions, news, for-delete, triaged
     custom: folders from custom action definitions
   - LIST all mailboxes
   - Compare against required set
   - Report present[] and missing[]

4. RULES CONFIG:
   - Check file exists at RULES_CONFIG_PATH
   - Read and parse JSON
   - Count total rules

5. ACTIONS CONFIG:
   - Read action table from memory
   - Count total actions (built-in + custom)

6. CLEANUP:
   - Logout fresh IMAP client

7. healthy = (errors.length === 0)
```

#### Response (healthy)

```json
{
  "healthy": true,
  "checks": {
    "imap_connect": { "ok": true, "latency_ms": 342 },
    "inbox_access": { "ok": true, "message_count": 245 },
    "required_folders": {
      "ok": true,
      "present": ["invoices", "subscriptions", "news", "for-delete"],
      "missing": []
    },
    "rules_config": { "ok": true, "total_rules": 142 },
    "actions_config": { "ok": true, "total_actions": 8 }
  },
  "errors": []
}
```

#### Response (unhealthy)

```json
{
  "healthy": false,
  "checks": {
    "imap_connect": { "ok": false, "latency_ms": 5002, "error": "Connection timed out" },
    "inbox_access": { "ok": false, "skipped": true },
    "required_folders": { "ok": false, "skipped": true },
    "rules_config": { "ok": true, "total_rules": 142 },
    "actions_config": { "ok": true, "total_actions": 7 }
  },
  "errors": [
    { "check": "imap_connect", "message": "Connection timed out" }
  ]
}
```

When IMAP connection fails, inbox access and folder checks are skipped (marked `skipped: true`) since they depend on an active connection.

---

## Prompt Management

The runtime prompt is a versioned Markdown file stored in the config directory. It provides operating instructions for AI sessions. Version history is append-only — rollbacks create new versions.

### File Structure

```
config/
  prompt.md                  ← current prompt (always up to date)
  prompt_meta.json           ← version index and metadata
  prompt_versions/
    v1.md                    ← original/first version
    v2.md
    ...
```

---

### `get_prompt`

Return the current runtime prompt content and version metadata.

#### Parameters

None.

#### Response

```json
{
  "content": "# Yahoo Mail Inbox Processing — Runtime Prompt\n\n...",
  "version": 4,
  "last_updated": "2026-03-24T18:42:00.000Z",
  "total_versions": 4
}
```

On first run, if `prompt.md` does not exist, the server creates a default prompt as version 1 and returns it.

---

### `update_prompt`

Replace the current prompt with new content. Saves the previous version to history.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `content` | `string` | Yes | The full new prompt content in Markdown. |
| `change_summary` | `string` | No | Brief description of what changed (stored in version history). |

#### Flow Logic

```
1. Read current prompt.md content
2. If new content === current content → return error "No changes detected"
3. Save current content to prompt_versions/v{N}.md
4. Write new content to prompt.md and prompt_versions/v{N+1}.md
5. Append version entry to prompt_meta.json
6. Return new version metadata
```

#### Response

```json
{
  "version": 5,
  "previous_version": 4,
  "change_summary": "Added Telus and Hermes actions to classification guidelines",
  "saved_at": "2026-03-24T18:55:00.000Z",
  "total_versions": 5
}
```

#### Error (no changes)

```json
{
  "error": "No changes detected — prompt not updated"
}
```

---

### `list_prompt_versions`

Return the prompt version history log (newest first) without loading full content.

#### Parameters

| Name | Type | Required | Default | Description |
|---|---|---|---|---|
| `limit` | `number` | No | 10 | Max versions to return. |
| `offset` | `number` | No | 0 | Offset for pagination. |

#### Response

```json
{
  "current_version": 5,
  "total_versions": 5,
  "versions": [
    { "version": 5, "saved_at": "2026-03-24T18:55:00.000Z", "change_summary": "Added Telus and Hermes actions" },
    { "version": 4, "saved_at": "2026-03-21T10:12:00.000Z", "change_summary": "Updated run procedure" },
    { "version": 3, "saved_at": "2026-03-17T09:00:00.000Z", "change_summary": null }
  ]
}
```

---

### `get_prompt_version`

Return the full content of a specific historical prompt version.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `version` | `number` | Yes | The version number to retrieve. |

#### Response

```json
{
  "version": 3,
  "content": "# Yahoo Mail Inbox Processing...",
  "saved_at": "2026-03-17T09:00:00.000Z",
  "change_summary": null
}
```

#### Error (version not found)

```json
{
  "error": "Version 99 not found",
  "total_versions": 5
}
```

---

### `rollback_prompt`

Restore a previous version as the new current prompt. The rollback is recorded as a new version in the history.

#### Parameters

| Name | Type | Required | Description |
|---|---|---|---|
| `version` | `number` | Yes | The version number to restore. |
| `change_summary` | `string` | No | Override the default rollback summary (default: "Rollback to v{N}"). |

#### Flow Logic

```
1. If version == current_version → return error "Already on version N"
2. If version not found → return error
3. Read content from prompt_versions/v{version}.md
4. Save current prompt.md to prompt_versions/v{current}.md
5. Write restored content to prompt.md and prompt_versions/v{new}.md
6. Append new version entry to prompt_meta.json
7. Return rollback metadata
```

#### Response

```json
{
  "rolled_back_to": 3,
  "new_version": 6,
  "change_summary": "Rollback to v3",
  "saved_at": "2026-03-24T19:10:00.000Z"
}
```

#### Error (already on version)

```json
{
  "error": "Already on version 5"
}
```

---

## TTL Management

### `process_ttl_expirations`

Check inbox for important-flagged emails past their TTL and route them to their action folders. Called during session setup to sweep expired holds.

#### Parameters

None.

#### Flow Logic

```
1. Load all TTL records from config/ttl_records.json
2. Filter records where expires_at <= now
3. For each expired record:
   a. Check if UID still exists in INBOX
   b. If not found (orphan): prune TTL record, increment orphaned count
   c. If found:
      - Look up action definition
      - Remove \Flagged flag from email
      - Apply action (mark_read if applicable, move to action folder)
      - Prune TTL record
      - Increment moved count
4. Save updated ttl_records.json
5. Return summary
```

#### Response

```json
{
  "checked": 5,
  "moved": 3,
  "orphaned": 1
}
```

| Field | Description |
|---|---|
| `checked` | Total expired TTL records found |
| `moved` | Emails successfully unflagged and moved to action folder |
| `orphaned` | Records where the UID was no longer in INBOX (pruned without error) |

#### Notes

- Non-expired TTL records are left untouched
- If no TTL records exist, returns `{ checked: 0, moved: 0, orphaned: 0 }`
- Orphans occur when an email is manually moved or deleted before its TTL expires
