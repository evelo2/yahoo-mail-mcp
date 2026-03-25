import { getConnection } from '../imap/client.js';
import { listInboxEmails } from '../imap/operations.js';

export async function handleListInboxEmails(params: {
  limit?: number;
  since_date?: string;
  before_date?: string;
}) {
  const client = await getConnection();
  return await listInboxEmails(client, {
    limit: params.limit,
    sinceDate: params.since_date,
    beforeDate: params.before_date,
  });
}
