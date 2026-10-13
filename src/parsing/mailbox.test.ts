// Unit tests for the shared mailbox helpers (synthetic addresses only).

import { describe, expect, it } from 'vitest';
import { senderIfDifferent } from './mailbox';

const ALICE = { name: 'Alice Example', address: 'alice@example.test' };
const BOB = { name: 'Bob Sample', address: 'bob@example.test' };

describe('senderIfDifferent', () => {
  it('keeps a sender whose address differs from every From address', () => {
    expect(senderIfDifferent(BOB, [ALICE])).toEqual(BOB);
  });

  it('drops a sender with the same address as a From mailbox, ignoring letter case and the name', () => {
    expect(senderIfDifferent({ name: 'A. Example', address: 'ALICE@Example.TEST' }, [ALICE])).toBeUndefined();
    expect(senderIfDifferent(ALICE, [BOB, ALICE])).toBeUndefined();
  });

  it('a missing or empty sender is undefined', () => {
    expect(senderIfDifferent(undefined, [ALICE])).toBeUndefined();
    expect(senderIfDifferent({ name: '', address: '' }, [])).toBeUndefined();
  });

  it('keeps a sender when there is no From at all', () => {
    expect(senderIfDifferent(BOB, [])).toEqual(BOB);
  });

  it('a sender with only a name is compared by name', () => {
    expect(senderIfDifferent({ name: 'Alice Example', address: '' }, [ALICE])).toBeUndefined();
    expect(senderIfDifferent({ name: 'Bob Sample', address: '' }, [ALICE])).toEqual({ name: 'Bob Sample', address: '' });
  });

  it('a sender with an address is kept when the From mailbox has only a name', () => {
    expect(senderIfDifferent(ALICE, [{ name: 'Alice Example', address: '' }])).toEqual(ALICE);
  });
});
