/**
 * Masks an email address for safe log output.
 *
 * Preserves the domain (useful for IMAP connectivity debugging) while
 * obscuring the local part. Shows at most the first 3 characters so
 * the account is identifiable without exposing the full address.
 *
 * Examples:
 *   "user@example.com" → "use***@example.com"
 *   "ab@example.com"   → "ab***@example.com"
 *   "a@example.com"    → "a***@example.com"
 *   ""                 → "***"
 *   "nodomain"         → "***"
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at); // includes '@'
  const visible = local.slice(0, Math.min(3, local.length));
  return `${visible}***${domain}`;
}
