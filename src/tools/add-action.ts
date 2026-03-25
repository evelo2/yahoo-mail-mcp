import { getConnection } from '../imap/client.js';
import { registerAction, ensureFolderExists } from '../imap/operations.js';
import { saveCustomActions } from '../rules/config.js';
import { getActionsConfigPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

export async function handleAddAction(params: {
  name: string;
  folder: string;
  mark_read?: boolean;
  flag?: boolean;
}): Promise<{ name: string; folder: string; mark_read: boolean; flag: boolean; created: boolean; existed: boolean }> {
  const name = params.name.toLowerCase();
  const folder = params.folder;

  const result = registerAction(name, {
    moveToFolder: folder,
    markRead: params.mark_read ?? false,
    flag: params.flag ?? false,
  });

  if (result.created) {
    // Persist to disk
    saveCustomActions(getActionsConfigPath());

    // Create the IMAP folder
    const client = await getConnection();
    await ensureFolderExists(client, folder);
    logger.info({ name, folder }, 'Custom action registered, persisted, and folder created');
  }

  return {
    name,
    folder,
    mark_read: params.mark_read ?? false,
    flag: params.flag ?? false,
    created: result.created,
    existed: result.existed,
  };
}
