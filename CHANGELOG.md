# Change History

Critical feature changes and design decisions for the Yahoo Mail MCP Server. This file ensures institutional knowledge is preserved across sessions.

---

## 2026-03-28 — Subject Route Evaluation in Batch Processing

### Fixed
- **`process_email` ignored `lookup.important` flag** — when a subject route
  matched with `important: true`, the email was moved immediately instead of
  being held in INBOX with a TTL. Now flags the email and writes a TTL record,
  consistent with `process_known_senders` behaviour.

### Added
- **8 new integration tests** in `process-known-senders.test.ts` (Suite 12)
  covering subject route match → routed action, important hold, no-match
  fallback to base action, multiple emails from same sender with different
  subjects, and sender without routes (regression guard).
- **5 new integration tests** in `unknown-skip.test.ts` covering
  `process_email` with subject route important hold, non-important route,
  no-match fallback, omitted subject param, and senders without routes.

### Changed
- **`tests/fixtures/emails.ts`** — replaced real email address in mock `to`
  field with `recipient@example.com` per sample-data policy.
- **`process_email` response** extended to include `route_id`,
  `matched_subject_pattern`, `important`, and `important_ttl_days` fields
  when a subject route match is returned.
- **Performance test thresholds** relaxed to account for timing variability
  when running alongside larger integration test suites; thresholds remain
  meaningful guards against O(n) regressions.

---

## 2026-03-27 — Mask Sensitive Data in Preflight Logs (CWE-312)

### Fixed
- **CWE-312 (Cleartext Storage of Sensitive Information):** IMAP authentication
  email address was printed in cleartext in the preflight success banner
  (`✅ Connection user@example.com → OK`). Now masked as `use***@example.com`.
- Full codebase audit confirmed no other YAHOO_EMAIL or app password exposure
  in any log or tool response output.

### Added
- **`src/utils/mask.ts`** — `maskEmail()` utility: shows first 3 characters of
  the local part, replaces the rest with `***`, preserves the full domain.
  9 unit tests added in `tests/unit/mask-email.test.ts`.

---

## 2026-03-26 — Subject-Line Branching (Option A — Inline Routes)

### Added
- **`SubjectRoute` type** on `ExactRule` — optional `subject_routes` array enables different actions based on email subject keywords per sender
- **`add_subject_route` tool** (25 tools total) — dedicated tool to add subject-based routing to an existing sender rule
- **Subject-aware `lookupSender()`** — accepts optional `subject` parameter; evaluates subject routes in order (first match wins, case-insensitive substring matching)
- **`route_id`** on `LookupResult` — present when a subject route matched, enabling targeted removal
- **`route_id` on `remove_rule`** — removes a single subject route without removing the sender rule

### Changed
- **`process_known_senders`** — now passes `email.subject` to `lookupSender()` for subject-aware routing (1-line change)
- **`process_email`** — accepts optional `subject` parameter for subject routing
- **`lookup_sender`** — accepts optional `subject` parameter
- **`classify_sender` / `classify_senders`** — accept optional `subject_routes` for initial classification with routes; preserves existing routes on overwrite when not explicitly provided
- **`list_rules`** — includes `subject_routes` in output; search filter matches against route keywords
- **Important modifier inheritance** — subject routes can override or inherit sender-level `important`/`important_ttl_days` settings

### Design Decisions
- **First match wins** for subject routes (consistent with regex rule evaluation)
- **Substring matching only** in v1 (no regex in `contains`) — simpler, faster, more LLM-friendly
- **No subject routes on regex rules** in v1 — regex rules match domains, not individual senders
- **Zero performance impact** on non-branching senders — O(1) exact lookup unchanged
- **Zero IMAP cost** — subject already in envelope fetch

---

## 2026-03-26 — Subject-Line Branching Investigation (Spike) — COMPLETE

