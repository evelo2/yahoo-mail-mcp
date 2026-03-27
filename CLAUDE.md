# Yahoo Mail MCP Server — Claude Code Project Instructions

> **Primary mandate: Performant, secure-first code. Every change.**

---

## Project Overview

A locally-running Node.js MCP server (TypeScript) that proxies Yahoo Mail via
IMAP for AI-driven email triage. Exposes 25 MCP tools over stdio transport
(default) and optionally over HTTP (Express 5). See `docs/architecture.md`
for full system design.

---

## Security — Secure First

Security is not a post-implementation check. It is a design input on every
story. The question is not "is this secure enough?" — it is "what is the
attack surface and how is it eliminated?"

### OWASP Top 10 — Transport-Aware Compliance

This server runs over two transports with different threat models. Apply the
appropriate control set for each.

#### HTTP Transport (`MCP_TRANSPORT=http`) — Full OWASP + Helmet

| OWASP Risk | Control |
|---|---|
| A01 Broken Access Control | `MCP_API_KEY` bearer auth required on all `/mcp` endpoints. Never weaken or route around auth middleware. |
| A02 Cryptographic Failures | IMAP always uses TLS (`secure: true`). Never downgrade. App passwords never logged. |
| A03 Injection | All regex patterns validated with try/catch + `safe-regex2` (ReDoS). No eval, no dynamic code execution. Zod validates all tool inputs at the boundary. |
| A05 Security Misconfiguration | Helmet applied at the Express app level — before any route registration. Covers all endpoints including `/health`. Never add routes that bypass the middleware chain. |
| A06 Vulnerable Components | Flag any new `npm install` additions. Prefer zero-dependency solutions. |
| A07 Auth Failures | `express-rate-limit` must remain active on all HTTP endpoints. Never disable rate limiting. |
| A08 Integrity Failures | Config files written via `atomicWriteFileSync` only. No direct `writeFileSync` on config paths. |
| A09 Logging Failures | Security events (auth failures, rule changes, action applies) logged via Pino. Never log credentials, email bodies, or PII. |
| A10 SSRF | No outbound HTTP calls from tool handlers. IMAP is the only external connection; host/port come from environment variables only. |

**Helmet requirement:** Helmet must be applied at the Express app level (not
per-route). Verify the middleware order before implementing any new HTTP
endpoint: `helmet → cors → rateLimit → auth → routes`.

#### stdio Transport (Default) — Input Validation as the Security Boundary

The stdio transport has no network surface — it trusts the parent process
(Claude Desktop / Claude Code). OWASP HTTP controls (Helmet, rate limiting,
CORS) do not apply. The equivalent security layer is **strict input
validation at every tool boundary**.

**stdio security controls:**

- **Zod schemas are the stdio equivalent of Helmet.** Every tool input is
  validated against its Zod schema before the handler is called. Schemas
  must be strict — no `z.any()`, no optional fields without a defined
  default or explicit rationale.
- **Treat all tool inputs as untrusted regardless of transport.** A
  malformed or adversarial input passed via stdio must produce a clean
  error, not a crash or an unhandled rejection.
- **Injection prevention** — regex patterns (`add_regex_rule`,
  `add_subject_route`) are validated with `safe-regex2` before persistence.
  Email addresses are normalised to lowercase. No shell commands, no eval.
- **Credential isolation** — `YAHOO_EMAIL` and `YAHOO_APP_PASSWORD` are
  read from environment at startup only. Never echoed in tool responses,
  logs, or error messages.
- **Audit trail** — every `apply_action` is logged to `config/audit.jsonl`.
  The audit log is append-only and must not be truncated by tool handlers.

---

## Performance — Always Critical

Performance is a first-class requirement, not an optimisation pass.

### Hot Path Rules

`process_known_senders` is the primary hot path. Any change touching:
- `src/rules/engine.ts` (`lookupSender`)
- `src/tools/process-known-senders.ts`
- `src/imap/operations.ts` (batch apply)

…must include a performance justification and must not degrade throughput.

**Non-negotiable constraints:**
- O(1) exact rule lookup (`Map.get`) must be preserved for all senders
  without subject routes.
- Subject route regex evaluation (`getCompiledRegex` cache) fires only for
  senders that have routes defined — never for the majority path.
- IMAP operations must respect `IMAP_OP_DELAY_MS` between calls.
- Mailbox locks must be acquired for the minimum scope necessary and
  released in `finally` blocks without exception.

### Performance Tests

Every change to a hot path **must** include or update a performance test.

Tests live in `tests/performance/`. Each test must:
- Establish a baseline (current throughput / latency)
- Assert the change does not regress below an acceptable threshold
- Use realistic fixture data (50-email batches, 450+ rules)

> **Gap:** Performance tests do not yet exist. Creating the initial
> `tests/performance/` suite is a standing priority. The first story that
> touches a hot path must create the baseline tests before implementing the
> change.

