// Unit tests for joinMailboxes and joinPlain: a fixed ", " in every language. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { joinMailboxes, joinPlain, MAILBOX_SEPARATOR } from './mailbox-list';

describe('joinMailboxes', () => {
  it('joins with a plain ", " and no "and" before the last one', () => {
    expect(MAILBOX_SEPARATOR).toBe(', ');
    expect(joinMailboxes(['Alice <a@example.test>', 'Bob <b@example.test>', 'Carol <c@example.test>'])).toBe(
      'Alice <a@example.test>, Bob <b@example.test>, Carol <c@example.test>',
    );
    expect(joinMailboxes(['Alice <a@example.test>', 'Bob <b@example.test>'])).toBe('Alice <a@example.test>, Bob <b@example.test>');
  });

  it('gives the one text as it is, and "" for none', () => {
    expect(joinMailboxes(['Alice <a@example.test>'])).toBe('Alice <a@example.test>');
    expect(joinMailboxes([])).toBe('');
  });
});

describe('joinPlain', () => {
  it('joins file names with a plain ", " and no "and" before the last one', () => {
    expect(joinPlain(['a.eml', 'b.eml', 'c.eml'])).toBe('a.eml, b.eml, c.eml');
    expect(joinPlain(['a.eml'])).toBe('a.eml');
    expect(joinPlain([])).toBe('');
  });
});