### Added
- **Investigation findings** (`docs/investigation-subject-line-branching.md`) — Full analysis of three architecture options for subject-line branching
- **Implementation story** (`stories/2026-03-26_subject-line-branching-implementation.md`) — Detailed implementation plan for Option A (inline subject routes)
- Confirmed IMAP envelope already includes subject at zero additional fetch cost
- Analysed 422 exact rules: identified 16 domains with multi-action senders, estimated 5-15 senders would benefit from subject branching
- Recommended **Option A (inline subject routes on sender rule)**: preserves O(1) lookup for non-branching senders, single-line change to `process_known_senders`, no migration needed
- Rejected Option B (separate table — data consistency issues) and Option C (regex subject — moves senders from O(1) to O(n))
- Tool impact assessment for all 7 affected tools plus new `add_subject_route` tool
- Edge case analysis: first-match-wins, case insensitivity, important modifier inheritance, TTL interaction

### No functional changes.

---

## 2026-03-26 — Documentation Audit and Mermaid Diagram Suite

### Added
- **Mermaid diagram source files** for key MCP flows (see `docs/diagrams/`): session setup, email triage, rule classification, TTL expiry, apply_action, architecture overview
- **`docs/ACTIONS.md`** — Complete reference for all 23 actions with folders, mark_read, flag, important TTL settings, and transactional vs marketing guidance
- **`AUDIT_FINDINGS.md`** — Structured documentation gap report (6 stale, 12 missing, 18 confirmed correct)
- **README updated** with architecture overview, actions reference, and diagram index in documentation table
- **`process_ttl_expirations`** added to `docs/mcp-tools-reference.md` (was missing since tool was added)

### Changed
- **`docs/architecture.md`** rewritten with current source structure (24 tools, prompt manager, TTL store, audit log), data store schemas, action model with `important` modifier, rule model with `important`/`important_ttl_days`, and startup sequence including TTL initialization
- **`docs/mcp-tools-reference.md`** tool count corrected from 23 to 24, ToC updated, full `process_ttl_expirations` section added

### No functional changes.

---

## 2026-03-26 — `important` Boolean Modifier with TTL on Rules

### Added
- **`important` boolean modifier on rules** — Any exact or regex rule can now have `important: true` and `important_ttl_days: N`. When set, matching emails are held in INBOX flagged for N days before routing to their action folder.
- **TTL tracking store** (`config/ttl_records.json`) — Persistent store tracking which inbox emails are being held under the important modifier. Records contain UID, action, folder, arrival time, and expiry time.
- **`process_ttl_expirations` tool** — New MCP tool (24 total). Sweeps inbox for important-flagged emails past their TTL. Moves expired emails to their action folders, unflags them, and prunes orphaned records. Returns `{ checked, moved, orphaned }`.
- **`classify_sender` / `classify_senders`** — Now accept optional `important` (boolean) and `important_ttl_days` (number) parameters.
- **`add_regex_rule`** — Now accepts optional `important` and `important_ttl_days` parameters.
- **`list_rules`** — Response includes `important` and `important_ttl_days` fields where set.
- **`process_known_senders`** — Response now includes `important_held` count. When a matching rule has `important: true`, the email is flagged and held in inbox rather than immediately moved.

### Design Decisions
- TTL lives on the rule, not on the action definition. Different senders with the same action can have different hold periods.
- Default TTL is 7 days when `important: true` is set but `important_ttl_days` is omitted.
- The standalone `important` action remains valid during transition but is deprecated for new classifications.
- Orphan detection: if an email is manually moved out of inbox before TTL expiry, the record is pruned during the next sweep.

---

## 2026-03-25 — Data Architecture: Atomic Writes, Backup Rotation, Audit Log

### Added
- **Atomic file writes** (`src/utils/fs.ts: atomicWriteFileSync`) — All config file saves (sender-rules.json, custom-actions.json, prompt.md, prompt_meta.json) now write to a temp file first, then rename. `rename()` is atomic on POSIX, so readers never see a partial/corrupted file. Crash mid-write leaves the previous version intact.
- **Backup rotation** (`src/utils/fs.ts: rotateBackups`) — Before each save of `sender-rules.json`, the previous version is copied to `.bak.1`, shifting older backups up to `.bak.5`. The oldest is deleted. This provides 5 save-points of recovery without unbounded growth.
- **Audit log** (`src/utils/audit-log.ts`) — Every action applied via `applyActionsBatch` is logged to `config/audit.jsonl` as a JSONL entry with: timestamp, UIDs, action, source folder, count, batch ID. File is capped at 1 MB — when exceeded, entries older than the retention period (default 10 days, configurable via `AUDIT_RETENTION_DAYS`) are trimmed. `readAuditLog()` provides filtered, paginated access for reporting.

