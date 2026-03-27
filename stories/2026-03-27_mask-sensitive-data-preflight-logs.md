# Story: Mask Sensitive Data in Preflight Logs (CWE-312)

**Type:** Security Fix
**Priority:** Medium
**Status:** COMPLETE
**Created:** 2026-03-27
**CWE:** [CWE-312 — Cleartext Storage of Sensitive Information](https://cwe.mitre.org/data/definitions/312.html)
**Source:** Veracode scan

---

## Finding

During preflight (health check / startup sequence), the application logs the
IMAP email address in cleartext as part of the test connection parameters.
This was flagged as a **medium severity** finding under CWE-312.

While the server runs locally and logs are not persisted to a remote service,
cleartext PII in logs is a recognized vulnerability — log files can be
inadvertently shared, committed to version control, captured by crash
reporters, or exposed in container environments.

---

## Current Behavior

The email address (used for IMAP authentication) appears in log output during
preflight in this form:

- Preflight banner: `✅ Connection      user@example.com → OK`

---

## Audit Findings

Full codebase audit performed across all `console.*`, `logger.*`, and tool
response paths.

| Location | Content | Action |
|---|---|---|
| `src/preflight.ts:127` | `result.email` in success banner | **Fix: mask** |
| `src/imap/client.ts:39` | `pass: cfg.appPassword` in auth config object — not logged (`logger: false`) | Clean — no action |
| `src/imap/client.ts:56` | `logger.info('IMAP connection established')` — no email | Clean |
| `src/tools/health-check.ts:145` | `logger.info({ healthy, errorCount })` — no email | Clean |
| `src/tools/classify-sender.ts:76` | `email: normalized` — classified sender address, not the auth credential | Out of scope |
| App password | Not found in any log output | Clean |

**Result:** One fix required. App password confirmed absent from all log output.

---

## Required Changes

### 1. `maskEmail()` utility — `src/utils/mask.ts`

```typescript
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at); // includes '@'
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}***${domain}`;
}
// "user@example.com" → "use***@example.com"
// "ab@example.com"  → "ab***@example.com"
// "a@example.com"   → "a***@example.com"
// ""                → "***"
// "nodomain"        → "***"
```

### 2. `src/preflight.ts` — mask the success banner line

```typescript
// Before:
console.log(`  ✅ Connection      ${result.email} → OK`);

// After:
console.log(`  ✅ Connection      ${maskEmail(result.email)} → OK`);
```

---

## Acceptance Criteria

- [x] `maskEmail()` utility function created and unit tested
- [x] Email address masked in preflight success banner
- [x] MCP tool responses still return full email addresses (no masking)
- [x] Config files still store full email addresses (no masking)
- [x] App password confirmed to never appear in any log output
- [x] Masked format: `pau***@domain.com` (first 3 chars + `***` + full domain)

---

## Test Cases

| Input | Masked Output |
|---|---|
| `user@example.com` | `use***@example.com` |
| `ab@example.com` | `ab***@example.com` |
| `a@example.com` | `a***@example.com` |
| `(empty string)` | `***` |
| `(no @ sign)` | `***` |

---

## Out of Scope

- Log aggregation or log rotation (server runs locally)
- Encrypting config files at rest
- Masking email addresses in MCP tool responses
