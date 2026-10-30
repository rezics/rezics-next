import { expect, test } from 'bun:test';
import { contributionFixture } from '../src/kernel/fake/contribution-lifecycle';
import {
  changeContribution,
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
      reason: scenario === 'unavailable' ? 'unavailable' : scenario,
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
    current: { subject: 'available', candidate: 'unconfirmed', selected: false },
  });
  expect(() => contributionInput({ ...input, source: null })).toThrow();
  expect(() => contributionInput({ ...input, operation: 'purge' })).toThrow();
});
