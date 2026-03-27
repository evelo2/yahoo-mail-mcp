# Configuration Guide

## Environment Variables

All configuration is loaded from environment variables, typically via a `.env` file in the project root.

### Required

| Variable | Description |
|---|---|
| `YAHOO_EMAIL` | Your full Yahoo email address (e.g., `user@yahoo.com`). |
| `YAHOO_APP_PASSWORD` | A 16-character Yahoo App Password. Generate one at [Yahoo Account Security](https://login.yahoo.com/account/security#other-apps). This is **not** your regular Yahoo password. |

### IMAP Connection

| Variable | Default | Description |
|---|---|---|
| `IMAP_HOST` | `imap.mail.yahoo.com` | IMAP server hostname. Change if using a custom mail domain. |
| `IMAP_PORT` | `993` | IMAP port. Always uses TLS (secure: true). |
| `IMAP_OP_DELAY_MS` | `200` | Milliseconds to wait between consecutive IMAP operations (flag, move). Prevents Yahoo from rate-limiting rapid requests. Set to `0` to disable. |

### File Paths

| Variable | Default | Description |
|---|---|---|
| `RULES_CONFIG_PATH` | `./config/sender-rules.json` | Path to the sender rules file. Relative paths resolve from the project root. |
| `ACTIONS_CONFIG_PATH` | `./config/custom-actions.json` | Path to the custom actions file. File is created automatically when first custom action is added. |

### Server

| Variable | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Transport mode. `stdio` for Claude Desktop / Claude Code. `http` for remote clients. |
| `MCP_HTTP_PORT` | `3001` | Port for HTTP transport mode. |
| `SKIP_PREFLIGHT` | `false` | Set to `true` to skip startup health checks. Useful for development or when IMAP is temporarily unavailable. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. |

---

## Sender Rules

### File Format

`config/sender-rules.json` uses a structured format with two sections: `exact` for specific email addresses and `regex` for pattern-based rules. Each rule has a unique 8-character hex `rule_id`.

```json
{
  "exact": {
    "newsletter@example.com": { "action": "subscriptions", "rule_id": "a1b2c3d4" },
    "billing@company.com": { "action": "invoice", "rule_id": "e5f6a7b8" },
    "noreply@store.com": {
      "action": "subscriptions",
      "rule_id": "c9d0e1f2",
      "subject_routes": [
        {
          "route_id": "c9d0e1f3",
          "pattern": "shipped|tracking|delivered",
          "action": "shipping",
          "important": true,
          "important_ttl_days": 1
        },
        {
          "route_id": "c9d0e1f4",
          "pattern": "order.*confirm|receipt",
          "action": "invoice",
          "important": true,
          "important_ttl_days": 1
        }
      ]
    },
    "boss@work.com": { "action": "important", "rule_id": "11223344" },
    "colleague@work.com": { "action": "doubleclick", "rule_id": "55667788" }
  },
  "regex": [
    {
      "rule_id": "aabbccdd",
      "pattern": "@marketing\\.example\\.com$",
      "action": "subscriptions",
      "description": "All marketing.example.com senders"
    },
    {
      "rule_id": "eeff0011",
      "pattern": "noreply@.*\\.example\\.com$",
      "action": "delete",
      "description": "No-reply addresses from example.com subdomains"
    }
  ]
}
```

### Legacy Format Migration

If the server detects a legacy flat-format rules file (i.e., `Record<string, string>` where values are plain action strings), it automatically migrates to the new structured format:

1. **Backup created**: The original file is copied to `config/sender-rules.backup.json` before any changes.
2. **Rule IDs assigned**: Each existing rule gets a freshly generated 8-character hex `rule_id`.
3. **New format saved**: All rules are written to the `exact` section; `regex` starts as an empty array.
4. **No manual steps required**: Migration happens transparently on first load.

### Regex Rules

Regex rules match sender email addresses using JavaScript regular expressions with the case-insensitive flag (`/i`).

- **Pattern format**: Standard JavaScript regex syntax (e.g., `@example\\.com$`, `^noreply@`, `marketing|promo`).
- **Evaluation order**: Exact rules are always checked first. If no exact match is found, regex rules are evaluated in **definition order** (array order in the config file). First match wins.
- **Description field**: Optional human-readable text explaining what the pattern matches. Useful for documentation and searchable via the `list_rules` tool.
- **Preview before adding**: Use `evaluate_regex` to test a pattern against existing rules and inbox before committing it with `add_regex_rule`.

### Key Behaviors

- **Case-insensitive**: All email addresses are normalized to lowercase on load and when classifying. Regex patterns are compiled with the `i` flag.
- **Overwrite-safe**: Classifying an already-classified sender overwrites the previous action but preserves its `rule_id`.
- **Atomic saves**: The entire rules config (exact + regex) is written to disk in a single `writeFileSync` call.
- **Runtime editable**: Rules can be modified both via MCP tools (`classify_sender`, `classify_senders`, `add_regex_rule`, `remove_rule`) and by editing the JSON file directly. However, direct file edits are only picked up on server restart.
- **Action validation**: When classifying via tools, the action must exist in the current action table (built-in + custom). Manual file edits are not validated until the action is applied.
- **Rule IDs**: Every rule (exact and regex) has a unique `rule_id`. IDs are generated via `randomUUID().slice(0, 8)` and are stable across saves. They are used to identify rules in `list_rules`, `remove_rule`, and lookup responses.
- **Subject routes**: Optional on exact rules only. Each route has a unique `route_id` and a `pattern` regex tested case-insensitively against the email subject (first match wins). Use `|` for OR logic (`"shipped|tracking"`), `.*` between words (`"order.*confirm"`). Routes are evaluated in definition order. Each route independently sets `action`, `important`, and `important_ttl_days`, overriding the sender-level values. Manage via `add_subject_route` and `remove_rule(route_id: "...")`. Legacy `contains: string[]` rules are auto-migrated to `pattern` on startup.

### Managing Rules

**Exact rules via MCP tools (recommended):**
```
classify_sender("newsletter@example.com", "subscriptions")
classify_senders([
  { email_address: "a@example.com", action: "delete" },
  { email_address: "b@example.com", action: "news" }
])
```

**Regex rules via MCP tools:**
```
evaluate_regex("@marketing\\.example\\.com$", action: "subscriptions", include_inbox_sample: true)
add_regex_rule("@marketing\\.example\\.com$", "subscriptions", description: "Marketing emails")
remove_rule(rule_id: "aabbccdd")
remove_rule(email_address: "noreply@example.com")  // exact rules
remove_rule(pattern: "@marketing\\.example\\.com$")  // regex rules
list_rules(type: "regex")
```

**Subject routes via MCP tools (for senders that need subject-based branching):**
```
add_subject_route("noreply@store.com", pattern: "shipped|tracking", action: "shipping", important: true, important_ttl_days: 1)
remove_rule(route_id: "c9d0e1f3")  // remove a single subject route
```

**Manually:** Edit `config/sender-rules.json` and restart the server.

---

## Actions

### Built-In Actions

These 7 actions are always available and cannot be removed:

| Action | Target Folder | Marks Read | Flags/Stars | Purpose |
|---|---|---|---|---|
| `important` | _(stays in INBOX)_ | No | Yes | Emails requiring attention; flagged for visibility. Stays in INBOX. |
| `doubleclick` | _(stays in INBOX)_ | No | No | Emails worth reading but not urgent. Marks sender as "known" but takes no action on the email. |
| `unknown` | _(stays in INBOX)_ | No | No | Senders you want to keep but haven't categorized yet. No-op — email stays in INBOX. |
| `invoice` | `invoices` | Yes | No | Bills, receipts, payment confirmations. |
| `subscriptions` | `subscriptions` | Yes | No | Mailing lists, newsletters, marketing. |
| `news` | `news` | Yes | No | News digests, alerts, aggregators. |
| `delete` | `for-delete` | Yes | No | Junk to review before permanent deletion. |

### Custom Actions

Custom actions extend the action table at runtime. They are defined via the `add_action` MCP tool and persisted to `config/custom-actions.json`.

#### Custom Actions File Format

```json
{
  "receipts": {
    "folder": "receipts",
    "mark_read": true,
    "flag": false
  },
  "travel": {
    "folder": "travel",
    "mark_read": false,
    "flag": true
  }
}
```

#### Creating a Custom Action

```
add_action(name: "receipts", folder: "receipts", mark_read: true)
```

This:
1. Registers the action in memory
2. Saves to `config/custom-actions.json`
3. Creates the IMAP folder `receipts` if it doesn't exist

#### Key Behaviors

- **Name uniqueness**: Action names must be unique across built-in and custom actions. Attempting to add an action with an existing name returns `created: false, existed: true`.
- **Idempotent**: Re-adding an existing action is a no-op.
- **Disk sync**: The custom actions file is reloaded from disk before modifications, so manual edits between tool calls are respected.
- **Folder creation**: The target IMAP folder is created automatically if it doesn't exist.

---

## Required IMAP Folders

The server manages these folders on the Yahoo Mail account:

| Folder | Used By |
|---|---|
| `invoices` | `invoice` action |
| `subscriptions` | `subscriptions` action |
| `news` | `news` action |
| `for-delete` | `delete` action |

Note: `important`, `doubleclick`, and `unknown` actions leave emails in INBOX (no target folder).

Plus any folders created by custom actions.

Use the `ensure_folders` tool to create all missing required folders, or they will be created on-demand when an action first targets them.

---

## Preflight Checks

On startup (unless `SKIP_PREFLIGHT=true`), the server runs a series of checks:

1. **Environment validation** - `YAHOO_EMAIL` and `YAHOO_APP_PASSWORD` must be set
2. **IMAP connection** - Connects to Yahoo and measures latency
3. **Folder listing** - Enumerates all mailboxes on the account
4. **INBOX enumeration** - Gets message count and a sample UID
5. **Email fetch test** - Verifies UID-based fetch works with the sample email

If any critical check fails, the server prints a diagnostic report and exits with status code 1.

The preflight report uses colored output: green checkmarks for passes, red X marks for failures, with actionable guidance for common issues.
