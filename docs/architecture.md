# Architecture

## System Overview

```
┌─────────────────────┐      MCP Protocol       ┌─────────────────────────┐
│  AI Client          │◄────────────────────────►│  Yahoo Mail MCP Server  │
│  (Claude Desktop,   │   stdio | HTTP/SSE       │                         │
│   Claude Code, etc) │                          │  23 tools registered    │
└─────────────────────┘                          └───────────┬─────────────┘
                                                             │
                                              ┌──────────────┼──────────────┐
                                              │              │              │
                                         ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
                                         │  IMAP   │   │  Rules  │   │  Config │
                                         │  Layer  │   │  Engine │   │  Files  │
                                         └────┬────┘   └─────────┘   └─────────┘
                                              │
                                    TLS:993   │
                                         ┌────▼────────────┐
                                         │  Yahoo Mail     │
                                         │  IMAP Server    │
                                         └─────────────────┘
```

## Source Structure

```
src/
├── index.ts              Entry point: loads config, runs preflight, starts server
├── server.ts             Creates McpServer, registers all 23 tools
├── preflight.ts          Startup validation (IMAP, folders, fetch test)
├── imap/
│   ├── client.ts         IMAP connection management (singleton, reconnect)
│   ├── operations.ts     Core IMAP operations + action table + folder management
│   └── types.ts          TypeScript interfaces (EmailSummary, EmailDetail, etc.)
├── rules/
│   ├── config.ts         Sender rules + custom actions persistence (load/save/migrate)
│   └── engine.ts         Sender lookup logic (exact → regex, with regex cache)
├── tools/                One file per MCP tool handler
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
│   ├── remove-rule.ts
│   ├── list-rules.ts
│   ├── evaluate-regex.ts
│   ├── add-action.ts
│   ├── get-actions.ts
│   ├── ensure-folders.ts
│   ├── run-summary.ts
│   └── health-check.ts
└── utils/
    ├── errors.ts         Custom error classes
    ├── logger.ts         Pino logger configuration
    └── paths.ts          Shared config path resolution and constants
```

## Startup Sequence

```
1. Load environment variables (dotenv)
2. Load custom actions from config/custom-actions.json
3. Load sender rules from config/sender-rules.json
   - Detect format: new structured or legacy flat
   - If legacy: backup to sender-rules.backup.json, migrate, save new format
4. Run preflight checks (unless SKIP_PREFLIGHT=true):
   a. Validate YAHOO_EMAIL and YAHOO_APP_PASSWORD are set
   b. Connect to Yahoo IMAP, measure latency
   c. List all mailboxes
   d. Open INBOX, get message count
   e. Fetch a sample email by UID
   f. Print report, exit(1) on failure
5. Create MCP server with 23 tools
6. Initialize tool modules that need shared state (rules reference)
7. Start transport:
   - stdio: connect StdioServerTransport
   - http: start Express server with session management
8. Register SIGINT/SIGTERM handlers for clean shutdown
```

## IMAP Integration

### Connection Management

The IMAP layer uses a **singleton pattern** with lazy reconnection:

- `getConnection()` returns the existing `ImapFlow` client if it's still usable
- If the client is null or disconnected, a new connection is established
- The client config is cached after first use
- `closeConnection()` performs a clean IMAP LOGOUT

### UID-Based Operations

All IMAP operations use **UIDs** (not sequence numbers). This is critical because:

- UIDs are persistent across reconnections
- Sequence numbers can shift when other emails are deleted/moved
- Every `fetch`, `fetchOne`, `messageFlagsAdd`, and `messageMove` call passes `{ uid: true }`

### Mailbox Locking

Operations that read or modify the INBOX acquire a **mailbox lock** via `client.getMailboxLock('INBOX')`. The lock is always released in a `finally` block to prevent deadlocks.

### Rate Limiting

Yahoo's IMAP server can reject rapid-fire operations. The server introduces a configurable delay (`IMAP_OP_DELAY_MS`, default 200ms) between:
- Flag operations (`\Seen`, `\Flagged`)
- Move operations
- Folder creation during `ensure_folders`

### Folder Caching

A `knownFolders` Set caches which IMAP folders exist:
- Populated on first `ensureFolderExists()` call via a full LIST
- Updated when folders are created
- Avoids repeated IMAP LIST calls during batch processing
- Cleared on server restart

## Rules Engine

### Data Model

```
Exact Rules (Map<string, ExactRule>)
┌─────────────────────────┬───────────────┬──────────┐
│ email (lowercase)       │ action        │ rule_id  │
├─────────────────────────┼───────────────┼──────────┤
│ newsletter@example.com  │ subscriptions │ a1b2c3d4 │
│ billing@company.com     │ invoice       │ e5f6a7b8 │
│ boss@work.com           │ important     │ c9d0e1f2 │
└─────────────────────────┴───────────────┴──────────┘

Regex Rules (RegexRule[])  — ordered, first match wins
┌──────────┬──────────────────────────────┬───────────────┬────────────────────┐
│ rule_id  │ pattern                      │ action        │ description        │
├──────────┼──────────────────────────────┼───────────────┼────────────────────┤
│ aabbccdd │ @marketing\.example\.com$    │ subscriptions │ Marketing emails   │
│ eeff0011 │ noreply@.*\.example\.com$    │ delete        │ No-reply addresses │
└──────────┴──────────────────────────────┴───────────────┴────────────────────┘

Action Table (Record<string, ActionDef>)
┌───────────────┬──────────────┬──────────┬──────┬──────────┐
│ name          │ moveToFolder │ markRead │ flag │ builtIn  │
├───────────────┼──────────────┼──────────┼──────┼──────────┤
│ important     │ (none)       │ false    │ true │ true     │
│ doubleclick   │ (none)       │ false    │ false│ true     │
│ unknown       │ (none)       │ false    │ false│ true     │
│ subscriptions │ subscriptions│ true     │ false│ true     │
│ receipts      │ receipts     │ true     │ false│ false    │
└───────────────┴──────────────┴──────────┴──────┴──────────┘

Actions with `moveToFolder: undefined` leave emails in INBOX. Only flag/markRead operations are applied.
```

