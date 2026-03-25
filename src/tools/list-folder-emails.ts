import { getConnection } from '../imap/client.js';
import { listFolderEmails } from '../imap/operations.js';

export async function handleListFolderEmails(params: {
  folder: string;
  limit?: number;
  since_date?: string;
  before_date?: string;
  include_flags?: boolean;
  sort?: 'date_desc' | 'date_asc';
}) {
  const client = await getConnection();
  return await listFolderEmails(client, params.folder, {
    limit: params.limit,
    sinceDate: params.since_date,
    beforeDate: params.before_date,
    sort: params.sort,
    includeFlags: params.include_flags,
  });
}
