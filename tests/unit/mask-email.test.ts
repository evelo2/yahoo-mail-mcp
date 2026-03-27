import { describe, it, expect } from 'vitest';
import { maskEmail } from '../../src/utils/mask.js';

describe('Test Suite: maskEmail()', () => {
  it('masks local part beyond first 3 characters, preserves domain', () => {
    expect(maskEmail('user@example.com')).toBe('use***@example.com');
  });

  it('shows at most 3 characters when local part is longer than 3', () => {
    expect(maskEmail('longusername@example.com')).toBe('lon***@example.com');
  });

  it('handles 2-character local part', () => {
    expect(maskEmail('ab@example.com')).toBe('ab***@example.com');
  });

  it('handles 1-character local part', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('returns *** for empty string', () => {
    expect(maskEmail('')).toBe('***');
  });

  it('returns *** when no @ sign is present', () => {
    expect(maskEmail('nodomain')).toBe('***');
  });

  it('returns *** when @ is the first character (empty local part)', () => {
    expect(maskEmail('@example.com')).toBe('***');
  });

  it('preserves subdomain in the domain part', () => {
    expect(maskEmail('user@mail.subdomain.example.com')).toBe('use***@mail.subdomain.example.com');
  });

  it('handles exactly 3 characters in local part', () => {
    expect(maskEmail('pau@example.com')).toBe('pau***@example.com');
  });
});
