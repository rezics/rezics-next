import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { contributionFixture } from '../src/kernel/fake/contribution-lifecycle';
import {
  changeContribution,
  confirmedContributionOperation,
  readContributionAvailability,
  contributionInput,
  type ContributionCommand,
} from '../src/features/catalogue/contribution-lifecycle';
import { readCandidates } from '../src/subject/candidates';

function command(
  fixture: ReturnType<typeof contributionFixture>,
  operation: 'delete' | 'restore' = 'delete',
): ContributionCommand {
  return { ...fixture.address, operation, key: crypto.randomUUID() };
}

test('Withdraw and restore an owned contribution without deleting its subject through the declared native contract with truthful authority and failure states', async () => {
  const fixture = contributionFixture();
  const input = command(fixture);
  const deleted = await fixture.transport.change(input);
  expect(deleted).toMatchObject({
    ok: true,
    operation: 'delete',
    current: { subject: 'available', candidate: 'deleted', selected: false },
  });
  const restored = await fixture.transport.change({
    ...input,
    operation: 'restore',
    key: crypto.randomUUID(),
    ...(deleted.ok && deleted.session ? { session: deleted.session } : {}),
  });
  expect(restored).toMatchObject({
    ok: true,
    operation: 'restore',
    current: { subject: 'available', candidate: 'available', selected: false },
  });
  const mutations = fixture.calls.filter((call) => call.method !== 'GET');
  expect(mutations.map(({ method, path }) => [method, path])).toEqual([
    ['DELETE', `/v1/subjects/${input.id}/candidates/${input.candidate}`],
    ['POST', `/v1/subjects/${input.id}/candidates/${input.candidate}:restoreDeleted`],
  ]);
  expect(mutations[0]?.key).toBe(input.key);
  expect(mutations[0]?.session).toBe('proposal-session');
  expect(mutations[1]?.key).not.toBe(input.key);
  expect(mutations[1]?.body).toEqual({});
  expect(fixture.calls.every((call) => call.authorization === 'Bearer fixture')).toBe(true);
  expect(fixture.calls.some((call) => call.method === 'GET' && call.session === 'contribution-session')).toBe(true);
  expect(JSON.stringify([deleted, restored])).not.toContain('statement');
  expect(JSON.stringify([deleted, restored])).not.toContain('source');
  await fixture.transport.change({ ...input, key: crypto.randomUUID() });
  const comparison = await readCandidates(fixture.client, 'Bearer fixture', input.id, input.property);
  expect(comparison.ok && comparison.page?.candidates).toEqual([]);
});

test('an uncertain response replays the exact subject, candidate, session and key without a local tombstone', async () => {
  const fixture = contributionFixture('uncertain');
  const input = command(fixture);
  const snapshot = structuredClone(input);
  expect(await fixture.transport.change(input)).toEqual({ ok: false, reason: 'unavailable' });
  expect(fixture.calls).toHaveLength(1);
  expect(await fixture.transport.change(input)).toMatchObject({ ok: true, current: { candidate: 'deleted' } });
  expect(input).toEqual(snapshot);
  expect(fixture.calls[0]).toEqual(fixture.calls[1]);
});

test('native denial, unserved lifecycle and expiry are truthful outcomes independent of provenance', async () => {
  for (const scenario of ['denied', 'unavailable', 'expired', 'invalid'] as const) {
    const fixture = contributionFixture(scenario);
    // Null and provider provenance never establish lifecycle permission; the native result decides.
    fixture.candidate.source = null;
    const input = command(fixture, scenario === 'expired' ? 'restore' : 'delete');
    expect(await fixture.transport.change(input)).toEqual({
      ok: false,
      reason: scenario === 'unavailable' ? 'unavailable' : scenario === 'expired' ? 'conflict' : scenario,
    });
    expect(fixture.calls).toHaveLength(1);
  }
});

test('restore rereads current withholding and never promotes mutation output into public selection', async () => {
  const fixture = contributionFixture('withheld');
  const input = command(fixture);
  expect(await fixture.transport.change(input)).toMatchObject({ ok: true, operation: 'delete' });
  expect(
    await changeContribution(fixture.client, 'Bearer fixture', {
      ...input,
      operation: 'restore',
      key: crypto.randomUUID(),
    }),
  ).toMatchObject({
    ok: true,
    operation: 'restore',
    current: { subject: 'unavailable', candidate: 'unconfirmed', selected: null },
  });
  expect(() => contributionInput({ ...input, source: null })).toThrow();
  expect(() => contributionInput({ ...input, operation: 'purge' })).toThrow();
});

test('DELETE sends authority and replay headers as options with no body; the fixture rejects the old body shape', async () => {
  const fixture = contributionFixture();
  const input = command(fixture);
  const url = `https://contribution.test/v1/subjects/${input.id}/candidates/${input.candidate}`;
  const headers = {
    authorization: 'Bearer fixture',
    'idempotency-key': input.key,
    'rezics-session-token': input.session!,
  };
  // The former Eden call serialized these options into a DELETE body, without sending its headers.
  expect((await fixture.fetcher(url, { method: 'DELETE', body: JSON.stringify({ headers }) })).status).toBe(403);
  expect((await fixture.transport.read(input)).candidate).toBe('available');
  expect((await fixture.fetcher(url, { method: 'POST', headers, body: '{}' })).status).toBe(405);
  expect(await fixture.transport.change(input)).toMatchObject({ ok: true, current: { candidate: 'deleted' } });
  expect(fixture.calls.filter((call) => call.method === 'DELETE').at(-1)).toEqual({
    method: 'DELETE',
    path: new URL(url).pathname,
    authorization: headers.authorization,
    session: input.session,
    key: input.key,
    body: null,
  });
});

