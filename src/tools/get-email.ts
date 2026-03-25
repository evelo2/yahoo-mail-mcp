import { getConnection } from '../imap/client.js';
import { getEmail } from '../imap/operations.js';

export async function handleGetEmail(params: {
  uid: number;
  include_body?: boolean;
}) {
  const client = await getConnection();
  return await getEmail(client, params.uid, params.include_body);
}
