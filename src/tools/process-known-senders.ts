import type { SenderRules } from '../rules/config.js';
import { lookupSender } from '../rules/engine.js';
import { getConnection } from '../imap/client.js';
import { listInboxEmails, applyActionsBatch } from '../imap/operations.js';
import { logger } from '../utils/logger.js';

const BATCH_SIZE = 50;
const UNKNOWN_LIMIT = 50;
const MAX_BATCHES = 20; // Safety limit: process at most 1000 emails (20 × 50)

let rules: SenderRules;

export function initProcessKnownSenders(senderRules: SenderRules) {
  rules = senderRules;
}

interface UnknownSender {
  uid: number;
  from_address: string;
  from_name: string;
  subject: string;
}

interface ProcessKnownSendersResult {
  total_fetched: number;
  known_processed: number;
  known_filtered_out: number;
  unknown_skipped: number;
  errors: number;
  actions_filter: string[] | null;
  batches: number;
  actions_summary: Record<string, number>;
  unknown_senders: UnknownSender[];
}

export async function handleProcessKnownSenders(params: {
  since_date?: string;
  before_date?: string;
  actions_filter?: string[];
}): Promise<ProcessKnownSendersResult> {
  const client = await getConnection();
  const filterSet = params.actions_filter?.length
    ? new Set(params.actions_filter.map(a => a.toLowerCase()))
    : null;

  const unknownAddresses = new Map<string, UnknownSender>(); // dedup by address
  const seenUids = new Set<number>();
  const actionsSummary: Record<string, number> = {};
  let knownProcessed = 0;
  let filteredOutCount = 0;
  let errors = 0;
  let totalFetched = 0;
  let batches = 0;

  // Loop: fetch batches until we have enough unique unknown senders, inbox is exhausted, or max batches reached
  while (unknownAddresses.size < UNKNOWN_LIMIT && batches < MAX_BATCHES) {
    const emails = await listInboxEmails(client, {
      limit: BATCH_SIZE,
      sinceDate: params.since_date,
      beforeDate: params.before_date,
      excludeUids: seenUids,
    });

    if (emails.length === 0) break; // no more emails in inbox for this date range

    batches++;
    totalFetched += emails.length;

    // Scan batch: classify each email, collect actions to apply
    const pendingActions: Array<{ uid: number; action: string }> = [];

    for (const email of emails) {
      seenUids.add(email.uid);
      const lookup = lookupSender(rules, email.from_address);

      if (!lookup.matched) {
        // Dedup unknown senders by address, keep first occurrence (most recent)
        const normalized = email.from_address.toLowerCase();
        if (!unknownAddresses.has(normalized)) {
          unknownAddresses.set(normalized, {
            uid: email.uid,
            from_address: email.from_address,
            from_name: email.from_name,
            subject: email.subject,
          });
        }
        continue;
      }

      // If filter is set, skip actions not in the filter
      if (filterSet && !filterSet.has(lookup.action)) {
        filteredOutCount++;
        continue;
      }

      pendingActions.push({ uid: email.uid, action: lookup.action });
    }

    // Batch-apply all actions at once (single INBOX lock, bulk IMAP ops)
    if (pendingActions.length > 0) {
      const batchResult = await applyActionsBatch(client, pendingActions);
      knownProcessed += batchResult.applied;
      errors += batchResult.errors;
      for (const [action, count] of Object.entries(batchResult.actions_summary)) {
        actionsSummary[action] = (actionsSummary[action] || 0) + count;
      }
    }
  }

  const unknownSenders = [...unknownAddresses.values()];

  logger.info({
    total: totalFetched,
    known: knownProcessed,
    filteredOut: filteredOutCount,
    unknown: unknownSenders.length,
    errors,
    batches,
    filter: filterSet ? [...filterSet] : null,
  }, 'process_known_senders complete');

  return {
    total_fetched: totalFetched,
    known_processed: knownProcessed,
    known_filtered_out: filteredOutCount,
    unknown_skipped: unknownSenders.length,
    errors,
    actions_filter: filterSet ? [...filterSet] : null,
    batches,
    actions_summary: actionsSummary,
    unknown_senders: unknownSenders,
  };
}
