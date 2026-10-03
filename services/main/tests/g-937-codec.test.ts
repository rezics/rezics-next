import { expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  SID_ALPHABET,
  uuidToSid,
  sidToUuid,
  isSid,
  identityKeyUuid,
  hasSidCaseVariant,
} from '@rezics/model/address/sid';
import { normalizeAddressAlias, aliasSkeleton } from '@rezics/model/address/aliases';
import { deriveAddressSuffix } from '@rezics/model/address/suffix';

test('G-937: sid preserves all 128 bits with exactly one fixed-length spelling', () => {
  expect(SID_ALPHABET).toBe('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');
  fc.assert(
    fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), (bits) => {
      const h = bits.toString(16).padStart(32, '0');
      const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      const sid = uuidToSid(uuid);
      expect(sid).toHaveLength(22);
      expect(sidToUuid(sid)).toBe(uuid);
      expect(uuidToSid(uuid.toUpperCase())).toBe(sid);
      expect(identityKeyUuid(`${sid}-新しい名前`)).toBe(uuid);
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 50 }), (candidate) => {
      if (isSid(candidate)) expect(uuidToSid(sidToUuid(candidate))).toBe(candidate);
      else expect(() => sidToUuid(candidate)).toThrow();
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...SID_ALPHABET), { minLength: 22, maxLength: 22 }),
      (characters) => {
        const candidate = characters.join('');
        const bits = characters.reduce(
          (value, character) => value * 58n + BigInt(SID_ALPHABET.indexOf(character)),
          0n,
        );
        expect(isSid(candidate)).toBe(bits < 1n << 128n);
        if (bits < 1n << 128n) expect(uuidToSid(sidToUuid(candidate))).toBe(candidate);
        else expect(() => sidToUuid(candidate)).toThrow();
      },
    ),
    { numRuns: 2000 },
  );
  for (const value of [
    '',
    '1'.repeat(21),
    '1'.repeat(23),
    'z'.repeat(22),
    ...['0', 'O', 'I', 'l', '/', '\n', '🧬'].map((character) => '1'.repeat(21) + character),
  ]) {
    expect(() => sidToUuid(value)).toThrow();
  }
  expect(uuidToSid('00000000-0000-0000-0000-000000000000')).toBe('1'.repeat(22));
});

test('G-937: aliases keep native script, fold canonically and reject mixed-script impersonation and identities', () => {
  expect(normalizeAddressAlias('My-Handle_2', 'ascii-handle').key).toBe('my-handle_2');
  expect(normalizeAddressAlias('Cafe\u0301 Au Lait', 'unicode-title').key).toBe('café-au-lait');
  expect(normalizeAddressAlias('Straße', 'unicode-title').key).toBe('strasse');
  expect(normalizeAddressAlias('l·l', 'unicode-title').key).toBe('l·l');
  for (const title of [
    '日本語のタイトル',
    'ポケモンゲーム',
    '中文 ABC',
    '한국어 漢字 ABC',
    'العربية',
    'עברית',
  ]) {
    expect(normalizeAddressAlias(title, 'unicode-title').key).toBe(title.toLowerCase().replace(/\s+/gu, '-'));
  }
  for (const title of ['pаypal', 'LatinΕλληνικά', 'Latinالعربية', 'hello\u200bworld']) {
    expect(() => normalizeAddressAlias(title, 'unicode-title')).toThrow();
  }
  for (const name of [
    '_abc',
    'abc-',
    'ab',
    'hello world',
    '𝕒bc',
    uuidToSid('ffffffff-ffff-ffff-ffff-ffffffffffff'),
  ]) {
    expect(() => normalizeAddressAlias(name, 'ascii-handle')).toThrow();
  }
  fc.assert(
    fc.property(fc.uuid(), (uuid) => {
      for (const policy of ['ascii-handle', 'unicode-title'] as const) {
        expect(() => normalizeAddressAlias(uuidToSid(uuid), policy)).toThrow();
        expect(hasSidCaseVariant(uuidToSid(uuid).toLowerCase())).toBe(true);
        expect(() => normalizeAddressAlias(uuidToSid(uuid).toLowerCase(),policy)).toThrow();
        expect(() => normalizeAddressAlias(uuidToSid(uuid).toUpperCase(),policy)).toThrow();
        expect(() => normalizeAddressAlias(`${uuidToSid(uuid)}-`, policy)).toThrow();
        expect(() => normalizeAddressAlias(`${uuidToSid(uuid)}-title`, policy)).toThrow();
        expect(() => normalizeAddressAlias(uuid, policy)).toThrow();
      }
    }),
  );
  expect(aliasSkeleton('moon')).toBe(aliasSkeleton('rn00n'));
});

test('G-937: derived readable suffixes retain CJK and RTL and truncate on words or graphemes', () => {
  expect(deriveAddressSuffix('  Café！ 日本語 — العربية  ')).toBe('café-日本語-العربية');
  expect(deriveAddressSuffix('one '.repeat(30))).toBe('one-'.repeat(14) + 'one');
  expect([...deriveAddressSuffix('日本語'.repeat(40))].length).toBeLessThanOrEqual(60);
  expect(deriveAddressSuffix('a\u0301'.repeat(100))).toBe('á'.repeat(60));
});
