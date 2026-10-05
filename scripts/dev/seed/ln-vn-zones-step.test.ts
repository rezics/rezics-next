import { expect, test } from 'bun:test';
import { createSpace } from './ln-vn-zones-step.ts';
import type { HttpResult, SeedPort } from './vn-catalogue-step.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const zone = native('1');
const spec = { id: 'light-novels', name: 'Light novels', language: 'en', routeSegment: 'light-novels', preset: 'editorial' as const,
  mountSegment: 'catalogue', navigation: [], browse: [], announcement: '', sharedMember: '' };

function port(create: HttpResult, pages: Record<string, HttpResult> = {}) {
  const calls: string[] = [];
  const fake: SeedPort = {
    actingSubject: native('9'),
    request: async (method, path) => {
      calls.push(`${method} ${path.split('?')[0]}`);
      if (method === 'POST') return create;
      return pages[path.split('?')[0]!] ?? { status: 404, body: {} };
    },
    grant: async (scope, action) => { calls.push(`grant ${action} ${scope}`); },
  };
  return { fake, calls };
}
const conflict: HttpResult = { status: 409, body: { code: 'idempotency_conflict' } };
const existing = {
  [`/v1/zones/${zone.slice(-36)}/configuration`]: { status: 200,
    body: { configuration: { space: native('2'), defaultRealm: native('3') } } },
  [`/v1/realms/${native('3').slice(-36)}`]: { status: 200, body: { id: native('3'), space: native('2') } } };

test('a new Space is the create receipt, with no further reads', async () => {
  const { fake, calls } = port({ status: 200, body: { space: native('2'), realm: native('3') } });
  expect(await createSpace(fake, spec, zone)).toEqual({ space: native('2'), realm: native('3') });
  expect(calls).toEqual(['POST /v1/spaces']);
});

test('a Space recorded under an earlier body is adopted through its Zone after the Zone grant, with no second create', async () => {
  const { fake, calls } = port(conflict, existing);
  expect(await createSpace(fake, spec, zone)).toMatchObject({ space: native('2'), realm: native('3') });
  expect(calls[0]).toBe('POST /v1/spaces');
  expect(calls[1]).toBe(`grant zone.official zone:official:${zone}`);
  expect(calls.filter(call => call.startsWith('POST'))).toHaveLength(1);
});

test('a conflict whose Zone does not name the Space stays a failure', async () => {
  const { fake } = port(conflict);
  await expect(createSpace(fake, spec, zone)).rejects.toThrow('POST /v1/spaces HTTP 409');
});

test('other refusals are never adopted', async () => {
  const { fake, calls } = port({ status: 403, body: { code: 'forbidden' } }, existing);
  await expect(createSpace(fake, spec, zone)).rejects.toThrow('HTTP 403');
  expect(calls).toEqual(['POST /v1/spaces']);
});
