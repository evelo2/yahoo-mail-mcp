export interface MockMessage {
  uid: number;
  flags: Set<string>;
  envelope: {
    from: Array<{ address: string; name: string }>;
    to: Array<{ address: string; name: string }>;
    subject: string;
    date: Date;
  };
  bodyParts?: Map<string, Buffer>;
}

export function createMockMessage(overrides: {
  uid: number;
  from_address: string;
  from_name?: string;
  subject?: string;
  date?: Date;
  flags?: string[];
  body?: string;
}): MockMessage {
  const msg: MockMessage = {
    uid: overrides.uid,
    flags: new Set(overrides.flags || []),
    envelope: {
      from: [{ address: overrides.from_address, name: overrides.from_name || '' }],
      to: [{ address: 'recipient@example.com', name: 'Test User' }],
      subject: overrides.subject || 'Test Email',
      date: overrides.date || new Date('2026-03-10T14:22:00Z'),
    },
  };
  if (overrides.body) {
    msg.bodyParts = new Map([['text', Buffer.from(overrides.body)]]);
  }
  return msg;
}

export const FIXTURE_EMAILS: MockMessage[] = [
  createMockMessage({ uid: 100, from_address: 'fossil@email.fossil.com', from_name: 'Fossil', subject: 'Spring Collection Now Live', date: new Date('2026-03-10T14:22:00Z') }),
  createMockMessage({ uid: 101, from_address: 'ubereats@uber.com', from_name: 'Uber Eats', subject: 'Your order is confirmed', date: new Date('2026-03-10T12:00:00Z') }),
  createMockMessage({ uid: 102, from_address: 'orders@starbucks.com', from_name: 'Starbucks', subject: 'Order Receipt #1234', date: new Date('2026-03-09T10:00:00Z') }),
  createMockMessage({ uid: 103, from_address: 'unknown@mystery.com', from_name: 'Unknown', subject: 'Check this out!', date: new Date('2026-03-09T08:00:00Z') }),
  createMockMessage({ uid: 104, from_address: 'boss@news.hugoboss.com', from_name: 'Hugo Boss', subject: 'New Arrivals', date: new Date('2026-03-08T16:00:00Z') }),
  createMockMessage({ uid: 105, from_address: 'marketing@edm.xtool.com', from_name: 'xTool', subject: 'Laser Sale', date: new Date('2026-03-08T14:00:00Z') }),
];

export function createInboxMessages(count: number, options?: { triagedUids?: number[] }): MockMessage[] {
  const messages: MockMessage[] = [];
  const triagedSet = new Set(options?.triagedUids || []);

  for (let i = 0; i < count; i++) {
    const uid = 1000 + i;
    const flags = triagedSet.has(uid) ? ['triaged'] : [];
    messages.push(
      createMockMessage({
        uid,
        from_address: `sender${i}@example.com`,
        subject: `Test Email ${i}`,
        date: new Date(Date.now() - i * 3600000),
        flags,
      })
    );
  }
  return messages;
}
