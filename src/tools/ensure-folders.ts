import { getConnection } from '../imap/client.js';
import { ensureFolders } from '../imap/operations.js';

export async function handleEnsureFolders() {
  const client = await getConnection();
  return await ensureFolders(client);
}
