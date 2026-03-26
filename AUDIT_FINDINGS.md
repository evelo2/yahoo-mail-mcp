# Documentation Audit Findings

Audit performed 2026-03-26 against the live codebase and runtime state.

---

## Stale — Description contradicts current behaviour

### S1. Tool count: "23 tools" → should be 24

The `process_ttl_expirations` tool was added but several docs still reference 23.

| File | Line(s) | Current text | Corrected |
|---|---|---|---|
| `docs/mcp-tools-reference.md` | 3 | "all 23 MCP-exposed tools" | "all 24 MCP-exposed tools" |
| `docs/architecture.md` | 9 | "23 tools registered" | "24 tools registered" |
| `docs/architecture.md` | 31 | "registers all 23 tools" | "registers all 24 tools" |
| `docs/architecture.md` | 80 | "Create MCP server with 23 tools" | "Create MCP server with 24 tools" |

**Note:** `README.md` (line 3) and `src/server.ts` (line 479) already say 24 — correct.

### S2. `docs/architecture.md` source tree is stale

The source structure listing is missing files added since initial documentation:

| Missing entry | Location in tree |
|---|---|
| `src/prompt/manager.ts` | New `prompt/` directory |
| `src/utils/ttl-store.ts` | Under `utils/` |
| `src/utils/fs.ts` | Under `utils/` |
| `src/utils/audit-log.ts` | Under `utils/` |
| `src/tools/process-ttl-expirations.ts` | Under `tools/` |

### S3. `docs/architecture.md` action table example references non-existent action

Line 156 shows `receipts` as a custom action example. This action does not exist in the live system. Should use a real custom action (e.g., `social` with folder `Social Media`).

### S4. `docs/architecture.md` rules data model missing `important`/`important_ttl_days`

The exact rules and regex rules tables (lines 131–146) do not show the `important` or `important_ttl_days` fields, which are now part of both rule types.

### S5. `docs/configuration.md` sender rules example missing `important`/`important_ttl_days`

The example JSON (lines 47–69) shows exact and regex rules without the `important` or `important_ttl_days` fields. These are optional but should be shown in at least one example rule to document the schema.

### S6. `docs/architecture.md` startup sequence missing TTL initialization

Steps 1–8 do not include TTL store initialization (`initTtlStore`), which happens during startup.

---

## Missing — Behaviour exists but is not documented

### M1. `process_ttl_expirations` not in tools reference

`docs/mcp-tools-reference.md` has no entry for this tool. The Table of Contents lists 23 tools — `process_ttl_expirations` is absent. Needs a full entry covering parameters (none), flow logic, and response shape `{ checked, moved, orphaned }`.

### M2. TTL / important modifier system not documented in any docs/ file

The `important` boolean modifier, `important_ttl_days` field, TTL store (`config/ttl_records.json`), and the hold-then-route lifecycle are only described in the runtime prompt (`config/prompt.md` v5). None of the `docs/` files cover:
- What `important: true` does on a rule
- Default TTL (7 days) when `important_ttl_days` is omitted
- The hold lifecycle: flag → hold in INBOX → TTL expires → route to action folder
- `process_ttl_expirations` sweep logic
- `important_held` count in `process_known_senders` response

### M3. `important_held` in `process_known_senders` response undocumented

The tools reference documents the response fields for `process_known_senders` but does not mention `important_held` in the response summary.

### M4. `docs/configuration.md` missing TTL records file

The "Required IMAP Folders" and config files sections do not mention `config/ttl_records.json` or its schema.

### M5. `docs/configuration.md` missing audit log reference

No mention of `config/audit.jsonl`, its JSONL format, retention policy, or 1 MB cap. (The README does cover this under "Data Integrity".)

### M6. `docs/architecture.md` missing audit log component

The architecture doc does not mention the audit log, its append-only nature, or retention trimming.

### M7. `docs/architecture.md` missing prompt management component

The `src/prompt/` directory and prompt versioning system are not documented in the architecture doc's source structure or component descriptions.

