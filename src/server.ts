import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SenderRules } from './rules/config.js';
import { handleListInboxEmails } from './tools/list-inbox.js';
import { handleGetEmail } from './tools/get-email.js';
import { handleApplyAction } from './tools/apply-action.js';
import { handleEnsureFolders } from './tools/ensure-folders.js';
import { handleLookupSender, initLookupSender } from './tools/lookup-sender.js';
import { handleProcessEmail, initProcessEmail } from './tools/process-email.js';
import { handleGetRunSummary } from './tools/run-summary.js';
import { handleClassifySender, initClassifySender } from './tools/classify-sender.js';
import { handleClassifySenders, initClassifySenders } from './tools/classify-senders.js';
import { handleAddAction } from './tools/add-action.js';
import { handleGetActions } from './tools/get-actions.js';
import { handleProcessKnownSenders, initProcessKnownSenders } from './tools/process-known-senders.js';
import { handleHealthCheck } from './tools/health-check.js';
import { handleAddRegexRule, initAddRegexRule } from './tools/add-regex-rule.js';
import { handleRemoveRule, initRemoveRule } from './tools/remove-rule.js';
import { handleListRules, initListRules } from './tools/list-rules.js';
import { handleListFolderEmails } from './tools/list-folder-emails.js';
import { handleEvaluateRegex, initEvaluateRegex } from './tools/evaluate-regex.js';
import { handleProcessTtlExpirations } from './tools/process-ttl-expirations.js';
import { handleAddSubjectRoute, initAddSubjectRoute } from './tools/add-subject-route.js';
import {
  getPrompt,
  updatePrompt,
  listPromptVersions,
  getPromptVersion,
  rollbackPrompt,
  VersionNotFoundError,
} from './prompt/manager.js';
import { logger } from './utils/logger.js';

// Shared Zod refinements for reuse across tool schemas
const zUid = z.number().int().min(1).describe('The email UID');
const zUidOrArray = z.union([z.number().int().min(1), z.array(z.number().int().min(1)).min(1)]).describe('The email UID, or an array of UIDs to process in batch');
const zEmail = z.string().min(3).max(320).regex(/^[^\x00-\x1f]+@[^\x00-\x1f]+$/, 'Invalid email address format').describe('Sender email address');

