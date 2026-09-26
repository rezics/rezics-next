import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import type { Pool } from 'pg';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import type { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { BackpressureSaturated, BackpressureUnavailable, InFlightAdmission,
  type AdmissionLease, type LeaseOutcome } from '../../../services/main/src/operations/admission-budget.ts';
import { BACKPRESSURE_PROFILE_V1, OperationsBackpressure,
  type DurablePositions } from '../../../services/main/src/operations/backpressure.ts';
import { ACCESS_OPERATIONAL_BOUNDS_V1, activateOperationalBounds,
  OperationalBoundsInvalid } from '../../../services/main/src/operations/bounds.ts';

const root = resolve(import.meta.dir, '../../..');
const epoch = '11111111-1111-4111-8111-111111111111';
const agent = 'https://rezics.com/id/22222222-2222-4222-8222-222222222222';

function constant(file: string, name: string): number {
  const match = new RegExp(`^const ${name} = (\\d+);$`, 'm')
    .exec(readFileSync(join(root, file), 'utf8'));
  if (!match) throw new Error(`${file} no longer declares ${name}`);
  return Number(match[1]);
}

test('IAM35: Access owner bounds equal the declared operational profile', () => {
  // A reduced owner constant must arrive as a new profile through activation,
  // never as an unreviewed code change that reinterprets saved grants.
  expect({
    actingContexts: constant('services/main/src/modules/access/contexts.ts', 'MAX_CONTEXTS'),
    groupDepth: constant('services/main/src/modules/access/groups.ts', 'MAX_DEPTH'),
    groupsPerScope: constant('services/main/src/modules/access/groups.ts', 'MAX_GROUPS'),
    membershipsPerScope: constant('services/main/src/modules/access/groups.ts', 'MAX_MEMBERSHIPS'),
    memberGroupsPerAgent: constant('services/main/src/modules/access/groups.ts', 'MAX_MEMBER_GROUPS'),
  }).toEqual({ actingContexts: 50, groupDepth: 32, groupsPerScope: 256,
    membershipsPerScope: 1024, memberGroupsPerAgent: 16 });
  const { id: _id, ...bounds } = ACCESS_OPERATIONAL_BOUNDS_V1;
  expect(bounds).toEqual({ actingContexts: 50, groupDepth: 32, groupsPerScope: 256,
    membershipsPerScope: 1024, memberGroupsPerAgent: 16 });
  expect(constant('services/main/src/modules/access/private-recipient-proof.ts', 'MAX_DEPTH'))
    .toBe(ACCESS_OPERATIONAL_BOUNDS_V1.groupDepth);
});

test('IAM35: a reduction needs a new identity; raising bounds reads no saved state', async () => {
  let connects = 0;
  const pool = { connect: async () => { connects += 1; throw new Error('unexpected read'); } } as unknown as Pool;
  await expect(activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1,
    { ...ACCESS_OPERATIONAL_BOUNDS_V1, actingContexts: 40 })).rejects.toBeInstanceOf(OperationalBoundsInvalid);
  await expect(activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1,
    { ...ACCESS_OPERATIONAL_BOUNDS_V1, id: 'access-operational-bounds-v2', groupDepth: 0 }))
    .rejects.toBeInstanceOf(OperationalBoundsInvalid);
  expect(await activateOperationalBounds(pool, ACCESS_OPERATIONAL_BOUNDS_V1,
    { ...ACCESS_OPERATIONAL_BOUNDS_V1, id: 'access-operational-bounds-v2', actingContexts: 64 }))
    .toEqual({ status: 'activated', profile: 'access-operational-bounds-v2', reduced: [] });
  expect(connects).toBe(0);
});

