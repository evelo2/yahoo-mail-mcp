import { resolve, join } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..');

export function getProjectRoot(): string {
  return projectRoot;
}

export function getRulesConfigPath(): string {
  return process.env.RULES_CONFIG_PATH || join(projectRoot, 'config', 'sender-rules.json');
}

export function getActionsConfigPath(): string {
  return process.env.ACTIONS_CONFIG_PATH || join(projectRoot, 'config', 'custom-actions.json');
}

export function getPromptDir(): string {
  return process.env.PROMPT_DIR || join(projectRoot, 'config');
}

/** Max characters to include when returning email body text. */
export const MAX_BODY_LENGTH = 2000;
