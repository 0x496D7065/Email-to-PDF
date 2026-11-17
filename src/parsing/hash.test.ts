import { describe, expect, it } from 'vitest';
import { sha256Hex } from './hash';

// Known test vectors (FIPS 180-2 / NIST examples).
describe('sha256Hex', () =>
{
    it('hashes empty input', async () =>
    {
        expect(await sha256Hex(new Uint8Array())).toBe(
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        );
    });

    it('hashes "abc"', async () =>
    {
        expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });

    it('hashes only the viewed bytes of a subarray', async () =>
    {
        const whole = new TextEncoder().encode('xxabcxx');
        expect(await sha256Hex(whole.subarray(2, 5))).toBe(
            'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
        );
    });
});
