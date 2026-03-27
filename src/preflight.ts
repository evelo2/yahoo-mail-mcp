import { getConnection, getClientConfig } from './imap/client.js';
import { getEmail } from './imap/operations.js';
import { logger } from './utils/logger.js';
import { maskEmail } from './utils/mask.js';

interface PreflightResult {
  success: boolean;
  connection: boolean;
  email: string;
  inboxCount: number;
  folders: string[];
  fetchedEmail: { uid: number; from: string; subject: string } | null;
  errors: string[];
}

export async function runPreflight(): Promise<PreflightResult> {
  const config = getClientConfig();
  const result: PreflightResult = {
    success: false,
    connection: false,
    email: config.email,
    inboxCount: 0,
    folders: [],
    fetchedEmail: null,
    errors: [],
  };

  // Check env vars are set
  if (!config.email) {
    result.errors.push('YAHOO_EMAIL is not set. Set it in your .env file.');
  }
  if (!config.appPassword) {
    result.errors.push('YAHOO_APP_PASSWORD is not set. Set it in your .env file.');
  }
  if (result.errors.length > 0) {
    return result;
  }

  // 1. Test IMAP connection + auth
  let client;
  try {
    client = await getConnection(config);
    result.connection = true;
    logger.info('✓ Preflight: IMAP connection successful');
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    result.errors.push(`IMAP connection failed: ${msg}`);
    console.error('Preflight IMAP connection failed:', msg);
    return result;
  }

  // 2. List folders
  try {
    const mailboxes = await client.list();
    result.folders = mailboxes.map((mb: any) => mb.path).sort();
    logger.info({ folderCount: result.folders.length }, '✓ Preflight: Folder listing successful');
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    result.errors.push(`Failed to list folders: ${msg}`);
    console.error('Preflight folder listing failed:', msg);
  }

  // 3. Open INBOX, count messages, and find a UID for the fetch test
  let testUid: number | null = null;
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const mailbox = client.mailbox;
      if (mailbox && typeof mailbox === 'object' && 'exists' in mailbox) {
        result.inboxCount = (mailbox as any).exists || 0;
      }

      // Fetch 1 message to get its UID for the getEmail test
      const messages = client.fetch('1:1', { uid: true, envelope: true });
      for await (const msg of messages) {
        testUid = msg.uid;
        break;
      }
      logger.info(
        { inboxCount: result.inboxCount, sampleUid: testUid },
        '✓ Preflight: Inbox enumeration successful'
      );
    } finally {
      lock.release();
    }
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    result.errors.push(`Failed to enumerate inbox: ${msg}`);
    console.error('Preflight inbox enumeration failed:', msg);
  }

  // 4. Test getEmail by UID — this validates UID-based FETCH works
  if (testUid !== null) {
    try {
      const emailDetail = await getEmail(client, testUid, false);
      result.fetchedEmail = {
        uid: emailDetail.uid,
        from: emailDetail.from_address,
        subject: emailDetail.subject,
      };
      logger.info(
        { uid: emailDetail.uid, from: emailDetail.from_address },
        '✓ Preflight: get_email by UID successful'
      );
    } catch (err: unknown) {
      const msg = (err as Error).message || String(err);
      result.errors.push(`get_email failed for UID ${testUid}: ${msg}`);
      console.error(`Preflight get_email failed for UID ${testUid}:`, msg);
    }
  } else if (result.inboxCount > 0) {
    result.errors.push('Could not obtain a test UID from INBOX despite messages existing');
    console.error('Preflight: INBOX has messages but could not fetch a UID for testing');
  }
  // If inbox is empty, skip the getEmail test (not an error)

  result.success = result.errors.length === 0;
  return result;
}

export function printPreflightReport(result: PreflightResult): void {
  console.log('');
  console.log('┌──────────────────────────────────────────────┐');
  console.log('│           Yahoo Mail MCP — Preflight         │');
  console.log('└──────────────────────────────────────────────┘');
  console.log('');

  if (result.success) {
    console.log(`  ✅ Connection      ${maskEmail(result.email)} → OK`);
    console.log(`  ✅ Inbox           ${result.inboxCount} messages`);
    console.log(`  ✅ Folders         ${result.folders.length} found`);
    if (result.fetchedEmail) {
      console.log(`  ✅ Fetch email     UID ${result.fetchedEmail.uid} from ${result.fetchedEmail.from}`);
    } else if (result.inboxCount === 0) {
      console.log(`  ⏭️  Fetch email     skipped (inbox empty)`);
    }
    console.log(`  ℹ️  Triaging        folder-based (all processed emails leave INBOX)`);
    console.log('');
    console.log('  Server is ready.');
  } else {
    console.log('  ❌ Preflight FAILED\n');
    for (const err of result.errors) {
      console.log(`     • ${err}`);
    }
    console.log('');
    console.log('  Check your .env configuration:');
    console.log('    YAHOO_EMAIL          — your Yahoo email address');
    console.log('    YAHOO_APP_PASSWORD   — 16-char app password from Yahoo Account Security');
    console.log('    IMAP_HOST            — imap.mail.yahoo.com (default)');
    console.log('    IMAP_PORT            — 993 (default)');
  }

  console.log('');
}
