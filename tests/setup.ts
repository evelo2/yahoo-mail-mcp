import { vi } from 'vitest';
import type { MockMessage } from './fixtures/emails.js';

export interface MockImapClient {
  usable: boolean;
  mailbox: { exists: number } | null;
  _messages: MockMessage[];
  _folders: Map<string, MockMessage[]>;
  _movedMessages: Map<number, string>;
  _currentFolder: string;

  connect: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  fetchOne: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  messageFlagsAdd: ReturnType<typeof vi.fn>;
  messageFlagsRemove: ReturnType<typeof vi.fn>;
  messageMove: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  mailboxCreate: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
}

function parseUid(query: any): number | undefined {
  if (typeof query === 'number') return query;
  if (typeof query === 'string') {
    const n = parseInt(query, 10);
    return isNaN(n) ? undefined : n;
  }
  if (query?.uid !== undefined) {
    return parseUid(query.uid);
  }
  return undefined;
}

/** Parse a query that may be a single UID or comma-separated UID range (e.g. "100,101,102") */
function parseUids(query: any): number[] {
  if (typeof query === 'number') return [query];
  if (typeof query === 'string' && query.includes(',')) {
    return query.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
  }
  const single = parseUid(query);
  return single !== undefined ? [single] : [];
}

export function createMockImapClient(messages: MockMessage[] = []): MockImapClient {
  const folders = new Map<string, MockMessage[]>();
  const movedMessages = new Map<number, string>();
  const lock = { release: vi.fn() };

  /** Helper: returns the message array for the currently opened folder. */
  function activeMessages(): MockMessage[] {
    if (client._currentFolder === 'INBOX') return client._messages;
    return client._folders.get(client._currentFolder) ?? [];
  }

  const client: MockImapClient = {
    usable: true,
    mailbox: { exists: messages.length },
    _messages: [...messages],
    _folders: folders,
    _movedMessages: movedMessages,
    _currentFolder: 'INBOX',

    connect: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),

    getMailboxLock: vi.fn().mockImplementation((folder: string) => {
      if (folder === 'INBOX' || folders.has(folder)) {
        client._currentFolder = folder;
        return Promise.resolve(lock);
      }
      return Promise.reject(new Error(`Mailbox not found: ${folder}`));
    }),

    fetch: vi.fn().mockImplementation((query: any, _opts: any) => {
      const pool = activeMessages();
      let filteredMessages: MockMessage[];

      if (typeof query === 'string' && query.includes(',')) {
        const uids = query.split(',').map(Number);
        filteredMessages = pool.filter((m) => uids.includes(m.uid));
      } else if (typeof query === 'string' && query.includes(':')) {
        filteredMessages = pool;
      } else if (query?.uid) {
        const uidStr = String(query.uid);
        const uids = uidStr.split(',').map(Number);
        filteredMessages = pool.filter((m) => uids.includes(m.uid));
      } else {
        filteredMessages = pool;
      }

      return {
        async *[Symbol.asyncIterator]() {
          for (const msg of filteredMessages) {
            yield msg;
          }
        },
      };
    }),

    fetchOne: vi.fn().mockImplementation((query: any, _opts: any) => {
      const uid = parseUid(query);
      const pool = activeMessages();
      const msg = uid !== undefined ? pool.find((m) => m.uid === uid) : null;
      return Promise.resolve(msg || null);
    }),

    search: vi.fn().mockImplementation((query: any) => {
      let results = [...activeMessages()];

      function applyCondition(condition: any, msgs: MockMessage[]): MockMessage[] {
        if (condition.keyword && condition.not) {
          return msgs.filter((m) => !m.flags.has(condition.keyword));
        }
        if (condition.keyword && !condition.not) {
          return msgs.filter((m) => m.flags.has(condition.keyword));
        }
        if (condition.since) {
          const since = new Date(condition.since);
          return msgs.filter((m) => m.envelope.date >= since);
        }
        if (condition.before) {
          const before = new Date(condition.before);
          return msgs.filter((m) => m.envelope.date < before);
        }
        return msgs;
      }

      if (query.and) {
        for (const condition of query.and) {
          results = applyCondition(condition, results);
        }
      } else if (!query.all) {
        // Handle flat object with multiple criteria (e.g. { since: ..., before: ... })
        if (query.since) results = applyCondition({ since: query.since }, results);
        if (query.before) results = applyCondition({ before: query.before }, results);
        if (query.keyword) results = applyCondition(query, results);
      }

      return Promise.resolve(results.map((m) => m.uid));
    }),

    messageFlagsAdd: vi.fn().mockImplementation((query: any, flags: string[]) => {
      const uids = parseUids(query);
      for (const uid of uids) {
        const msg = activeMessages().find((m) => m.uid === uid);
        if (msg) {
          for (const flag of flags) {
            msg.flags.add(flag);
          }
        }
      }
      return Promise.resolve();
    }),

    messageFlagsRemove: vi.fn().mockImplementation((query: any, flags: string[]) => {
      const uids = parseUids(query);
      for (const uid of uids) {
        const msg = activeMessages().find((m) => m.uid === uid);
        if (msg) {
          for (const flag of flags) {
            msg.flags.delete(flag);
          }
        }
      }
      return Promise.resolve();
    }),

    messageMove: vi.fn().mockImplementation((query: any, folder: string) => {
      const uids = parseUids(query);
      for (const uid of uids) {
        movedMessages.set(uid, folder);
        client._messages = client._messages.filter((m) => m.uid !== uid);
      }
      return Promise.resolve();
    }),

    list: vi.fn().mockImplementation(() => {
      const folderList = Array.from(folders.keys()).map((path) => ({ path }));
      return Promise.resolve(folderList);
    }),

    mailboxCreate: vi.fn().mockImplementation((path: string) => {
      folders.set(path, []);
      return Promise.resolve({ path });
    }),

    status: vi.fn().mockImplementation((folder: string) => {
      const msgs = folders.get(folder);
      return Promise.resolve({ messages: msgs?.length || 0 });
    }),
  };

  return client;
}