test('OPS06: in-flight admission never exceeds its budget and accounts every lease', () => {
  const operation = fc.oneof(
    fc.record({ kind: fc.constant('admit' as const), bytes: fc.integer({ min: 0, max: 40 }) }),
    fc.record({ kind: fc.constant('settle' as const), index: fc.nat(),
      outcome: fc.constantFrom<LeaseOutcome>('completed', 'refused', 'failed') }));
  fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 100 }),
    fc.array(operation, { maxLength: 200 }), (maxInFlight, maxBytes, operations) => {
      const budget = new InFlightAdmission('object', { maxInFlight, maxBytes, retryAfterSeconds: 1 });
      const open: AdmissionLease[] = [];
      let refusals = 0;
      for (const step of operations) {
        if (step.kind === 'admit') {
          const before = budget.counters();
          try { open.push(budget.admit(step.bytes)); }
          catch (error) {
            expect(error).toBeInstanceOf(BackpressureSaturated);
            expect((error as BackpressureSaturated).retryAfterSeconds).toBe(1);
            // A refusal is explicit and leaves the admitted work untouched.
            expect(before.inFlight >= maxInFlight || before.bytesInFlight + step.bytes > maxBytes).toBe(true);
            refusals += 1;
          }
        } else if (open.length > 0) {
          const [lease] = open.splice(step.index % open.length, 1);
          lease!.settle(step.outcome);
          expect(() => lease!.settle(step.outcome)).toThrow('already settled');
        }
        const counters = budget.counters();
        expect(counters.inFlight).toBeLessThanOrEqual(maxInFlight);
        expect(counters.bytesInFlight).toBeLessThanOrEqual(maxBytes);
        expect(counters.inFlight).toBe(open.length);
        expect(counters.bytesInFlight).toBe(open.reduce((sum, lease) => sum + lease.bytes, 0));
        expect(counters.admitted).toBe(counters.completed + counters.refused + counters.failed
          + counters.inFlight);
        expect(counters.rejected).toBe(refusals);
      }
    }), { seed: 35_06, numRuns: 200 });
});

test('OPS06: durable lanes saturate at the budget and fail closed when unprovable', async () => {
  let worker: DurablePositions | Error = { dataEpoch: epoch, head: 999n, delivered: 0n };
  const lanes = new OperationsBackpressure({ worker: async () => {
    if (worker instanceof Error) throw worker;
    return worker;
  } });
  await lanes.admitDurable('worker');
  await lanes.admitDurable('broker');
  expect((await lanes.read()).lanes.map(lane => lane.state)).toEqual(['open', 'unobserved', 'unobserved']);
  worker = { dataEpoch: epoch, head: 1000n, delivered: 0n };
  const refused = await lanes.admitDurable('worker').catch(error => error);
  expect(refused).toBeInstanceOf(BackpressureSaturated);
  expect(refused.retryAfterSeconds).toBe(BACKPRESSURE_PROFILE_V1.worker.retryAfterSeconds);
  expect((await lanes.read()).lanes[0]).toEqual({ lane: 'worker', state: 'saturated',
    maxBacklog: 1000, dataEpoch: epoch, head: '1000', delivered: '0', backlog: '1000' });
  worker = { dataEpoch: epoch, head: 5n, delivered: 6n };
  await expect(lanes.admitDurable('worker')).rejects.toBeInstanceOf(BackpressureUnavailable);
  worker = new Error('Content owner unavailable');
  await expect(lanes.admitDurable('worker')).rejects.toBeInstanceOf(BackpressureUnavailable);
  const snapshot = await lanes.read();
  expect(snapshot.complete).toBe(false);
  expect(snapshot.lanes[0]).toMatchObject({ state: 'unavailable', backlog: null });
});

test('OPS05/OPS06: snapshot work stays fixed while the backlog grows geometrically', async () => {
  for (const backlog of [0n, 100n, 10_000n, 1_000_000n, 100_000_000n]) {
    let calls = 0;
    const lanes = new OperationsBackpressure({
      worker: async () => { calls += 1; return { dataEpoch: epoch, head: backlog, delivered: 0n }; },
      broker: async () => { calls += 1; return { dataEpoch: epoch, head: backlog + 7n, delivered: 7n }; },
      object: true,
    });
    const snapshot = await lanes.read();
    expect(calls).toBe(2);
    expect(snapshot.lanes[0].backlog).toBe(backlog.toString());
    expect(snapshot.lanes[1].backlog).toBe(backlog.toString());
    expect(snapshot.lanes[0].state).toBe(backlog >= 1000n ? 'saturated' : 'open');
  }
});

