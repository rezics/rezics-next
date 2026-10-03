import { expect, test } from 'bun:test';
import { identityKeyUuid, uuidToSid } from '@rezics/model/address';
import type { AddressRead, ResolvedAddress } from '../features/address/client.ts';
import { addressPath, parseAddressSegment, type AddressLookup } from '../features/address/path.ts';
import { decideAddress } from '../features/address/redirect.ts';

const uuid = '1ce436f9-e7eb-4155-988e-d23a8514150f';
const holder = `https://rezics.com/id/${uuid}`;
const sid = uuidToSid(uuid);
const forms = [uuid, uuid.toUpperCase(), '1Ce436F9-e7Eb-4155-988E-d23A8514150f'];
const url = (path: string) => new URL(path, 'https://rezics.test');

function answer(
  lookup: AddressLookup,
  prefix: ResolvedAddress['canonical']['prefix'],
  named = false,
): AddressRead {
  return {
    kind: 'resolved',
    data: {
      profile: 'address-resolution-v1',
      status: 'resolved',
      state: 'current',
      scope: lookup.scope,
      key: lookup.key,
      holder,
      canonical: { prefix, key: named ? 'current-name' : sid, slugSource: 'Reader' },
      ...(lookup.scope === 'space' ? { capabilities: { realm: holder, zone: holder } } : {}),
    },
  };
}

test.each(forms)('G990: legacy UUID %s parses to the lowercase identity', (key) => {
  expect(parseAddressSegment(key)).toEqual({ kind: 'uuid', id: uuid, key });
});

const routers = [
  ['agent', '/a/', '/a/'],
  ['agent', '/@', '/a/'],
  ['agent', '/@agent-', '/a/'],
  ['agent', '/@AGENT-', '/a/'],
  ['space', '/r/', '/r/'],
  ['space', '/z/', '/z/'],
  ['work', '/w/', '/w/'],
  ['resource', '/e/', '/e/'],
  ['concept', '/concepts/', '/concepts/'],
] as const;

for (const [scope, legacyPrefix, canonicalPrefix] of routers) {
  for (const named of scope === 'agent' || scope === 'space' || scope === 'work'
    ? [false, true]
    : [false]) {
    test.each(forms)(
      `G990: ${legacyPrefix}%s reaches its ${named ? 'name' : 'identity'} canonical form in one 301`,
      async (key) => {
        const prefix = scope === 'agent' && named ? '/@' : canonicalPrefix;
        const canonical = `/en${prefix}${named ? 'current-name' : `${sid}-reader`}`;
        const lookups: AddressLookup[] = [];
        const resolve = async (lookup: AddressLookup) => {
          lookups.push(lookup);
          expect(lookup.scope).toBe(scope);
          expect(identityKeyUuid(lookup.key) === uuid || lookup.key === 'current-name').toBe(true);
          return answer(lookup, prefix, named);
        };
        const suffix = '/about?language=sv&version=first&tag=a&tag=b#section';
        expect(addressPath(`/en${legacyPrefix}${key}`)?.lookup).toEqual({ scope, key });
        const decision = await decideAddress(
          url(`/en${legacyPrefix}${key}${suffix}`),
          'en',
          resolve,
        );
        expect(decision).toEqual({ kind: 'redirect', status: 301, location: canonical + suffix });
        expect(lookups).toHaveLength(1);
        expect((await decideAddress(url(canonical + suffix), 'en', resolve)).kind).toBe('pass');
      },
    );
  }
}

test.each(forms)(
  'G990: mounted UUID %s and its Space normalize in the same redirect',
  async (key) => {
    const lookups: AddressLookup[] = [];
    const resolve = async (lookup: AddressLookup) => {
      lookups.push(lookup);
      return answer(lookup, lookup.scope === 'space' ? '/z/' : '/e/');
    };
    expect(
      await decideAddress(
        url(`/en/r/${key}/catalogue/${key}/discussion?language=sv#reply`),
        'en',
        resolve,
      ),
    ).toEqual({
      kind: 'redirect',
      status: 301,
      location: `/en/z/${sid}-reader/catalogue/${sid}-reader/discussion?language=sv#reply`,
    });
    expect(lookups).toEqual([
      { scope: 'space', key },
      { scope: `zone:${holder}`, route: 'catalogue', key },
    ]);
  },
);

test.each(forms)('G990: legacy discussion UUID %s normalizes with its community', async (key) => {
  expect(
    await decideAddress(url(`/en/r/${key}/discussions/${key}`), 'en', async (lookup) =>
      answer(lookup, '/r/'),
    ),
  ).toEqual({ kind: 'redirect', status: 301, location: `/en/r/${sid}-reader/discussions/${sid}` });
});

test('G990: changing sid letter case selects a different identity and preserves the lookup key', () => {
  const changed = sid.replace('Z', 'z');
  expect(changed).not.toBe(sid);
  for (const suffix of ['', '-old-title']) {
    const original = parseAddressSegment(sid + suffix);
    const other = parseAddressSegment(changed + suffix);
    expect(original?.kind === 'name' ? null : original?.id).toBe(uuid);
    expect(other?.kind).toBe(suffix ? 'sid-slug' : 'sid');
    expect(other?.kind === 'name' ? null : other?.id).not.toBe(uuid);
    expect(other?.key).toBe(changed + suffix);
    expect(addressPath(`/en/a/${changed}${suffix}`)?.lookup.key).toBe(changed + suffix);
  }
});
