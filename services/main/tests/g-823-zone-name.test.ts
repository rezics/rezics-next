import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { readZoneName, ZoneName } from '../src/modules/zone/read-name.ts';
import { InvalidZoneConfiguration } from '../src/modules/zone/config-format.ts';
import { zoneRoutes } from '../src/routes/zones.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { FusekiClient } from '../src/infrastructure/fuseki.ts';

test.each([
  ['مكتبة', 'ar', 'ar', 'rtl'],
  ['آذری', 'AZ-aRaB', 'az-Arab', 'rtl'],
  ['Kurdî', 'ku-Latn', 'ku-Latn', 'ltr'],
  ['Unchosen', undefined, 'und', 'ltr'],
  ['العربية', undefined, 'und', 'rtl'],
  ['Private', 'X-Rezics', 'x-rezics', 'ltr'],
] as const)(
  'G823: Zone name %s keeps writer language and shared direction',
  (name, language, canonical, direction) => {
    const value = readZoneName(name, language);
    expect(value).toEqual({ name, language: canonical, direction });
    expect(Value.Check(ZoneName, value)).toBe(true);
  },
);

test('G823: unnamed legacy Zone metadata remains explicit and readable', () => {
  expect(readZoneName(undefined, undefined)).toEqual({
    name: null,
    language: 'und',
    direction: 'ltr',
  });
});

test.each([
  ['', 'ar'],
  ['   ', 'ar'],
  ['A'.repeat(301), 'en'],
  ['Name', 'en_US'],
  ['Name', ''],
  ['Name', null],
  ['Name', 1],
  [null, 'ar'],
  [undefined, 'ar'],
])('G823: invalid Zone name or language is rejected (%j, %j)', (name, language) => {
  expect(() => readZoneName(name, language)).toThrow(InvalidZoneConfiguration);
});

test('G823: HTTP validation rejects malformed metadata before any owner effect', async () => {
  const unused = new Proxy(
    {},
    {
      get() {
        throw new Error('Invalid metadata reached an owner');
      },
    },
  );
  const app = zoneRoutes(
    unused as FusekiClient,
    { environment: unused, account: unused, access: unused } as unknown as MainWorkDependencies,
  );
  const zone = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
  for (const [name, language] of [
    ['Name', 'en_US'],
    ['', 'ar'],
    ['   ', 'ar'],
    ['A'.repeat(301), 'ar'],
    [undefined, 'ar'],
    ['Name', null],
  ] as const) {
    const response = await app.handle(
      new Request('http://main.local/v1/zones', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'invalid' },
        body: JSON.stringify({
          zone,
          space: zone,
          actingSubject: zone,
          disclosure: 'public',
          name,
          language,
        }),
      }),
    );
    // Main maps Elysia's schema 422 to its public 400 problem contract.
    expect([400, 422]).toContain(response.status);
  }
});
