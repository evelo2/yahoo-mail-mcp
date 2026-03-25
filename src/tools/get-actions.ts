import { getActionTable, type ActionDef } from '../imap/operations.js';
import { loadCustomActions } from '../rules/config.js';
import { getActionsConfigPath } from '../utils/paths.js';

export interface ActionInfo {
  name: string;
  folder: string | null;
  mark_read: boolean;
  flag: boolean;
  built_in: boolean;
}

export async function handleGetActions(): Promise<{ actions: ActionInfo[]; total: number }> {
  // Reload from disk to pick up any manual edits
  loadCustomActions(getActionsConfigPath());
  const table = getActionTable();
  const actions: ActionInfo[] = Object.entries(table).map(([name, def]) => ({
    name,
    folder: def.moveToFolder ?? null,
    mark_read: def.markRead ?? false,
    flag: def.flag ?? false,
    built_in: def.builtIn ?? true,
  }));

  return { actions, total: actions.length };
}
