# Yahoo Mail MCP Server

An MCP (Model Context Protocol) server that proxies Yahoo Mail IMAP access for AI-driven email triage. It exposes 24 tools that allow an AI assistant to list, read, classify, and batch-process emails using a rules-based sender classification system with support for both exact-match and regex pattern rules.

## How It Works

Emails sitting in your INBOX are considered **unprocessed**. The server maintains a mapping of sender email addresses to **actions** via two rule types: **exact rules** (specific email addresses) and **regex rules** (patterns that match multiple senders). Each rule has a unique `rule_id`. When an action is applied to an email, the email is moved out of INBOX into a target folder and optionally flagged or marked as read. Senders not matched by any rule are surfaced as "unknown" for manual classification.

### The Triage Loop

1. **Batch process** known senders with `process_known_senders` - automatically applies rules and returns unknown senders
2. **Classify** unknown senders using `classify_sender`, `classify_senders`, or `add_regex_rule` for pattern-based rules
3. **Repeat** until inbox is empty

### Tools Overview

| Tool | Description |
|---|---|
| `list_inbox_emails` | List unprocessed emails with date filtering |
| `get_email` | Fetch a single email by UID with optional body |
| `apply_action` | Apply an action to an email |
| `process_email` | Look up sender and apply matching action |
| `process_known_senders` | Batch-process inbox, collect unknowns |
| `list_folder_emails` | List emails from any IMAP folder |
| `lookup_sender` | Read-only sender lookup against rules |
| `classify_sender` | Persist a sender-to-action exact rule |
| `classify_senders` | Bulk classify multiple senders |
| `add_regex_rule` | Add a regex pattern rule for sender matching |
| `remove_rule` | Remove any rule (exact or regex) by ID, email, or pattern |
| `list_rules` | Browse all rules with filtering and pagination |
| `evaluate_regex` | Preview a regex pattern against rules and inbox |
| `add_action` | Define a custom action type |
| `get_actions` | List all actions (built-in + custom) |
| `ensure_folders` | Create missing required IMAP folders |
| `get_run_summary` | Mailbox state summary with folder counts |
| `health_check` | Comprehensive operational verification |
| `get_prompt` | Return current runtime prompt and version metadata |
| `update_prompt` | Replace prompt content with version history |
| `list_prompt_versions` | Browse prompt version history |
| `get_prompt_version` | Retrieve a specific historical prompt version |
| `rollback_prompt` | Restore a previous prompt version |
| `process_ttl_expirations` | Sweep inbox for expired important-held emails |

## Quick Start

### Prerequisites