---

## Test Coverage — Target 100%

Target: 100% coverage of all tool handlers, engine functions, and utility
modules.

> **Gap:** Current coverage is solid but below 100%. Each story must improve
> coverage in the files it touches. Do not merge a story that reduces
> coverage in any file it modifies.

**Test structure:**

| Directory | Scope |
|---|---|
| `tests/unit/` | Single functions, pure logic, no IMAP |
| `tests/integration/` | Tool handlers with mocked IMAP client |
| `tests/edge-cases/` | Error paths, malformed input, boundary values |
| `tests/performance/` | Hot path throughput and latency (to be created) |

**Requirements per story:**
- Every new function → unit test
- Every new MCP tool → integration test: happy path + error path + at least
  two edge cases
- Every hot-path change → performance test
- Run `npm test` before every commit — all tests must pass

### Test Data — Sample Data Only

Tests must use clearly fictitious sample data. Real operational data (real
email addresses, live rule IDs, actual mailbox UIDs, production credentials)
must never appear in test files.

**Standards:**
- Email addresses: `sender@example.com`, `noreply@brand-example.com`,
  `unknown@mystery.com` — never a real address from `sender-rules.json`
- Subjects and names: generic and clearly synthetic
- UIDs: arbitrary integers (100, 200, 1000…) with no relation to a real
  mailbox state
- Rule IDs: `test0001`, `perf0001`, `rule00000000` — never a live UUID

**If a test genuinely requires real data to be meaningful** (e.g. a
production-shape fixture that cannot be anonymised without losing test value),
**stop and discuss with the human engineer before writing the test.** Do not
proceed unilaterally — real data in version history is difficult to remove.

---

## DRY — Enforced

Repeated logic is a defect, not a style issue.

- Validation helpers (action validation, regex validation, subject pattern
  validation) live in `src/rules/config.ts` — use them, don't re-implement.
- `getCompiledRegex()` in `engine.ts` is the single source of truth for
  regex compilation. Do not create local regex caches.
- Shared IMAP patterns (lock → operate → release) must use consistent
  structure. If you find yourself duplicating a lock/release pattern, factor
  it into a helper.
- If the same logic appears in more than two places, refactor before the
  story is marked complete.

---

## Story & Changelog Discipline

### Every Story Gets a File

Create the story file **before** starting work:

```
stories/YYYY-MM-DD_short-kebab-name.md
```

Required fields: Type, Priority, Status (PENDING → COMPLETE), Created date,
problem statement, acceptance criteria.

Stories include: features, bug fixes, investigations/spikes, and
documentation-only changes.

### PII and Credential Redaction in Stories

Before saving a story file, scrub all personally identifiable information,
credentials, and real operational data. Replace with clearly fictitious
sample values.

**Must be redacted:**
- Email addresses → `user@example.com`, `sender@brand-example.com`
- Real folder names or rule IDs from the live config
- API keys, app passwords, tokens of any kind
- Real domain names tied to a live account
- UIDs, message IDs, or other identifiers from real mailboxes

**Pattern:** substitute real values at the time of writing the story, before
the file is committed. Do not redact retroactively after the fact — prevent
the data from entering version history in the first place.

### Changelog — Every Story

Every completed story must have an entry in `CHANGELOG.md` under
`## YYYY-MM-DD — Title`.

Mark items **[CRITICAL]** when:
- Existing tool parameters are removed or renamed (breaking API change)
- Response shapes change in a way that breaks existing callers
- A data migration runs that modifies config files on disk
- Functionality is removed

Use sub-sections: **Added**, **Changed**, **Fixed**, **Removed**.

---

## Development Workflow

### Before Starting
1. Create `stories/YYYY-MM-DD_name.md` with Status: PENDING
2. Read the relevant source files — verify, don't assume
3. Run `npm test` to establish a clean baseline
4. Check `CHANGELOG.md` for recent related changes

### During Implementation
- One logical change per commit
- `npm run build` must be clean before every commit — no TypeScript errors
- No `// @ts-ignore` or untyped `any` without an explanatory comment
- New config schema fields require: startup migration + [CRITICAL] changelog
  entry + updated documentation

### Before Committing — Sprint Completion Checklist

Every story must satisfy all of the following before the commit is made.
This is not optional and is not deferred to a "cleanup" pass.

**Code quality**
1. `npm run build` — clean compile, zero TypeScript errors
2. `npm test` — all tests pass; coverage in touched files ≥ before the story

**Documentation — must be completed before commit, not after**
3. `README.md` — verify the following are current:
   - Project description and tool count
   - Full startup instructions (prerequisites, install, config files,
     first-run behaviour, environment variables, Claude Desktop integration)
   - Tools overview table
   - Built-in actions table
   - Documentation index links
