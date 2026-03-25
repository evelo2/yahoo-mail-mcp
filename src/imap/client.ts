import { ImapFlow } from 'imapflow';
import { logger } from '../utils/logger.js';
import { ImapConnectionError, AuthenticationError } from '../utils/errors.js';

export interface ImapClientConfig {
  host: string;
  port: number;
  email: string;
  appPassword: string;
  opDelayMs: number;
}

let client: ImapFlow | null = null;
let clientConfig: ImapClientConfig | null = null;

export function getClientConfig(): ImapClientConfig {
  return {
    host: process.env.IMAP_HOST || 'imap.mail.yahoo.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    email: process.env.YAHOO_EMAIL || '',
    appPassword: process.env.YAHOO_APP_PASSWORD || '',
    opDelayMs: parseInt(process.env.IMAP_OP_DELAY_MS || '200', 10),
  };
}

export async function getConnection(config?: ImapClientConfig): Promise<ImapFlow> {
  if (client && client.usable) {
    return client;
  }

  const cfg = config || clientConfig || getClientConfig();
  clientConfig = cfg;

  const flow = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: true,
    auth: {
      user: cfg.email,
      pass: cfg.appPassword,
    },
    logger: false,
  });

  try {
    await flow.connect();
  } catch (err: unknown) {
    const msg = (err as Error).message || String(err);
    if (msg.includes('auth') || msg.includes('AUTH') || msg.includes('credentials') || msg.includes('LOGIN')) {
      throw new AuthenticationError();
    }
    throw new ImapConnectionError(`IMAP connection failed: ${msg}`);
  }

  client = flow;
  logger.info('IMAP connection established');

  return flow;
}

export async function delay(ms?: number): Promise<void> {
  const delayMs = ms ?? clientConfig?.opDelayMs ?? 200;
  if (delayMs > 0) {
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
}

export async function closeConnection(): Promise<void> {
  if (client) {
    await client.logout();
    client = null;
  }
}

export function resetClientState(): void {
  client = null;
  clientConfig = null;
}

export function setClient(c: ImapFlow): void {
  client = c;
}