- Node.js >= 20.0.0
- A Yahoo Mail account with a [Yahoo App Password](https://login.yahoo.com/account/security#other-apps) (not your regular password)

### Installation

```bash
git clone https://github.com/evelo2/yahoo-mail-mcp.git
cd yahoo-mail-mcp
npm install
npm run build
```

### Configuration

**1. Environment variables** — copy the example and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:
```
YAHOO_EMAIL=your-email@yahoo.com
YAHOO_APP_PASSWORD=your-16-char-app-password
```

**2. Config files** — create from the provided examples:

```bash
cp config/sender-rules.example.json config/sender-rules.json
cp config/custom-actions.example.json config/custom-actions.json
```

These files are gitignored (they contain email addresses / PII once populated). The examples show the expected format.

### First Run

On first startup the server will:

1. **Load sender rules** from `config/sender-rules.json` — if using the example template, you'll start with a few placeholder rules. Replace or remove these as you classify real senders.
2. **Load custom actions** from `config/custom-actions.json` — defines action types beyond the built-ins. The example shows the format; you can start with an empty `{}` if you only need the built-in actions.
3. **Create `config/prompt.md`** automatically with default operating instructions (version 1). This is the runtime prompt retrieved by `get_prompt`.
4. **Run preflight checks** — connects to Yahoo IMAP, verifies inbox access, and checks required folders. If this fails, check your `.env` credentials. Set `SKIP_PREFLIGHT=true` to bypass during development.

After the first session of classifying senders, your `sender-rules.json` will grow as rules are added via `classify_sender` and `classify_senders`. This file is the primary accumulated state — it is automatically backed up (5 rolling copies) before every save.

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `YAHOO_EMAIL` | Your Yahoo email address | _(required)_ |
| `YAHOO_APP_PASSWORD` | 16-character Yahoo app password | _(required)_ |
| `RULES_CONFIG_PATH` | Path to sender rules JSON | `./config/sender-rules.json` |
| `ACTIONS_CONFIG_PATH` | Path to custom actions JSON | `./config/custom-actions.json` |
| `IMAP_HOST` | IMAP server hostname | `imap.mail.yahoo.com` |
| `IMAP_PORT` | IMAP server port | `993` |
| `IMAP_OP_DELAY_MS` | Delay between IMAP operations (ms) | `200` |
| `LOG_LEVEL` | Pino log level | `info` |
| `MCP_TRANSPORT` | Transport mode: `stdio` or `http` | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP transport | `3001` |
| `SKIP_PREFLIGHT` | Skip startup health checks | `false` |
| `MCP_API_KEY` | API key for HTTP transport auth | _(none — unauthenticated)_ |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins | _(none — all denied)_ |
| `RATE_LIMIT_RPM` | Max requests per minute per IP | `100` |
| `AUDIT_RETENTION_DAYS` | Days to keep audit log entries | `10` |

### Config Files

All config files live in the `config/` directory and are gitignored (they contain PII once populated).

| File | Purpose | Auto-created? |
|---|---|---|
| `sender-rules.json` | Exact and regex sender→action mappings | No — copy from example |
| `custom-actions.json` | User-defined action types (folder, flags) | No — copy from example |
| `prompt.md` | Runtime prompt for AI sessions | Yes — default created on first run |
| `prompt_meta.json` | Prompt version history index | Yes |
| `prompt_versions/` | Historical prompt versions (v1.md, v2.md, ...) | Yes |
| `audit.jsonl` | Append-only log of all actions applied | Yes |

**Format reference:** See `config/sender-rules.example.json` and `config/custom-actions.example.json` for the expected JSON structure. Detailed format documentation is in the [Configuration Guide](docs/configuration.md).

### Data Integrity

- **Atomic writes** — All config file saves use write-to-temp-then-rename. A crash mid-write never corrupts the file.
- **Backup rotation** — `sender-rules.json` keeps 5 rolling backups (`.bak.1` through `.bak.5`), created before each save.
- **Audit log** — Every action applied is logged to `config/audit.jsonl` (JSONL format). Capped at 1 MB; entries older than `AUDIT_RETENTION_DAYS` (default: 10) are trimmed automatically.

### Security (HTTP Transport)

When using `MCP_TRANSPORT=http`, the server applies:

- **Helmet** — Security headers (CSP, HSTS, X-Frame-Options, noSniff)
- **Rate limiting** — 100 req/min per IP (configurable via `RATE_LIMIT_RPM`)
- **CORS** — All cross-origin requests denied by default (configure via `CORS_ALLOWED_ORIGINS`)
- **API key auth** — Set `MCP_API_KEY` to require `Authorization: Bearer <key>` on all `/mcp` endpoints. **Strongly recommended for any non-localhost deployment.**
- **ReDoS protection** — Regex patterns submitted via `add_regex_rule` are validated against catastrophic backtracking before saving.

The stdio transport (default) inherits security from the parent process and does not expose an HTTP surface.

### Running

```bash
# Stdio transport (default, for Claude Desktop / Claude Code)
npm start

# HTTP transport (for remote clients)
npm run start:http
```

### Claude Desktop Integration

Add to your Claude Desktop MCP configuration:

```json
{
  "mcpServers": {
    "yahoo-mail": {
      "command": "node",
      "args": ["dist/index.js"],
      "cwd": "/path/to/yahoo-mail-mcp"
    }
  }
}
```

## Documentation

| Document | Description |
|---|---|
| [MCP Tools Reference](docs/mcp-tools-reference.md) | Detailed parameter specs, flow logic, and return types for all 24 tools |
| [Configuration Guide](docs/configuration.md) | Sender rules, custom actions, and environment variables |
| [Architecture](docs/architecture.md) | System design, IMAP integration, processing pipeline |

## Built-In Actions

| Action | Folder | Marks Read | Flags/Stars |
|---|---|---|---|
| `important` | _(stays in INBOX)_ | No | Yes |
| `doubleclick` | _(stays in INBOX)_ | No | No |
| `unknown` | _(stays in INBOX)_ | No | No |
| `invoice` | `invoices` | Yes | No |
| `subscriptions` | `subscriptions` | Yes | No |
| `news` | `news` | Yes | No |
| `delete` | `for-delete` | Yes | No |

Custom actions can be defined at runtime via the `add_action` tool.

## Development

```bash
npm run dev          # Watch mode (recompile on change)
npm test             # Run tests
npm run test:watch   # Watch mode tests
```

## Tech Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript
- **IMAP Client:** [imapflow](https://imapflow.com/)
- **MCP SDK:** [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)
- **Validation:** Zod
- **Logging:** Pino
- **HTTP Server:** Express 5 (for HTTP transport mode)
- **Testing:** Vitest
