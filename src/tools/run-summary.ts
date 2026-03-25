import { getConnection } from '../imap/client.js';
import { getMailboxCounts } from '../imap/operations.js';

export async function handleGetRunSummary() {
  const client = await getConnection();
  return await getMailboxCounts(client);
}