4. `docs/mcp-tools-reference.md` — every new or modified tool has accurate
   parameter tables, flow logic, and response examples
5. `docs/architecture.md` — tool count, source tree, component table, and
   rule/data model reflect the current state
6. `docs/configuration.md` — any new config fields, environment variables,
   or file formats are documented with examples
7. `docs/diagrams/` — if the story changes a processing flow, add or update
   the relevant Mermaid diagram. New flows that don't have a diagram yet
   must get one. Diagrams must render on GitHub without additional tooling.

**Housekeeping**
8. `CHANGELOG.md` — entry added with [CRITICAL] tags where applicable
9. Story file status updated to COMPLETE

### Commit Message Format
```
Short imperative summary (≤72 chars)

- Bullet detail 1
- Bullet detail 2

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Documentation Standards

Documentation is a deliverable, not an afterthought. A story is not complete
until the docs match the code.

### README.md — Always Current

`README.md` is the first thing a new user reads. It must always reflect the
current state of the server. Required sections and what must be kept current:

| Section | What to verify |
|---|---|
| Opening description | Tool count matches actual registered tools |
| **How It Works** | Triage loop steps accurate; rule types (exact, regex, subject routes) described |
| **Tools Overview** | One row per tool, no missing tools, no stale descriptions |
| **Quick Start — Prerequisites** | Node version, Yahoo App Password requirement |
| **Quick Start — Installation** | `git clone`, `npm install`, `npm run build` steps |
| **Quick Start — Configuration** | `.env` setup, config file creation from examples, all required env vars listed |
| **Quick Start — First Run** | What happens on first startup (rules load, prompt creation, preflight checks, how to skip preflight) |
| **Environment Variables** | Full table — every variable, its default, and its effect |
| **Config Files** | Every file in `config/`, its purpose, whether auto-created |
| **Claude Desktop Integration** | Current JSON config block |
| **Documentation table** | Links to all docs files, accurate descriptions |
| **Built-in Actions** | Current 7 built-in actions with folder/flag/read columns |

### Flow Diagrams — Required for New Flows

Mermaid diagrams live in `docs/diagrams/`. They must render on GitHub
without additional tooling (no plugins, no build step).

**A new diagram is required when a story:**
- Adds a new MCP tool with non-trivial internal flow
- Changes how emails are resolved (rule evaluation order, new matching step)
- Changes how actions are applied or how TTL records are managed
- Adds a new startup or session sequence step

**Diagram naming convention:**
```
docs/diagrams/NN_short-description.mermaid
```
where `NN` is the next available sequence number.

**Diagram types to use:**
- `sequenceDiagram` — for tool call flows between Claude and the server
- `flowchart TD` — for decision trees within a processing step
- `graph LR` — for component/data relationships

After adding a diagram, add it to:
- The diagrams table in `README.md`
- The diagrams table in `docs/architecture.md`

### Inline Code Comments

- Comments must describe *why*, not *what* (the code already says what)
- Remove comments that restate the code literally
- Update comments when the code they describe changes — stale comments are
  worse than no comments
- TTL store read/write paths and the regex cache eviction logic must remain
  commented clearly — these are non-obvious

---

## Architecture Constraints

- **Tool count** must be kept current in `README.md`,
  `docs/architecture.md`, and `docs/mcp-tools-reference.md` whenever tools
  are added or removed.
- **New tools** require: handler in `src/tools/`, `init*` function,
  registration in `server.ts` with Zod schema, entry in
  `docs/mcp-tools-reference.md`.
- **IMAP** — always use UIDs (not sequence numbers). Always release locks in
  `finally`. Always delay between operations (`IMAP_OP_DELAY_MS`).
- **Config persistence** — always `atomicWriteFileSync` with backup rotation
  via `rotateBackups`. Never raw `writeFileSync` on config paths.
- **HTTP route order** — new Express routes must be added after:
  `helmet → cors → rateLimit → apiKeyAuth`. Never before.

---

## File Locations

| What | Where |
|---|---|
| MCP tool handlers | `src/tools/<tool-name>.ts` |
| Rules engine | `src/rules/engine.ts` |
| Rules + actions persistence | `src/rules/config.ts` |
| IMAP operations | `src/imap/operations.ts` |
| Shared utilities | `src/utils/` |
| Unit tests | `tests/unit/` |
| Integration tests | `tests/integration/` |
| Edge case tests | `tests/edge-cases/` |
| Performance tests | `tests/performance/` _(to be created)_ |
| Stories | `stories/YYYY-MM-DD_name.md` |
| Changelog | `CHANGELOG.md` |
| Architecture doc | `docs/architecture.md` |
| Tool reference | `docs/mcp-tools-reference.md` |
| Actions reference | `docs/ACTIONS.md` |
| Configuration guide | `docs/configuration.md` |