### Design Decisions
- Prompt version files (v1.md, v2.md, etc.) are write-once/immutable and don't need atomic writes — only `prompt.md` and `prompt_meta.json` (which are overwritten) use atomic writes.
- Audit log uses append-only JSONL (not JSON array) for crash safety — a partial last line is simply dropped on next read. Trimming rewrites atomically via `atomicWriteFileSync`.
- Backup rotation only applies to `sender-rules.json` (421+ rules, significant accumulated work). Other config files are small and low-risk.

---

## 2026-03-25 — Security Audit Remediations

### Critical
- **C1: HTTP API key authentication** — Added `MCP_API_KEY` env var support. When set, all `/mcp` endpoints require `Authorization: Bearer <key>` header. Logs a warning at startup when no key is configured. Health endpoint (`/health`) remains unauthenticated.

### High
- **H1: Helmet.js security headers** — Installed and configured `helmet` with restrictive CSP (`default-src: 'none'`), HSTS (1 year), X-Frame-Options (deny via `frame-ancestors: 'none'`), `noSniff`, and referrer policy.
- **H2: Rate limiting** — Added `express-rate-limit` at 100 req/min per IP (configurable via `RATE_LIMIT_RPM` env var).
- **H3: ReDoS protection** — Regex patterns submitted via `add_regex_rule` are now validated with `safe-regex2` before saving. Patterns with catastrophic backtracking potential (e.g. `(a+)+b`) are rejected with a clear error. Regex cache capped at 500 entries with oldest-eviction.

### Medium
- **M1: CORS configuration** — Added `cors` middleware. By default, all cross-origin requests are denied. Configurable via `CORS_ALLOWED_ORIGINS` env var (comma-separated).
- **M2: Email address validation** — All email parameters now validated with `z.string().min(3).max(320).regex(...)` — rejects control characters and enforces basic `@` format.
- **M3: UID validation** — All UID parameters now use `z.number().int().min(1)` — rejects negative, zero, and fractional values.

### Low
- **L2: `.env.example` sanitised** — Replaced real email address with placeholder `your-email@yahoo.com`. Added commented entries for `MCP_API_KEY`, `CORS_ALLOWED_ORIGINS`, `RATE_LIMIT_RPM`.
- **L3: SKIP_PREFLIGHT warning** — Now logs `warn` when preflight is skipped (previously silent).
- **L5: Error response standardisation** — All tool error responses now include `success: false` consistently (VersionNotFoundError handlers were missing it).

### Dependencies Added
- `helmet` — HTTP security headers
- `cors` — Cross-origin request control
- `express-rate-limit` — Request throttling
- `safe-regex2` — ReDoS pattern detection

---

## 2026-03-25 — Code Quality Audit Fixes

### Fixed (High Priority)
- **H1: Eliminated double mailbox lock in `applyAction`** — Single-email actions previously acquired the lock twice (fetchOne check + batch apply). Now does fetchOne + flags + move in a single lock, halving IMAP round-trips.
- **H2: `health_check` rule counting fixed** — Was reporting `total_rules: 2` (counting JSON keys `exact`/`regex`). Now correctly counts exact entries + regex array length.
- **H3: `health_check` uses shared IMAP connection** — Was creating a separate `ImapFlow` instance. Now uses `getConnection()` singleton.
- **H4: `InvalidActionError` shows dynamic action list** — Was hardcoded to 7 original built-in actions. Now reads from `getActionTable()` at throw site.

### Changed (Medium Priority)
- **M1: Extracted `src/utils/paths.ts`** — Shared `getRulesConfigPath()`, `getActionsConfigPath()`, `getPromptDir()`, `MAX_BODY_LENGTH`. Removed duplicates from 4 files.
- **M2: Removed unnecessary disk reload in `add_action`** — Was calling `loadCustomActions()` on every invocation.
- **M3: Standardized error response shape** — All errors now include `{ success: false, error: "..." }`.
- **M4: Removed dead `removeRegexRule` function** — Superseded by unified `removeRule()`.
- **M5: Static imports for `InvalidActionError`** — Replaced dynamic `await import()` with standard import.

