import { expect, test } from 'bun:test';
import fc from 'fast-check';
import {
  SID_ALPHABET,
  uuidToSid,
  sidToUuid,
  isSid,
  identityKeyUuid,
} from '@rezics/model/address/sid';
import { normalizeAddressName, nameSkeleton } from '@rezics/model/address/names';
import { deriveAddressSlug } from '@rezics/model/address/slug';

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

test('G-937: names keep native script, fold canonically and reject mixed-script impersonation and identities', () => {
  expect(normalizeAddressName('My-Handle_2', 'ascii-handle').key).toBe('my-handle_2');
  expect(normalizeAddressName('Cafe\u0301 Au Lait', 'unicode-title').key).toBe('café-au-lait');
  expect(normalizeAddressName('Straße', 'unicode-title').key).toBe('strasse');
  expect(normalizeAddressName('l·l', 'unicode-title').key).toBe('l·l');
  for (const title of [
    '日本語のタイトル',
    'ポケモンゲーム',
    '中文 ABC',
    '한국어 漢字 ABC',
    'العربية',
    'עברית',
  ]) {
    expect(normalizeAddressName(title, 'unicode-title').display).toBe(title);
  }
  for (const title of ['pаypal', 'LatinΕλληνικά', 'Latinالعربية', 'hello\u200bworld']) {
    expect(() => normalizeAddressName(title, 'unicode-title')).toThrow();
  }
  for (const name of [
    '_abc',
    'abc-',
    'ab',
    'hello world',
    '𝕒bc',
    uuidToSid('ffffffff-ffff-ffff-ffff-ffffffffffff'),
  ]) {
    expect(() => normalizeAddressName(name, 'ascii-handle')).toThrow();
  }
  fc.assert(
    fc.property(fc.uuid(), (uuid) => {
      for (const policy of ['ascii-handle', 'unicode-title'] as const) {
        expect(() => normalizeAddressName(uuidToSid(uuid), policy)).toThrow();
        expect(() => normalizeAddressName(`${uuidToSid(uuid)}-`, policy)).toThrow();
        expect(() => normalizeAddressName(`${uuidToSid(uuid)}-title`, policy)).toThrow();
        expect(() => normalizeAddressName(uuid, policy)).toThrow();
      }
    }),
  );
  expect(nameSkeleton('moon')).toBe(nameSkeleton('rn00n'));
});

test('G-937: derived slugs retain CJK and RTL and truncate on words or graphemes', () => {
  expect(deriveAddressSlug('  Café！ 日本語 — العربية  ')).toBe('café-日本語-العربية');
  expect(deriveAddressSlug('one '.repeat(30))).toBe('one-'.repeat(14) + 'one');
  expect([...deriveAddressSlug('日本語'.repeat(40))].length).toBeLessThanOrEqual(60);
  expect(deriveAddressSlug('a\u0301'.repeat(100))).toBe('á'.repeat(60));
});
