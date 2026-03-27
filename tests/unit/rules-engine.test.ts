import { describe, it, expect, beforeAll } from 'vitest';
import { loadSenderRules, type SenderRules } from '../../src/rules/config.js';
import { lookupSender } from '../../src/rules/engine.js';
import { resolve } from 'node:path';

let rules: SenderRules;

beforeAll(() => {
  rules = loadSenderRules(resolve(import.meta.dirname, '../../config/sender-rules.json'));
});

describe('Test Suite 1: Sender Lookup', () => {
  it('1.1 — Known sender, exact match', () => {
    const result = lookupSender(rules, 'fossil@email.fossil.com');
    expect(result).toMatchObject({ email_address: 'fossil@email.fossil.com', action: 'watches', matched: true, match_type: 'exact' });
    expect(result.rule_id).toEqual(expect.any(String));
  });

  it('1.2 — Known sender, case insensitive', () => {
    const result = lookupSender(rules, 'Fossil@Email.Fossil.com');
    expect(result).toMatchObject({ email_address: 'Fossil@Email.Fossil.com', action: 'watches', matched: true, match_type: 'exact' });
    expect(result.rule_id).toEqual(expect.any(String));
  });

  it('1.3 — Known sender, case insensitive (uppercase in config)', () => {
    const result = lookupSender(rules, 'hermanmiller@n.hermanmiller.com');
    expect(result).toMatchObject({ email_address: 'hermanmiller@n.hermanmiller.com', action: 'delete', matched: true, match_type: 'exact' });
    expect(result.rule_id).toEqual(expect.any(String));
  });

  it('1.4 — Unknown sender', () => {
    const result = lookupSender(rules, 'promo@newbrand.xyz');
    expect(result).toEqual({ email_address: 'promo@newbrand.xyz', action: 'unknown', matched: false });
  });

  it('1.5 — Empty string', () => {
    const result = lookupSender(rules, '');
    expect(result).toEqual({ email_address: '', action: 'unknown', matched: false });
  });

  it('1.6 — Same brand, different addresses, different actions (Starbucks)', () => {
    const invoice = lookupSender(rules, 'orders@starbucks.com');
    expect(invoice).toMatchObject({ email_address: 'orders@starbucks.com', action: 'invoice', matched: true, match_type: 'exact' });

    const del = lookupSender(rules, 'Starbucks@e.starbucks.com');
    expect(del).toMatchObject({ email_address: 'Starbucks@e.starbucks.com', action: 'delete', matched: true, match_type: 'exact' });
  });

  it('1.7 — Same brand, different addresses, different actions (lululemon)', () => {
    const subs = lookupSender(rules, 'hello@e.lululemon.com');
    expect(subs).toMatchObject({ email_address: 'hello@e.lululemon.com', action: 'subscriptions', matched: true, match_type: 'exact' });

    const news = lookupSender(rules, 'stores@e.lululemon.com');
    expect(news).toMatchObject({ email_address: 'stores@e.lululemon.com', action: 'news', matched: true, match_type: 'exact' });
  });

  it('1.8 — Same brand, different addresses, different actions (Moncler)', () => {
    const subs1 = lookupSender(rules, 'moncler@email.moncler.com');
    expect(subs1).toMatchObject({ email_address: 'moncler@email.moncler.com', action: 'subscriptions', matched: true, match_type: 'exact' });

    const subs2 = lookupSender(rules, 'mymoncler@email.moncler.com');
    expect(subs2).toMatchObject({ email_address: 'mymoncler@email.moncler.com', action: 'subscriptions', matched: true, match_type: 'exact' });
  });

  it('1.9 — Same brand, different addresses, different actions (xTool)', () => {
    const dc = lookupSender(rules, 'marketing@edm.xtool.com');
    expect(dc).toMatchObject({ email_address: 'marketing@edm.xtool.com', action: 'delete', matched: true, match_type: 'exact' });

    const subs = lookupSender(rules, 'service.ca@xtool.com');
    expect(subs).toMatchObject({ email_address: 'service.ca@xtool.com', action: 'delete', matched: true, match_type: 'exact' });
  });
});