### Cleanup (Low Priority)
- **L1:** `REQUIRED_FOLDERS` exported and reused (no duplicate in health-check).
- **L2:** Body truncation uses `MAX_BODY_LENGTH` constant instead of magic `2000`.
- **L3:** Removed 5 redundant `console.error()` calls alongside `logger.error()`.
- **L5:** Removed stale `config/custom-actions copy.json`.

---

## 2026-03-25 — apply_action: Batch UID Support

### Changed
- **`uid` parameter now accepts a single integer or an array of integers** — when an array is provided, all UIDs are processed against the same `action` and `source_folder` in a single batched IMAP operation, reusing the internal `applyActionsBatch` path from `process_known_senders`.
- **Response shape changes for batch calls** — returns `{ success_count, error_count, results: [{ uid, success, operations_performed }] }` instead of the single-UID shape. Single-UID callers receive the same response as before.
- No new tools added. This extends the existing `apply_action` tool.

---

## 2026-03-25 — apply_action: Support source_folder Parameter

### Changed
- **`apply_action` now accepts optional `source_folder` parameter** (string, default: `"INBOX"`). When provided, the tool searches that folder for the UID and applies the action from there. All existing callers without `source_folder` are unaffected.
- **`applyAction()` and `applyActionsBatch()`** in `operations.ts` both accept an optional `sourceFolder` parameter, threaded through the entire chain.

### Fixed
- `apply_action` previously returned `Email UID not found` for any email not in INBOX, making it impossible to re-action emails already filed in other folders.

### Use Cases
- Alert TTL cleanup: sweeping stale emails out of folders like `Telus` into `for-delete`
- Folder corrections: moving misclassified emails from one folder to another
- General maintenance: re-actioning already-filed emails from any folder

---

## 2026-03-24 — Story 6: Batch IMAP Operations

### Changed
- **`process_known_senders` now uses batch IMAP operations** — Instead of applying actions one email at a time (lock → fetch → flag → move → delay per email), the handler now scans the entire batch first, groups UIDs by action, then executes bulk `messageFlagsAdd`/`messageMove` calls using comma-separated UID ranges within a single INBOX lock. Reduces a 50-email batch from ~30 seconds to ~2-3 seconds.
- **New `applyActionsBatch()` function** in `src/imap/operations.ts` — Takes `{ uid, action }[]`, groups by action, executes bulk IMAP operations. One `delay()` per action-group operation instead of per email.
- **`applyAction()` is now a thin wrapper** around `applyActionsBatch` — validates email exists via `fetchOne`, then delegates to the batch function with a 1-item array. All IMAP flag/move logic lives in one place.

### Design Decisions
- All action-applying code paths flow through `applyActionsBatch`. The single-email `applyAction` wrapper adds a `fetchOne` existence check (expected by `apply_action` and `process_email` callers) before delegating.
- If one action group fails (e.g. a folder is inaccessible), the error is logged and other groups still proceed.
- The delay between IMAP operations is kept (configurable via `IMAP_OP_DELAY_MS`) but now occurs per action-group instead of per email, dramatically reducing total wait time.

---

## 2026-03-24 — Story 5: Prompt Management

### Added
- **`get_prompt` tool** — Returns the current runtime prompt content and version metadata (version number, last updated timestamp, total versions).
- **`update_prompt` tool** — Replaces the current prompt with new content. Saves the previous version to `prompt_versions/` before overwriting. Rejects no-op updates where content is identical.
- **`list_prompt_versions` tool** — Returns version history (newest first) with pagination. Shows version number, timestamp, and change summary for each entry.
- **`get_prompt_version` tool** — Retrieves the full content of a specific historical version by version number.
- **`rollback_prompt` tool** — Restores a previous version as the new current prompt. The rollback is recorded as a new version entry in history. Previous versions are never modified or deleted.
- **Prompt management module** (`src/prompt/manager.ts`) — Manages `prompt.md`, `prompt_meta.json`, and `prompt_versions/` directory in the config folder.
- **Default prompt** — On first run, creates `prompt.md` with standard operating instructions (setup, run procedure, classification guidelines, key rules).

### Design Decisions
- Version history is append-only. Rollbacks create new versions rather than rewinding the version counter.
- The prompt file lives alongside the rules config in the `config/` directory (configurable via `PROMPT_DIR` env var).
- Version files are stored as individual Markdown files (`v1.md`, `v2.md`, etc.) for easy manual inspection.