### Lookup Flow

1. Normalize sender email to lowercase
2. **Exact match**: Check if email exists in the exact rules Map
   - If found: return `matched: true`, `match_type: "exact"`, `rule_id`
3. **Regex match**: Iterate regex rules in definition order
   - Compile pattern (cached in `regexCache`) with case-insensitive flag
   - If pattern matches: return `matched: true`, `match_type: "regex"`, `matched_pattern`, `rule_id`
4. If no match: return `matched: false`, `action: "unknown"`

Exact rules always take priority over regex rules. This prevents broad patterns from accidentally overriding specific sender classifications.

### Regex Cache

Compiled `RegExp` objects are cached in a `Map<string, RegExp | null>` to avoid recompilation on every lookup. Invalid patterns are cached as `null` and silently skipped during matching (with a warning logged). The cache is cleared when regex rules are added or removed.

### Persistence

- **Sender rules**: `config/sender-rules.json` - loaded at startup, saved on every classify/regex rule operation. Uses the structured `{ exact: {...}, regex: [...] }` format with `rule_id` on every rule.
- **Custom actions**: `config/custom-actions.json` - loaded at startup, saved when new actions are added
- Both files use atomic full-file writes (`writeFileSync`)
- **Legacy migration**: On first load of a flat-format rules file, a backup is created at `config/sender-rules.backup.json` and the file is rewritten in the new structured format.

## Transport Modes

### Stdio (Default)

Used by Claude Desktop and Claude Code. Communication happens over standard input/output.

```
Client ──stdin──► MCP Server
Client ◄─stdout── MCP Server
```

Single server instance per connection. No session management needed.

### HTTP

Used for remote or multi-client access. Runs an Express 5 server.

```
Endpoints:
  POST   /mcp    → Handle MCP JSON-RPC requests
  GET    /mcp    → SSE stream for server-to-client messages
  DELETE /mcp    → Terminate a session
  GET    /health → Simple health check ({ status: "ok", sessions: N })
```

**Session management:**
- Each new POST creates a session with a UUID
- Session ID returned in `mcp-session-id` header
- Subsequent requests include this header to reuse the session
- Each session gets its own `StreamableHTTPServerTransport` and `McpServer` instance
- Sessions are cleaned up when the transport closes

## Error Handling

### Custom Error Classes

| Class | Use Case | Extra Properties |
|---|---|---|
| `ImapConnectionError` | IMAP connection failures | — |
| `AuthenticationError` | Yahoo auth failures | Default message with guidance |
| `EmailNotFoundError` | UID not in INBOX | `uid: number` |
| `InvalidActionError` | Action name not in table | `action: string` |
| `ConfigError` | Config file I/O or parse errors | — |

### Error Propagation

Each MCP tool handler wraps its logic in try/catch:
- On success: returns `{ content: [{ type: "text", text: "<json>" }] }`
- On error: returns `{ content: [{ type: "text", text: "<error json>" }], isError: true }`

Error responses have the shape:
```json
{ "success": false, "error": "Human-readable error message" }
```

## Processing Pipeline

### Typical Triage Session

```
┌──────────────┐     ┌──────────────────────┐     ┌───────────────────┐
│ health_check │────►│ process_known_senders │────►│ Review unknowns   │
│              │     │                      │     │ from response     │
└──────────────┘     └──────────┬───────────┘     └────────┬──────────┘
                                │                          │
                    ┌───────────▼──────────┐    ┌──────────▼──────────┐
                    │ Known senders auto-  │    │ classify_senders    │
                    │ triaged to folders   │    │ (bulk classify)     │
                    └──────────────────────┘    └──────────┬──────────┘
                                                           │
                                               ┌───────────▼──────────┐
                                               │ process_known_senders│
                                               │ (second pass)        │
                                               └──────────────────────┘
                                                           │
                                                    ┌──────▼──────┐
                                                    │ Inbox empty │
                                                    └─────────────┘
```

1. **health_check** - Verify IMAP connectivity and configuration
2. **process_known_senders** - Auto-triage all emails from known senders; returns list of unknown senders
3. **classify_senders** - AI or user classifies the unknown senders with appropriate actions
4. **process_known_senders** - Second pass picks up newly classified senders
5. Repeat until no unknowns remain

### Batch Processing Internals

`process_known_senders` processes the inbox in batches to handle large mailboxes:

```
BATCH 1: Fetch 50 emails → apply known → collect unknown
BATCH 2: Fetch 50 more (excluding already-seen UIDs) → apply → collect
BATCH 3: ...
...
EXIT when: 50 unique unknowns collected OR inbox exhausted OR 20 batches (1000 emails)
```

The `actions_filter` parameter allows selective processing. For example, `actions_filter: ["delete"]` processes only emails from senders classified as "delete", leaving everything else untouched. This is useful for targeted cleanup passes.

## Logging

Uses Pino for structured JSON logging to stderr:

```json
{"level":30,"time":1710500000000,"msg":"Action applied","uid":12345,"action":"subscriptions","operations":["marked_read","moved_to_subscriptions"]}
```

Log level is controlled by `LOG_LEVEL` environment variable. Key events logged:
- IMAP connection established/lost
- Sender rules saved (with count)
- Actions applied (with UID, action, operations)
- Batch processing summaries
- Errors with full context
