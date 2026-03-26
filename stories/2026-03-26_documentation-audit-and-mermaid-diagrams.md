# Story: System Documentation Audit & Mermaid Diagram Support

**Date added:** 2026-03-26
**Date actioned:** 2026-03-26
**Status:** Complete

---

## Preamble

This is a housekeeping story with two related goals:

1. **Documentation audit** — The server has evolved significantly since it was first built. Features have been added incrementally (batch processing, TTL modifier, `source_folder` on `apply_action`, the `important` modifier system, multiple new actions). Documentation — inline comments, README, tool descriptions, schema descriptions — may be stale, incomplete, or contradictory. This story asks Claude Code to audit all documentation against the actual implementation and produce an aligned, accurate set of docs.

2. **Mermaid diagram support + UML flows** — The server currently has no visual documentation of its architecture or key processing flows. Adding Mermaid-rendered diagrams to the documentation will make it significantly easier to onboard, debug, and extend the system. This story asks Claude Code to add Mermaid support to the docs toolchain and produce UML-style sequence and flow diagrams for the key MCP processing paths.

This is a **documentation-only story** — no functional code changes. All deliverables are documentation files and diagram sources.

---

## Deliverables

| File | Description |
|---|---|
| `AUDIT_FINDINGS.md` | Documentation gap report — 6 stale, 12 missing, 18 confirmed correct |
| `docs/architecture.md` | Complete rewrite: components, data stores, action/rule model, TTL system |
| `docs/ACTIONS.md` | Complete action reference for all 23 actions |
| `docs/diagrams/01_session_setup.mermaid` | Session startup sequence diagram |
| `docs/diagrams/02_email_triage.mermaid` | Email triage flowchart |
| `docs/diagrams/03_rule_classification.mermaid` | Rule classification sequence |
| `docs/diagrams/04_ttl_expiry.mermaid` | TTL expiry flowchart |
| `docs/diagrams/05_apply_action.mermaid` | apply_action sequence |
| `docs/diagrams/06_architecture.mermaid` | Component overview diagram |
| `README.md` (updated) | Architecture/actions/diagrams added to docs table |
| `docs/mcp-tools-reference.md` (updated) | Tool count fixed, `process_ttl_expirations` section added |

## Audit Summary

- **Stale items fixed:** Tool count "23" → "24" in mcp-tools-reference.md; architecture.md rewritten with current source tree, TTL system, audit log, prompt manager
- **Missing items addressed:** `process_ttl_expirations` added to tools reference; `important` modifier / TTL system documented in architecture.md and ACTIONS.md; complete action reference created
- **Remaining gaps flagged:** `docs/configuration.md` examples don't show `important`/`important_ttl_days` fields (noted in AUDIT_FINDINGS.md for future update)
- **Runtime prompt v5:** Cross-checked, no discrepancies found with implementation