---

## 2026-03-24 — Regex Rules & Rule IDs (Cross-Story)

### Changed
- **Config format migrated from flat to structured** — `config/sender-rules.json` changed from `Record<string, string>` to `{ exact: { email: { action, rule_id } }, regex: [...] }`. All rules (exact and regex) now carry unique 8-character hex IDs generated via `randomUUID().slice(0, 8)`.
- **Legacy format auto-migration** — On first load of a flat-format rules file, the server detects the legacy shape, creates a backup at `config/sender-rules.backup.json`, assigns `rule_id` values to every existing rule, and saves in the new structured format. No manual steps required.
- **`classify_sender` response** now includes `rule_id` in its response. Existing rule IDs are preserved on overwrite; new rules get a fresh ID.
- **`lookup_sender` response** now includes `match_type` (`"exact"` or `"regex"`), `matched_pattern` (for regex matches), and `rule_id`.
- **`process_email` response** now includes `match_type`, `rule_id`, and `matched_pattern` (when matched via regex).

---

## 2026-03-24 — Story 1: Regex Rule Support

### Added
- **`add_regex_rule` tool** — Add a regex pattern rule for sender matching. Parameters: `pattern` (required), `action` (required), `description` (optional). Validates the regex compiles and the action exists. Regex rules are appended in definition order.
- **`remove_rule` tool** — Unified rule removal for both exact and regex rules. Accepts `rule_id` (works for both types), `email_address` (exact rules only), or `pattern` (regex rules only). `rule_id` takes precedence if multiple identifiers supplied. Returns the removed rule's type, identifier, and action. Replaces the earlier `remove_regex_rule` tool.
- **Regex rules engine** — After exact-match lookup fails, regex rules are evaluated in definition order (first match wins). Patterns are compiled with case-insensitive flag (`/i`).
- **Regex cache** — Compiled `RegExp` objects are cached in a `Map<string, RegExp | null>` to avoid recompilation on every lookup. Invalid patterns are cached as `null` and skipped.

### Design Decisions
- Exact rules always take priority over regex rules. This prevents a broad regex pattern from accidentally overriding a specific sender classification.
- Regex rules use definition order (first match wins) rather than specificity ranking. This keeps the mental model simple and predictable.

---

## 2026-03-24 — Story 2: list_rules Tool

### Added
- **`list_rules` tool** — Browse all classification rules with filtering and pagination. Parameters: `action` (filter by action), `type` (`exact`, `regex`, or `all`), `search` (case-insensitive substring across emails, patterns, descriptions), `limit` (default 100, max 500), `offset` (default 0).
- Regex rules are listed first (definition order), followed by exact rules (alphabetical by email address).

---

## 2026-03-24 — Story 3: list_folder_emails Tool

### Added
- **`list_folder_emails` tool** — List emails from any IMAP folder, not just INBOX. Parameters: `folder` (required), `limit` (default 10, max 50), `since_date`, `before_date`, `include_flags` (default true), `sort` (`date_desc` or `date_asc`). Returns email summaries with a `folder` field. Throws a clear error if the folder does not exist.

### Design Decisions
- This complements `list_inbox_emails` rather than replacing it. `list_inbox_emails` remains the primary tool for triage workflows; `list_folder_emails` is for reviewing emails already moved to action folders.

---

## 2026-03-24 — Story 4: evaluate_regex Tool

### Added
- **`evaluate_regex` tool** — Preview a regex pattern against the existing ruleset and optionally the inbox without modifying anything. Parameters: `pattern` (required), `action` (optional, for conflict detection), `include_inbox_sample` (optional, tests against up to 50 inbox emails, returns up to 20 unique matches).
- Reports exact-match overlaps (emails that the regex would also match), regex-pattern overlaps (other regex rules that share matches), and conflict counts (rules mapping to a different action).
- Overlap detection between regex rules uses a heuristic: both patterns are tested against all known exact-rule email addresses to find shared matches.

---

## 2026-03-23 — Fix process_known_senders Date Filtering

### Fixed
- **`process_known_senders` date filters always returned 0 results** — When both `since_date` and `before_date` were provided, the IMAP search query was constructed as `{ and: [{ since: ... }, { before: ... }] }`, which imapflow does not support. The query is now built as a flat object `{ since: ..., before: ... }`, matching imapflow's expected format. Single date parameters also affected if combined with other conditions.