test('missing native binding stays unavailable, and a restore acknowledgement cannot supply current private values', async () => {
  const fixture = contributionFixture();
  const input = command(fixture, 'restore');
  const calls: string[] = [];
  let bound = false;
  let malformedRead = false;
  const client = createKernelClient('https://unserved-contribution.test', {
    fetch: (async (request, init) => {
      const native = request instanceof Request ? request : new Request(String(request), init);
      calls.push(native.method);
      if (native.method === 'GET' && malformedRead) return Response.json({ candidates: {} });
      return Response.json(
        native.method === 'POST' && bound
          ? { subject: input.id, candidate: input.candidate, deleted: false }
          : { code: 'not_found' },
        { status: native.method === 'POST' && bound ? 200 : 404 },
      );
    }) as typeof fetch,
  });
  expect(await changeContribution(client, 'Bearer fixture', input)).toEqual({ ok: false, reason: 'unavailable' });
  expect(calls).toEqual(['POST']);
  bound = true;
  const restored = await changeContribution(client, 'Bearer fixture', input);
  expect(restored).toMatchObject({
    ok: true,
    operation: 'restore',
    current: { subject: 'unavailable', candidate: 'unconfirmed', selected: null },
  });
  expect(calls).toEqual(['POST', 'POST', 'GET']);
  expect(JSON.stringify(restored)).not.toContain('1946');
  expect(JSON.stringify(restored)).not.toContain('statement');
  malformedRead = true;
  expect(await changeContribution(client, 'Bearer fixture', input)).toMatchObject({
    ok: true,
    operation: 'restore',
    current: { subject: 'unavailable', candidate: 'unconfirmed', selected: null },
  });
});

test.each(['delete', 'restore'] as const)(
  'The existing own contribution UI consumes generated native delete and restore responses with exact identity and current availability, never treating an unrelated or contradictory 200 as success: %s',
  async (operation) => {
    const fixture = contributionFixture();
    const input = command(fixture, operation);
    const matched = { subject: input.id, candidate: input.candidate, deleted: operation === 'delete' };
    const unexpected: unknown[] = [
      { ...matched, subject: crypto.randomUUID() },
      { ...matched, candidate: crypto.randomUUID() },
      { ...matched, deleted: !matched.deleted },
      { ...matched, deleted: String(matched.deleted) },
      { subject: input.id, candidate: input.candidate },
      { ...matched, statement: fixture.candidate.statement },
      {},
      null,
      [],
      'acknowledged',
    ];
    for (const body of unexpected) {
      let reply = body;
      const calls: { method: string; path: string; key: string | null; session: string | null }[] = [];
      const client = createKernelClient('https://native-contribution.test', {
        fetch: (async (request, init) => {
          const native = request instanceof Request ? request : new Request(String(request), init);
          calls.push({
            method: native.method,
            path: new URL(native.url).pathname,
            key: native.headers.get('idempotency-key'),
            session: native.headers.get('rezics-session-token'),
          });
          if (native.method === 'GET') return fixture.fetcher(native);
          return Response.json(reply, { headers: { 'rezics-session-token': 'native-session' } });
        }) as typeof fetch,
      });
      const snapshot = structuredClone(input);
      expect(await changeContribution(client, 'Bearer fixture', input)).toEqual({ ok: false, reason: 'unavailable' });
      expect(calls).toEqual([
        {
          method: operation === 'delete' ? 'DELETE' : 'POST',
          path: `/v1/subjects/${input.id}/candidates/${input.candidate}${operation === 'restore' ? ':restoreDeleted' : ''}`,
          key: input.key,
          session: input.session!,
        },
      ]);

      reply = matched;
      // A validated receipt permits a fresh read; its deleted bit never supplies current availability.
      expect(await changeContribution(client, 'Bearer fixture', input)).toMatchObject({
        ok: true,
        operation,
        current: { subject: 'available', candidate: 'available', selected: false },
      });
      expect(input).toEqual(snapshot);
      expect(calls[1]).toEqual(calls[0]);
      expect(calls.slice(2).map(({ method, session }) => ({ method, session }))).toEqual([
        { method: 'GET', session: 'native-session' },
      ]);
    }
  },
);

test('fresh operations require current native action evidence and concealed reads disclose no tombstone', async () => {
  for (const candidate of ['available', 'deleted'] as const) {
    const current = { subject: 'available' as const, candidate, selected: false };
    expect(confirmedContributionOperation(current)).toBeNull();
    expect(confirmedContributionOperation({ ...current, actions: { state: 'unavailable' } })).toBeNull();
    expect(confirmedContributionOperation({ ...current, actions: { state: 'available', operations: [] } })).toBeNull();
    const operation = candidate === 'deleted' ? 'restore' : 'delete';
    expect(
      confirmedContributionOperation({ ...current, actions: { state: 'available', operations: [operation] } }),
    ).toBe(operation);
  }
  const fixture = contributionFixture();
  const client = createKernelClient('https://hidden.test', {
    fetch: (async () => Response.json({ code: 'not_found' }, { status: 404 })) as typeof fetch,
  });
  expect(await readContributionAvailability(client, 'Bearer fixture', fixture.address)).toMatchObject({
    subject: 'unavailable',
    candidate: 'unconfirmed',
    selected: null,
    actions: { state: 'unavailable' },
  });
});