export function createServer(rules: SenderRules): McpServer {
  initLookupSender(rules);
  initProcessEmail(rules);
  initClassifySender(rules);
  initClassifySenders(rules);
  initProcessKnownSenders(rules);
  initAddRegexRule(rules);
  initRemoveRule(rules);
  initListRules(rules);
  initEvaluateRegex(rules);
  initAddSubjectRoute(rules);

  const server = new McpServer({
    name: 'yahoo-mail',
    version: '1.0.0',
  });

  server.tool(
    'list_inbox_emails',
    'List emails in the Inbox that have NOT been processed (triaged). Returns envelope data only.',
    {
      limit: z.number().min(1).max(50).optional().describe('Max emails to return (default: 10, max: 50)'),
      since_date: z.string().optional().describe('ISO date string. Only return emails received on or after this date.'),
      before_date: z.string().optional().describe('ISO date string. Only return emails received before this date.'),
    },
    async (params) => {
      try {
        const result = await handleListInboxEmails(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'get_email',
    'Fetch a single email by UID with full details.',
    {
      uid: zUid,
      include_body: z.boolean().optional().describe('Whether to include the plain text body (default: false)'),
    },
    async (params) => {
      try {
        const result = await handleGetEmail(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'apply_action',
    'Apply a rule action to one or more emails. Pass a single uid (number) or an array of uids for batch processing. source_folder defaults to INBOX.',
    {
      uid: zUidOrArray,
      action: z.string().describe('The action to apply'),
      source_folder: z.string().optional().describe('IMAP folder containing the email(s) (default: INBOX). Use for emails already filed in other folders.'),
    },
    async (params) => {
      try {
        const result = await handleApplyAction(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'ensure_folders',
    'Create any missing folders required by the rules engine (invoices, subscriptions, news, for-delete). Does not include triaged — emails from important, doubleclick, and unknown senders remain in INBOX.',
    {},
    async () => {
      try {
        const result = await handleEnsureFolders();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'lookup_sender',
    'Look up a sender email address against the rules config and return the action. If subject is provided, evaluates subject routes for branching senders.',
    {
      email_address: zEmail,
      subject: z.string().optional().describe('Email subject line. If provided, evaluates subject routes on the matched sender rule.'),
    },
    async (params) => {
      try {
        const result = await handleLookupSender(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'process_email',
    'Combined tool: looks up sender, applies the matching action, returns the result.',
    {
      uid: zUid,
      from_address: zEmail,
      subject: z.string().optional().describe('Email subject line. If provided, evaluates subject routes for branching senders.'),
    },
    async (params) => {
      try {
        const result = await handleProcessEmail(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'get_run_summary',
    'Return a summary of the current mailbox state relevant to processing.',
    {},
    async () => {
      try {
        const result = await handleGetRunSummary();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  const zSubjectRouteInput = z.object({
    pattern: z.string().min(1).describe('Regex pattern matched case-insensitively against subject line. Use | for OR: "ship|track|deliver". Use .* between words: "order.*confirm".'),
    action: z.string().describe('The action to apply when subject matches'),
    important: z.boolean().optional().describe('Override sender-level important setting for this route'),
    important_ttl_days: z.number().int().min(1).optional().describe('Days to hold when important'),
  });

  server.tool(
    'classify_sender',
    'Persist a new sender-to-action mapping to the rules config. Case-insensitive. Supports overwrite.',
    {
      email_address: zEmail,
      action: z.string().describe('The action to assign (must be a valid action name)'),
      important: z.boolean().optional().describe('When true, email is held in inbox flagged for TTL duration before routing to action folder'),
      important_ttl_days: z.number().int().min(1).optional().describe('Days to hold in inbox when important (default: 7)'),
      subject_routes: z.array(zSubjectRouteInput).optional().describe('Optional subject-based routing. When provided, replaces all existing subject routes.'),
    },
    async (params) => {
      try {
        const result = await handleClassifySender(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'classify_senders',
    'Bulk classify multiple senders at once. Validates each action, saves all valid entries in one atomic write, and reports any failures.',
    {
      classifications: z.array(z.object({
        email_address: z.string().describe('The sender email address'),
        action: z.string().describe('The action to assign'),
        important: z.boolean().optional().describe('When true, hold in inbox flagged for TTL duration'),
        important_ttl_days: z.number().int().min(1).optional().describe('Days to hold when important (default: 7)'),
        subject_routes: z.array(zSubjectRouteInput).optional().describe('Optional subject-based routing for this sender'),
      })).describe('Array of sender-to-action classifications'),
    },
    async (params) => {
      try {
        const result = await handleClassifySenders(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'add_action',
    'Define a new action type with a custom folder and flags. Creates the IMAP folder if needed.',
    {
      name: z.string().describe('The action name (lowercase, no spaces)'),
      folder: z.string().describe('The IMAP folder to move emails to'),
      mark_read: z.boolean().optional().describe('Whether to mark emails as read (default: false)'),
      flag: z.boolean().optional().describe('Whether to flag/star emails (default: false)'),
    },
    async (params) => {
      try {
        const result = await handleAddAction(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'get_actions',
    'Return all currently defined actions (built-in + user-created) with metadata.',
    {},
    async () => {
      try {
        const result = await handleGetActions();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'process_known_senders',
    'Batch process inbox: loops through all emails in batches of 50, applies actions for known senders, collects up to 50 unique unknown senders for classification.',
    {
      since_date: z.string().optional().describe('ISO date string. Only process emails received on or after this date.'),
      before_date: z.string().optional().describe('ISO date string. Only process emails received before this date.'),
      actions_filter: z.array(z.string()).optional().describe('Only process emails matching these action types (e.g. ["delete", "subscriptions"]). Omit to process all known senders.'),
    },
    async (params) => {
      try {
        const result = await handleProcessKnownSenders(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'health_check',
    'Verify the server is fully operational: IMAP connectivity, inbox access, required folders, rules config, and actions config.',
    {},
    async () => {
      try {
        const result = await handleHealthCheck();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'add_regex_rule',
    'Add a new regex pattern rule for sender matching. Regex rules are evaluated after exact rules, in definition order (first match wins).',
    {
      pattern: z.string().describe('Regular expression pattern to match sender email addresses'),
      action: z.string().describe('The action to assign to matching senders (must be a valid action name)'),
      description: z.string().optional().describe('Optional human-readable description of what this pattern matches'),
      important: z.boolean().optional().describe('When true, hold matching emails in inbox flagged for TTL duration'),
      important_ttl_days: z.number().int().min(1).optional().describe('Days to hold in inbox when important (default: 7)'),
    },
    async (params) => {
      try {
        const result = await handleAddRegexRule(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'remove_rule',
    'Remove a classification rule (exact or regex) by rule_id, email_address, or pattern. Use route_id to remove a single subject route without removing the sender rule. rule_id takes precedence if multiple identifiers are supplied.',
    {
      rule_id: z.string().optional().describe('The rule_id of the rule to remove (works for both exact and regex rules)'),
      email_address: z.string().optional().describe('The email address of an exact rule to remove'),
      pattern: z.string().optional().describe('The pattern string of a regex rule to remove'),
      route_id: z.string().optional().describe('The route_id of a subject route to remove (removes only that route, not the sender rule)'),
    },
    async (params) => {
      try {
        const result = await handleRemoveRule(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'list_rules',
    'List all classification rules (exact and regex) with filtering, search, and pagination.',
    {
      action: z.string().optional().describe('Filter to only rules matching this action name'),
      type: z.enum(['exact', 'regex', 'all']).optional().describe('Filter by rule type (default: all)'),
      search: z.string().optional().describe('Case-insensitive substring search across email addresses, patterns, and descriptions'),
      limit: z.number().min(1).max(500).optional().describe('Max results to return (default: 100, max: 500)'),
      offset: z.number().min(0).optional().describe('Offset for pagination (default: 0)'),
    },
    async (params) => {
      try {
        const result = await handleListRules(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'list_folder_emails',
    'List emails from any IMAP folder (e.g. "subscriptions", "invoices", "INBOX", "for-delete"). Returns envelope data with folder field.',
    {
      folder: z.string().describe('IMAP folder name to list (e.g. "subscriptions", "INBOX", "for-delete")'),
      limit: z.number().min(1).max(50).optional().describe('Max emails to return (default: 10, max: 50)'),
      since_date: z.string().optional().describe('ISO date string. Only return emails on or after this date.'),
      before_date: z.string().optional().describe('ISO date string. Only return emails before this date.'),
      include_flags: z.boolean().optional().describe('Include IMAP flags in response (default: true)'),
      sort: z.enum(['date_desc', 'date_asc']).optional().describe('Sort order (default: date_desc)'),
    },
    async (params) => {
      try {
        const result = await handleListFolderEmails(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith('Folder not found')) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg, folder: params.folder }) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }], isError: true };
      }
    }
  );

  server.tool(
    'evaluate_regex',
    'Test and preview a regex pattern against the existing ruleset and optionally the inbox. Does not modify any rules.',
    {
      pattern: z.string().describe('The regex pattern to evaluate (same format as add_regex_rule)'),
      action: z.string().optional().describe('If provided, highlight conflicts where existing rules map to a different action'),
      include_inbox_sample: z.boolean().optional().describe('If true, also test the pattern against current inbox emails (up to 20 matches). Default: false.'),
    },
    async (params) => {
      try {
        const result = await handleEvaluateRegex(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'add_subject_route',
    'Add a subject-based routing rule to an existing sender. The regex pattern is matched case-insensitively against the subject line. Use | for OR logic ("ship|track|deliver") and .* between words ("order.*confirm"). First matching route wins.',
    {
      email_address: zEmail.describe('Sender email address (must have an existing exact rule)'),
      pattern: z.string().min(1).describe('Regex pattern to match subject line (case-insensitive). Use | for OR: "ship|track|deliver". Use .* between words: "order.*confirm". Avoid overly broad patterns like ^.*$.'),
      action: z.string().describe('The action to apply when subject matches (must be a valid action name)'),
      important: z.boolean().optional().describe('Override sender-level important setting for this route'),
      important_ttl_days: z.number().int().min(1).optional().describe('Days to hold in inbox when important'),
    },
    async (params) => {
      try {
        const result = await handleAddSubjectRoute(params);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  // ── TTL Management ──

  server.tool(
    'process_ttl_expirations',
    'Check inbox for important-flagged emails past their TTL and route them to their action folders. Called during session setup.',
    {},
    async () => {
      try {
        const result = await handleProcessTtlExpirations();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  // ── Prompt Management ──

  server.tool(
    'get_prompt',
    'Return the current runtime prompt content and version metadata.',
    {},
    async () => {
      try {
        const result = getPrompt();
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'update_prompt',
    'Replace the current runtime prompt with new content. Saves the previous version to history.',
    {
      content: z.string().describe('The full new prompt content in Markdown'),
      change_summary: z.string().optional().describe('Brief description of what changed'),
    },
    async (params) => {
      try {
        const result = updatePrompt(params.content, params.change_summary);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'list_prompt_versions',
    'Return the prompt version history log without loading full content.',
    {
      limit: z.number().min(1).optional().describe('Max versions to return (default: 10)'),
      offset: z.number().min(0).optional().describe('Offset for pagination (default: 0)'),
    },
    async (params) => {
      try {
        const result = listPromptVersions(params.limit, params.offset);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'get_prompt_version',
    'Return the full content of a specific historical prompt version.',
    {
      version: z.number().describe('The version number to retrieve'),
    },
    async (params) => {
      try {
        const result = getPromptVersion(params.version);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof VersionNotFoundError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: err.message, total_versions: err.totalVersions }) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  server.tool(
    'rollback_prompt',
    'Restore a previous prompt version as the new current prompt. The rollback is recorded as a new version.',
    {
      version: z.number().describe('The version number to restore'),
      change_summary: z.string().optional().describe('Override the default rollback summary'),
    },
    async (params) => {
      try {
        const result = rollbackPrompt(params.version, params.change_summary);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof VersionNotFoundError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: err.message, total_versions: err.totalVersions }) }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: (err as Error).message }) }], isError: true };
      }
    }
  );

  logger.info('MCP server created with 25 tools registered');
  return server;
}