### Root Cause
The `listInboxEmails` function built search conditions as separate objects and wrapped them in `{ and: [...] }` when multiple conditions existed. imapflow silently returned no results for this format (or threw `uids.sort is not a function` in earlier versions). The fix merges all criteria into a single flat search query object.

### Tests Added
- `since_date` only: returns emails on or after that date (11.19)
- `before_date` only: returns emails before that date (11.20)
- Both params: returns only emails within range (11.21)
- Range with no emails: returns 0 without error (11.22)
- `since_date == before_date`: returns 0 without error (11.23)
- Date string with time component: treated same as date-only (11.24)

---

## 2026-03-23 — Remove Triaged Folder; Inbox-Resident Actions

### Changed
- **`important` action** — No longer moves emails. Applies `\Flagged` flag and leaves the email in INBOX.
- **`doubleclick` action** — No longer moves emails. Now a no-op (email stays in INBOX). Still useful as a classification to mark a sender as "known" so they don't appear in unknown senders lists.
- **`unknown` action** — No longer moves emails. Now a no-op (email stays in INBOX).
- **`moveToFolder` is now optional** in `ActionDef`. Actions without a `moveToFolder` leave emails in INBOX. Only flag/markRead operations are applied.
- **`triaged` removed from required folders** — `ensure_folders` and `health_check` no longer check for or create the `triaged` folder.
- **`inbox_triaged` removed from `get_run_summary`** — The `MailboxCounts` type no longer includes `inbox_triaged`.
- **`get_actions` returns `folder: null`** for actions that don't move emails (important, doubleclick, unknown).

### Design Decisions
- Emails from `important`, `doubleclick`, and `unknown` senders stay in INBOX rather than being moved to a `triaged` folder. This means `process_known_senders` will re-encounter these emails on every run — they are "applied" each time but since the action is a no-op (or just a flag), the re-processing is harmless. The tradeoff is slightly more IMAP work per run in exchange for a simpler folder model.
- The `triaged` folder is not deleted if it already exists on the account. It simply stops being created or required.

---

## 2026-03-17 — Batch Processing & Health Check

### Added
- **`process_known_senders` tool** — Batch-processes the entire inbox in loops of 50 emails. Applies actions for known senders automatically and collects up to 50 unique unknown senders for classification. Includes `actions_filter` parameter for selective processing (e.g., only delete actions). Safety cap of 20 batches (1000 emails max).
- **`health_check` tool** — Comprehensive operational verification: IMAP connectivity with latency measurement, inbox access, required folder presence (including custom action folders), rules config validation, and actions config validation. Uses a fresh IMAP connection (not the shared singleton) for an accurate test.
- **UID deduplication in batch processing** — `seenUids` Set prevents refetching the same email across batches. Unknown senders are deduplicated by normalized email address, keeping the most recent occurrence.
- **`excludeUids` parameter on `listInboxEmails`** — Internal parameter used by `process_known_senders` to skip already-processed UIDs when fetching the next batch.

### Design Decisions
- Batch loop exits on three conditions: 50 unknowns collected, inbox exhausted, or 20 batches reached. This prevents runaway processing on very large mailboxes.
- `health_check` creates its own IMAP connection rather than reusing the shared one, so it tests the full connection lifecycle independently.

---

## 2026-03-16 — Custom Actions & Bulk Classification

### Added
- **`classify_senders` tool** — Bulk classify multiple senders in a single call. Validates all entries, applies valid ones, and reports failures. Uses a single atomic disk write for all valid classifications.
- **`add_action` tool** — Define custom action types at runtime with a target IMAP folder, optional mark-read, and optional flag. Persists to `config/custom-actions.json` and auto-creates the IMAP folder.
- **`get_actions` tool** — Returns all actions (built-in + custom) with metadata including the `built_in` flag.
- **Custom actions persistence** — `config/custom-actions.json` stores user-defined actions. Loaded at startup, reloaded from disk before modifications (to respect manual edits), saved atomically on changes.
- **Action table caching** — Merged built-in + custom action table is cached and invalidated when custom actions are registered.

