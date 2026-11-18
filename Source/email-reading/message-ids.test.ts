import { describe, expect, it } from 'vitest';
import { parseIdList, parseSingleId } from './message-ids';

describe('parseIdList', () =>
{
    it('strips < > and keeps header order', () =>
    {
        expect(parseIdList('<a@x.test> <b@x.test>\t<c@x.test>')).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
    });

    it('splits ids written without a space between them', () =>
    {
        expect(parseIdList('<a@x.test><b@x.test>')).toEqual(['a@x.test', 'b@x.test']);
    });

    it('trims spaces inside the brackets', () =>
    {
        expect(parseIdList('< a@x.test >')).toEqual(['a@x.test']);
    });

    it('ignores prose around bracketed ids', () =>
    {
        expect(parseIdList("Alice's message of Monday <a@x.test>")).toEqual(['a@x.test']);
    });

    it('falls back to whitespace splitting when there are no brackets', () =>
    {
        expect(parseIdList('  a@x.test   b@x.test ')).toEqual(['a@x.test', 'b@x.test']);
    });

    it('returns [] for missing or empty values and skips empty ids', () =>
    {
        expect(parseIdList(undefined)).toEqual([]);
        expect(parseIdList(null)).toEqual([]);
        expect(parseIdList('   ')).toEqual([]);
        expect(parseIdList('<> <a@x.test>')).toEqual(['a@x.test']);
    });
});

describe('parseSingleId', () =>
{
    it('returns the first id or null', () =>
    {
        expect(parseSingleId(' <a@x.test> ')).toBe('a@x.test');
        expect(parseSingleId('<a@x.test> <b@x.test>')).toBe('a@x.test');
        expect(parseSingleId('')).toBeNull();
        expect(parseSingleId(undefined)).toBeNull();
    });
});
