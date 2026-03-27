# Architecture

## System Overview

The Yahoo Mail MCP Server is a locally-running Node.js MCP server that proxies Yahoo Mail via IMAP using [imapflow](https://imapflow.com/). It communicates with Claude (Claude Desktop or Claude Code) over the MCP stdio transport protocol, exposing 25 tools for AI-driven email triage.

```
┌─────────────────────────────────────────────┐
│               Claude (AI Client)             │
│         Claude Desktop / Claude Code         │
└──────────────────┬──────────────────────────┘
                   │ MCP stdio transport
┌──────────────────▼──────────────────────────┐
│            Yahoo Mail MCP Server             │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │ Tool Router │  │   Rules Engine        │  │
│  │ (25 tools)  │  │ exact + regex + TTL   │  │
│  └──────┬──────┘  └──────────┬───────────┘  │
│         │                    │               │
│  ┌──────▼────────────────────▼───────────┐  │
│  │           IMAP Client (imapflow)       │  │
│  └──────────────────┬───────────────────┘   │
│                     │                        │
│  ┌──────────────────▼──────────────────┐    │
│  │         Data Stores                  │    │
│  │  rules.json  actions.json  ttl.json  │    │
│  │  prompt.md (versioned)  audit.jsonl  │    │
│  └─────────────────────────────────────┘    │
└─────────────────────┬───────────────────────┘
                      │ IMAP / TLS :993
┌─────────────────────▼───────────────────────┐
│             Yahoo Mail (IMAP)                │
└─────────────────────────────────────────────┘
```

See [06_architecture.mermaid](diagrams/06_architecture.mermaid) for a rendered component diagram.

### External Dependencies

- **Yahoo IMAP** — connects to `imap.mail.yahoo.com:993` using TLS with a Yahoo App Password (not OAuth)
- **No Cloudflare tunnel required** for stdio transport — MCP SDK handles communication over stdin/stdout
- **HTTP transport** (optional) — runs an Express 5 server for remote clients; can be fronted by a Cloudflare tunnel if needed

## Source Structure

```
src/
├── index.ts                 Entry point: loads config, runs preflight, starts server
├── server.ts                Creates McpServer, registers all 25 tools
├── preflight.ts             Startup validation (IMAP, folders, fetch test)
├── imap/
│   ├── client.ts            IMAP connection management (singleton, reconnect)
│   ├── operations.ts        Core IMAP operations + action table + folder management
│   └── types.ts             TypeScript interfaces (EmailSummary, EmailDetail, etc.)
├── rules/
│   ├── config.ts            Sender rules + custom actions persistence (load/save/migrate)
│   └── engine.ts            Sender lookup logic (exact → regex, with regex cache)
├── tools/                   One file per MCP tool handler
│   ├── list-inbox.ts
│   ├── get-email.ts
│   ├── apply-action.ts
│   ├── process-email.ts
│   ├── process-known-senders.ts
│   ├── list-folder-emails.ts
│   ├── lookup-sender.ts
│   ├── classify-sender.ts
│   ├── classify-senders.ts
│   ├── add-regex-rule.ts
│   ├── add-subject-route.ts
│   ├── remove-rule.ts
│   ├── list-rules.ts
│   ├── evaluate-regex.ts
│   ├── add-action.ts
│   ├── get-actions.ts
│   ├── ensure-folders.ts
│   ├── run-summary.ts
│   ├── health-check.ts
│   └── process-ttl-expirations.ts
├── prompt/
│   └── manager.ts           Prompt versioning, history, rollback
└── utils/
    ├── errors.ts            Custom error classes (5 types)
    ├── logger.ts            Pino logger configuration
    ├── paths.ts             Shared config path resolution and constants
    ├── ttl-store.ts         TTL record persistence for important modifier
    ├── fs.ts                Atomic writes, backup rotation helpers
    └── audit-log.ts         Append-only action audit log
```

## Components

### Tool Router (25 tools)

Tools are grouped by category:

| Category | Tools | Count |
|---|---|---|
| Email Operations | `list_inbox_emails`, `get_email`, `apply_action`, `process_email`, `process_known_senders`, `list_folder_emails` | 6 |
| Sender Classification | `lookup_sender`, `classify_sender`, `classify_senders` | 3 |
| Rule Management | `add_regex_rule`, `add_subject_route`, `remove_rule`, `list_rules`, `evaluate_regex` | 5 |
| Action Management | `add_action`, `get_actions` | 2 |
| System Operations | `ensure_folders`, `get_run_summary`, `health_check` | 3 |
| TTL Management | `process_ttl_expirations` | 1 |
| Prompt Management | `get_prompt`, `update_prompt`, `list_prompt_versions`, `get_prompt_version`, `rollback_prompt` | 5 |

Each tool is registered in `server.ts` with a Zod schema for input validation and a handler function. Tool handlers return `{ content: [{ type: "text", text: "<json>" }] }` on success or `{ content: [...], isError: true }` on failure.

### Rules Engine

The rules engine (`src/rules/engine.ts`) resolves a sender email address to an action:

1. **Exact match** — O(1) Map lookup by lowercase email
2. **Regex match** — iterate regex rules in definition order, first match wins
3. **No match** — returns `action: "unknown"`

Exact rules always take priority over regex rules. Regex patterns are compiled with case-insensitive flag and cached (LRU, max 500 entries). Invalid patterns are cached as `null` and skipped with a warning.

### IMAP Client

Singleton pattern with lazy reconnection via `getConnection()`. All operations use UIDs (not sequence numbers) for stability across reconnections. Mailbox locks are acquired per-operation and always released in `finally` blocks.

A configurable delay (`IMAP_OP_DELAY_MS`, default 200ms) between operations prevents Yahoo rate-limiting.

### Prompt Manager

Manages a versioned runtime prompt (`config/prompt.md`) with full version history. Supports update, rollback, and version browsing. Each version is stored as a separate file in `config/prompt_versions/`.

## Data Stores

| File | Purpose | Schema | Read/Write | Auto-created? |
|---|---|---|---|---|
| `config/sender-rules.json` | Exact + regex sender→action rules | `{ exact: Record<email, ExactRule>, regex: RegexRule[] }` | Read at startup; written on classify/add/remove | No — copy from example |
| `config/custom-actions.json` | User-defined action types | `Record<name, { folder, mark_read, flag }>` | Read at startup + before modification; written on `add_action` | No — copy from example |
| `config/ttl_records.json` | Active TTL holds for important emails | `{ ttl_records: TtlRecord[] }` | Read at startup (`initTtlStore`); written on hold/expire | Yes |
| `config/prompt.md` | Current runtime prompt content | Markdown | Read via `get_prompt`; written via `update_prompt` | Yes — default on first run |
| `config/prompt_meta.json` | Prompt version index | `{ current_version, last_updated, versions[] }` | Read/written with prompt ops | Yes |
| `config/prompt_versions/` | Historical prompt versions (v1.md, v2.md, ...) | Markdown files | Append-only | Yes |
| `config/audit.jsonl` | Action audit trail | JSONL: `{ timestamp, uids[], action, source_folder, count, batch_id }` | Append-only; trimmed by retention | Yes |

### Data Integrity

- **Atomic writes** — all config saves use write-to-temp-then-rename (crash-safe)
- **Backup rotation** — `sender-rules.json` keeps 5 rolling backups (`.bak.1` through `.bak.5`)
- **Audit log** — append-only, capped at 1 MB, entries older than `AUDIT_RETENTION_DAYS` (default: 10) trimmed automatically

## Action Model

### Built-in vs Custom Actions

- **7 built-in actions** are hardcoded in `src/imap/operations.ts` and cannot be removed: `important`, `doubleclick`, `unknown`, `invoice`, `subscriptions`, `news`, `delete`
- **Custom actions** are defined at runtime via `add_action` and persisted to `config/custom-actions.json`
- The merged action table is cached in memory and invalidated when custom actions change

### Action Fields

| Field | Type | Description |
|---|---|---|
| `name` | string | Unique identifier (lowercase, no spaces) |
| `folder` | string or null | Target IMAP folder. `null` means email stays in current folder |
| `mark_read` | boolean | Whether to add `\Seen` flag |
| `flag` | boolean | Whether to add `\Flagged` flag (star) |
| `built_in` | boolean | Whether the action is hardcoded |

See [ACTIONS.md](ACTIONS.md) for the complete reference of all 23 actions.

### The `important` Modifier

`important` is a **boolean flag on any rule** (exact or regex), not a standalone routing action. When a rule has `important: true`:

1. **On match** — the email is flagged (`\Flagged`) and **held in INBOX** instead of being moved
2. **TTL record created** — `{ uid, action, folder, arrived_at, expires_at }` written to `config/ttl_records.json`
3. **TTL duration** — set by `important_ttl_days` on the rule (default: 7 days if omitted)
4. **On expiry** — `process_ttl_expirations` sweeps the TTL store, unflags emails, and moves them to their action folder
5. **Orphan handling** — if an email was manually moved before TTL expires, the record is pruned without error

See [04_ttl_expiry.mermaid](diagrams/04_ttl_expiry.mermaid) for a visual flow.

## Rule Model

### Exact Rules

```typescript
interface ExactRule {
  action: string;
  rule_id: string;              // 8-char hex, stable across saves
  important?: boolean;           // Hold in inbox with TTL
  important_ttl_days?: number;   // Days before routing (default: 7)
  subject_routes?: SubjectRoute[]; // Subject-line branching (optional)
}

interface SubjectRoute {
  route_id: string;              // Unique ID for targeted removal
  pattern: string;               // Regex, matched with 'i' flag. Use | for OR, .* between words.
  action: string;                // Override action when subject matches
  important?: boolean;           // Override sender-level important setting
  important_ttl_days?: number;
}
```

Stored as `Map<lowercase_email, ExactRule>` in memory, serialized as a plain object in `sender-rules.json`.

**Subject routes** allow a single sender to route to different actions based on the email subject. When `subject_routes` is present, the engine tests each route's `pattern` regex against the subject (case-insensitive, using the shared `getCompiledRegex` cache). First matching route wins. If no route matches, the base `action` is used. Subject routes can independently set `important` and `important_ttl_days`, overriding the sender-level settings.

**Pattern examples:** `"order.*confirm"` matches "Order NB-19643 confirmed"; `"shipped|tracking|delivered"` matches any of those words; `"invoice|receipt"` matches either.

**Migration:** Legacy rules using the old `contains: string[]` format are automatically migrated to a `pattern` string on server startup via `migrateSubjectRoutesToPattern()`. The migration is idempotent and logged.

### Regex Rules

```typescript
interface RegexRule {
  rule_id: string;
  pattern: string;            // JavaScript regex syntax
  action: string;
  description?: string;       // Human-readable explanation
  important?: boolean;
  important_ttl_days?: number;
}
```

Stored as an ordered array. Patterns validated against catastrophic backtracking (ReDoS) using `safe-regex2` before saving.

### Evaluation Order

1. **Exact rules first** — O(1) Map lookup by normalized (lowercase) email
   - If matched and `subject_routes` exist: evaluate subject routes in order (first match wins)
   - If no subject route matches: use base `action`
2. **Regex rules second** — iterated in definition order, first match wins
3. **No match** — returns `action: "unknown"`, `matched: false`

### Built-in Fallbacks

- `unknown` — default for unclassified senders; email stays in INBOX
- `doubleclick` — marks sender as known but takes no action
- `important` — (deprecated as routing target) catch-all for senders without a better folder

## Startup Sequence

```
1. Load environment variables (dotenv)
2. Load custom actions from config/custom-actions.json
3. Load sender rules from config/sender-rules.json
   - Detect format: new structured or legacy flat
   - If legacy flat: backup → migrate → save new format
3b. Migrate subject routes: any route with old `contains: string[]` format
    converted to `pattern: string` (idempotent, logged, saved if changed)
4. Initialize TTL store from config/ttl_records.json
5. Run preflight checks (unless SKIP_PREFLIGHT=true):
   a. Validate YAHOO_EMAIL and YAHOO_APP_PASSWORD
   b. Connect to Yahoo IMAP, measure latency
   c. List all mailboxes
   d. Open INBOX, get message count
   e. Fetch a sample email by UID
   f. Print report, exit(1) on failure
6. Create MCP server with 25 tools
7. Initialize tool modules with shared state (rules reference)
8. Start transport:
   - stdio: connect StdioServerTransport
   - http: start Express server with session management
9. Register SIGINT/SIGTERM handlers for clean shutdown
```

See [01_session_setup.mermaid](diagrams/01_session_setup.mermaid) for the AI session startup flow (distinct from server startup).

## Transport Modes

### Stdio (Default)

Used by Claude Desktop and Claude Code. Communication over stdin/stdout. Single server instance per connection.

### HTTP

Used for remote or multi-client access via Express 5:
- `POST /mcp` — MCP JSON-RPC requests
- `GET /mcp` — SSE stream for server-to-client messages
- `DELETE /mcp` — terminate session
- `GET /health` — simple health check

Session management via UUID in `mcp-session-id` header. Security: Helmet, rate limiting, CORS, optional API key auth.

## Error Handling

| Error Class | Use Case |
|---|---|
| `ImapConnectionError` | IMAP connection failures |
| `AuthenticationError` | Yahoo auth failures |
| `EmailNotFoundError` | UID not found in specified folder |
| `InvalidActionError` | Action name not in action table |
| `ConfigError` | Config file I/O or parse errors |

Each tool handler wraps logic in try/catch, returning structured JSON on success or `{ success: false, error: "..." }` with `isError: true` on failure.

## Diagrams

Visual documentation is available in [`docs/diagrams/`](diagrams/):

| Diagram | Description |
|---|---|
| [01_session_setup.mermaid](diagrams/01_session_setup.mermaid) | Session startup sequence |
| [02_email_triage.mermaid](diagrams/02_email_triage.mermaid) | Email triage flowchart |
| [03_rule_classification.mermaid](diagrams/03_rule_classification.mermaid) | Unknown sender classification flow |
| [04_ttl_expiry.mermaid](diagrams/04_ttl_expiry.mermaid) | TTL expiry processing |
| [05_apply_action.mermaid](diagrams/05_apply_action.mermaid) | apply_action with source_folder |
| [06_architecture.mermaid](diagrams/06_architecture.mermaid) | Component overview |

These render natively in GitHub, GitLab, and VS Code (with the Markdown Preview Mermaid Support extension).