### M8. No Mermaid diagrams or visual documentation

No diagrams exist anywhere in the docs. Key flows (session setup, email triage, TTL expiry, rule classification) would benefit from visual documentation.

### M9. No complete action reference document

There is no single document listing all 23 actions with their full properties (folder, mark_read, flag, built_in, TTL settings). The README lists only the 7 built-in actions. The runtime prompt has a TTL table but not the full action properties.

### M10. `list_rules` response `important`/`important_ttl_days` fields undocumented

The tools reference for `list_rules` does not mention that results now include `important` and `important_ttl_days` fields on each rule.

### M11. `classify_sender`/`classify_senders` `important`/`important_ttl_days` parameters undocumented in tools reference

While the MCP schema descriptions include these parameters, the detailed tools reference doc does not document them in its parameter tables.

### M12. `add_regex_rule` `important`/`important_ttl_days` parameters undocumented in tools reference

Same as M11 — the tools reference parameter table does not include these fields.

---

## Correct — Confirmed accurate

| Item | Location | Status |
|---|---|---|
| README tool count | `README.md` line 3 | ✓ Says "24 tools" |
| README tools overview table | `README.md` lines 17–42 | ✓ Lists all 24 tools |
| README built-in actions | `README.md` lines 183–192 | ✓ Accurate 7 built-in actions |
| README environment variables | `README.md` lines 96–112 | ✓ Complete and accurate |
| README data integrity section | `README.md` lines 129–133 | ✓ Covers atomic writes, backups, audit log |
| README security section | `README.md` lines 137–144 | ✓ Accurate HTTP security measures |
| `src/server.ts` tool count log | Line 479 | ✓ Says "24 tools" |
| Tools reference: `apply_action` | `docs/mcp-tools-reference.md` | ✓ Documents `source_folder`, batch UIDs |
| Tools reference: `list_folder_emails` | `docs/mcp-tools-reference.md` | ✓ Accurate parameters and flow |
| Tools reference: `evaluate_regex` | `docs/mcp-tools-reference.md` | ✓ Accurate description |
| Configuration: env vars | `docs/configuration.md` | ✓ Complete and accurate |
| Configuration: legacy migration | `docs/configuration.md` | ✓ Accurate description |
| Configuration: regex cache | `docs/configuration.md` | ✓ Matches implementation |
| Architecture: IMAP integration | `docs/architecture.md` lines 89–124 | ✓ UID-based ops, locking, rate limiting |
| Architecture: transport modes | `docs/architecture.md` lines 185–214 | ✓ Accurate stdio + HTTP description |
| Architecture: error handling | `docs/architecture.md` lines 219–238 | ✓ All 5 custom error classes listed |
| Architecture: lookup flow | `docs/architecture.md` lines 163–171 | ✓ Accurate exact → regex → unknown flow |
| Runtime prompt v5 | `config/prompt.md` | ✓ Matches implementation for TTL, actions, session setup |

---

## Cross-check: Runtime Prompt v5 vs Implementation

| Prompt claim | Implementation | Match? |
|---|---|---|
| 23 actions total | `get_actions` returns 23 | ✓ |
| Default TTL 7d for important modifier | `ttl-store.ts` default | ✓ |
| `apply_action` batch limit 20 UIDs | Enforced in handler | ✓ |
| Alert cleanup: list + batch delete from Alerts | Works with `source_folder: "Alerts"` | ✓ |
| `process_ttl_expirations` returns `{ checked, moved, orphaned }` | Handler confirms | ✓ |
| TTL values per action (bank 1d, invoice 1d, etc.) | These are prompt-level guidance, not code-enforced | ✓ (by design) |

**No discrepancies found between runtime prompt v5 and implementation.**

---

## Summary

| Category | Count |
|---|---|
| **Stale** | 6 items |
| **Missing** | 12 items |
| **Correct** | 18 items verified |
| **Prompt cross-check** | No discrepancies |