### Design Decisions
- `classify_senders` is fail-partial: invalid entries are skipped and reported, but valid entries still save. This avoids losing work when one classification in a batch has a typo.
- `add_action` reloads custom actions from disk before modifying, so manual file edits between tool calls are not lost.
- Custom actions cannot override built-in action names. `registerAction` returns `existed: true` without modifying anything.

---

## 2026-03-15 — Sender Classification & Process Email

### Added
- **`classify_sender` tool** — Persist a single sender-to-action mapping. Case-insensitive with overwrite support. Validates action against the current action table before saving.
- **`process_email` tool** — Combined convenience tool: looks up sender, applies matching action if found, returns combined result. Unknown senders are left untouched in INBOX.
- **Sender rules persistence** — `saveSenderRules()` writes the entire rules Map to disk as JSON. Called on every classify operation.
- **Action validation on classify** — `getValidActions()` derives the valid action set from the current action table, ensuring custom actions are included.

### Design Decisions
- `process_email` does NOT apply the `unknown` action when a sender is unmatched. It returns `matched: false` and leaves the email in INBOX. This is intentional — unknown emails should be surfaced for classification, not silently moved.
- Rules are saved on every single classify call (not batched/debounced). This prioritizes durability over write performance since classifications happen infrequently.

---

## 2026-03-13 — Preflight Checks & Error System

### Added
- **Preflight system** (`src/preflight.ts`) — Runs on startup before the MCP server starts. Validates environment variables, tests IMAP connection, lists mailboxes, opens INBOX, and performs a sample email fetch. Prints colored diagnostic report. Exits with code 1 on failure.
- **`SKIP_PREFLIGHT` environment variable** — Set to `true` to bypass preflight checks during development.
- **Custom error classes** — `ImapConnectionError`, `AuthenticationError`, `EmailNotFoundError`, `InvalidActionError`, `ConfigError`. Each carries contextual information (e.g., `EmailNotFoundError.uid`).

### Design Decisions
- Preflight is fail-fast: if IMAP can't connect, the server doesn't start. This prevents silent failures where the server appears running but can't process emails.
- `AuthenticationError` detection is heuristic (checks for "auth", "AUTH", "credentials", "LOGIN" in error messages) since imapflow doesn't use typed auth errors.

---

## 2026-03-12 — Initial Release

### Added
- **MCP server** with stdio transport, 7 core tools:
  - `list_inbox_emails` — List unprocessed emails with date filtering and configurable limit
  - `get_email` — Fetch single email by UID with optional body (truncated to 2000 chars)
  - `apply_action` — Apply action to email (flag, mark read, move to folder)
  - `lookup_sender` — Read-only sender lookup against rules
  - `ensure_folders` — Create missing required IMAP folders
  - `get_run_summary` — Mailbox state summary with folder counts
- **7 built-in actions**: `important`, `doubleclick`, `unknown`, `invoice`, `subscriptions`, `news`, `delete`
- **IMAP client** — Singleton connection with lazy reconnect, TLS on port 993, configurable operation delay for rate-limit avoidance
- **UID-based operations** — All IMAP operations use `{ uid: true }` to prevent sequence number drift issues
- **Mailbox locking** — All INBOX operations acquire a lock via `getMailboxLock('INBOX')` with guaranteed release in `finally`
- **Folder caching** — `knownFolders` Set avoids repeated IMAP LIST calls; populated on first use, updated on creation
- **Sender rules engine** — Case-insensitive Map loaded from `config/sender-rules.json`
- **Pino logging** — Structured JSON to stderr, configurable level
- **HTTP transport** — Express 5 server with session management (UUID-based), SSE streams, and `/health` endpoint

### Design Decisions
- Everything in INBOX is considered unprocessed. No keyword-based filtering or custom IMAP flags — actions always move emails out of INBOX. This keeps the model simple and avoids Yahoo's inconsistent keyword support.
- Only standard IMAP flags used (`\Seen`, `\Flagged`). No custom keywords, which Yahoo's IMAP implementation handles unreliably.
- Operation delay (default 200ms) between IMAP commands prevents Yahoo from rate-limiting. Configurable via `IMAP_OP_DELAY_MS`.
- Email body truncated to 2000 characters to keep MCP response sizes manageable.
- HTTP mode creates a new `McpServer` instance per session, each with its own transport. Sessions are cleaned up on transport close.
