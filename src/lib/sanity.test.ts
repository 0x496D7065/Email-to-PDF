import { describe, expect, it } from 'vitest';
import { add } from './sanity';

describe('add', () => {
  it('adds two numbers', () => {
    expect(add(2, 3)).toBe(5);
  });

  it('handles negative numbers', () => {
    expect(add(-2, 1)).toBe(-1);
  });
});