test('OPS06: saturated object uploads are refused at the Main boundary and none is lost', async () => {
  const releases: Array<() => void> = [];
  let verified = 0;
  // The graph admission check is the command's first owner call; holding it
  // keeps each admitted request in flight until the test releases it.
  const fuseki = { query: async () => {
    verified += 1;
    await new Promise<void>(release => releases.push(release));
    throw new AccountAssertionDenied('held request');
  } } as unknown as FusekiClient;
  const work = {
    environment: { fuseki, lineage: { dataEpoch: epoch, routingEpoch: epoch },
      objectDirectory: '/nonexistent', workObjects: { put: async () => '', get: async () => new Uint8Array() } },
    account: { verify: async () => { throw new AccountAssertionDenied('unreachable'); } },
    access: {},
  } as unknown as MainWorkDependencies;
  const app = createMainApp({} as FusekiClient, work);
  const post = (key: string) => app.handle(new Request('http://main.local/v1/works', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key,
      authorization: 'Bearer a.b.c' },
    body: JSON.stringify({ profile: 'metadata-only-v1', title: 'Held', actingSubject: agent }) }));
  const read = async () => (await (await app.handle(
    new Request('http://main.local/v1/operations/backpressure'))).json()) as {
    lanes: [unknown, unknown, { state: string; counters: Record<string, number> }] };
  const limit = BACKPRESSURE_PROFILE_V1.object.maxInFlight;
  const held = Array.from({ length: limit }, (_, index) => post(`held-${index}`));
  while (verified < limit) await Bun.sleep(1);
  const saturated = await read();
  expect(saturated.lanes[2].state).toBe('saturated');
  expect(saturated.lanes[2].counters).toMatchObject({ inFlight: limit, admitted: limit, rejected: 0 });

  const refused = await post('over-budget');
  expect(refused.status).toBe(503);
  expect(refused.headers.get('retry-after')).toBe(String(BACKPRESSURE_PROFILE_V1.object.retryAfterSeconds));
  expect((await refused.json() as { code: string }).code).toBe('backpressure_saturated');
  // The refused request never reached the graph, Account or Access owners.
  expect(verified).toBe(limit);

  for (const release of releases) release();
  const settled = await Promise.all(held);
  const statuses = new Set(settled.map(response => response.status));
  expect(statuses.size).toBe(1);
  const [status] = [...statuses] as [number];
  expect(status).toBeGreaterThanOrEqual(400);
  await Bun.sleep(5);
  const drained = await read();
  expect(drained.lanes[2].state).toBe('open');
  expect(drained.lanes[2].counters).toEqual({ inFlight: 0, bytesInFlight: 0, admitted: limit,
    rejected: 1, completed: 0, refused: status < 500 ? limit : 0, failed: status >= 500 ? limit : 0 });

  // Validation failures never reach admission, so they hold no lease.
  const invalid = await app.handle(new Request('http://main.local/v1/works', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  expect(invalid.status).toBe(400);
  expect((await read()).lanes[2].counters.admitted).toBe(limit);
});

test('OPS06: a Main without configured sources reports every lane as unobserved', async () => {
  // The OpenAPI generator composes Main from empty dependencies.
  const app = createMainApp({} as FusekiClient, {} as MainWorkDependencies);
  const response = await app.handle(new Request('http://main.local/v1/operations/backpressure'));
  expect(response.status).toBe(200);
  const snapshot = await response.json() as { complete: boolean; lanes: { state: string }[] };
  expect(snapshot.complete).toBe(false);
  expect(snapshot.lanes.map(lane => lane.state)).toEqual(['unobserved', 'unobserved', 'unobserved']);
});
