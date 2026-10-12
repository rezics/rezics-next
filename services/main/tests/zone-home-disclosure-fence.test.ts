import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { configureFixtureDisclosureAncestry } from './support/disclosure-ancestry.ts';
import { DisclosureUnavailable } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { captureHomeDisclosureFence } from '../src/modules/zone/home-disclosure-fence.ts';
import { configureZoneHomeDisclosure, zoneHomeTargetId as id, zoneHomeTargetFixture } from './support/zone-home-target.ts';

async function captured(client?: PoolClient, readZones?: (h: ReturnType<typeof zoneHomeTargetFixture>) => Promise<ReadonlySet<string>>) {
  const h = zoneHomeTargetFixture();
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone,
    targets: [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }] }],
  ANONYMOUS_VIEWER, 'read', () => readZones ? readZones(h) : Promise.resolve(new Set([h.zone])), client);
  return { ...h, fence };
}

test('the home capture checks disclosure after its captured Zone-authority await', async () => {
  const h = await captured(undefined, async h => { h.deny(true); return new Set([h.zone]); });
  expect(await h.fence()).toEqual(new Set());
});

test('an owner-visible home cannot survive revoked Zone authority at the shared final fence', async () => {
  let readable = true;
  const h = await captured(undefined, async h => new Set(readable ? [h.zone] : []));
  readable = false;
  expect(await h.fence()).toEqual(new Set());
});

test('a final home fence refuses a lent snapshot-isolated Access transaction', async () => {
  const client = { query: async (query: string) => {
    expect(query).toBe('SHOW transaction_isolation');
    return { rows: [{ transaction_isolation: 'repeatable read' }] };
  } } as unknown as PoolClient;
  const h = await captured(client);
  await expect(h.fence()).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('a restricted optional avatar is withheld while the independent home document keeps serving', async () => {
  const h = zoneHomeTargetFixture(), asset = id();
  let restricted = false;
  configureZoneHomeDisclosure(h.env, { read: async targets => targets.map(target =>
    restricted && target.owner === 'media' ? 'hidden' : 'visible') });
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone, optionalTargets: 1, targets: [
    { owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' },
    { owner: 'media', resource: asset, component: 'cover' },
  ] }], ANONYMOUS_VIEWER, 'summary', async () => new Set([h.zone]));
  restricted = true;
  expect(await fence()).toEqual(new Set([h.resource]));
});

test('a required selected Content body withholds the home even when its native record remains visible', async () => {
  const h = zoneHomeTargetFixture();
  let restricted = false;
  configureZoneHomeDisclosure(h.env, { read: async targets => targets.map(target =>
    restricted && target.owner === 'content' ? 'hidden' : 'visible') });
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone, targets: [
    { owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' },
    { owner: 'content', resource: h.resource, revision: h.selections[0]!.revisionId, component: 'body' },
  ] }], ANONYMOUS_VIEWER, 'read', async () => new Set([h.zone]));
  restricted = true;
  expect(await fence()).toEqual(new Set());
});


test('a new Zone grant cannot promote authority missing from the original disclosure capture', async () => {
  const h = zoneHomeTargetFixture();
  let readable = false;
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone,
    targets: [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }] }],
  ANONYMOUS_VIEWER, 'read', async () => new Set(readable ? [h.zone] : []));
  readable = true;
  expect(await fence()).toEqual(new Set());
});


test('home cost counts captured and final policy statements plus their actual parent-head batches', async () => {
  const h = zoneHomeTargetFixture(), work = id(), head = id();
  configureFixtureDisclosureAncestry(h.env, () => ({ resource: work, head }));
  const graph = h.env.fuseki.query.bind(h.env.fuseki);
  let headQueries = 0;
  h.env.fuseki.query = async (query, budget) => {
    if (query.includes('SELECT ?resource ?head')) {
      headQueries++;
      return { results: { bindings: [{ resource: { type: 'uri', value: work }, head: { type: 'uri', value: head } }] } };
    }
    return graph(query, budget);
  };
  const cost = { graphQueries: 0, accessQueries: 0 };
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone,
    targets: [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }] }],
  ANONYMOUS_VIEWER, 'summary', async () => new Set([h.zone]), undefined, cost);
  expect(cost).toEqual({ graphQueries: 1, accessQueries: 1 });
  expect(await fence()).toEqual(new Set([h.resource]));
  expect(cost).toEqual({ graphQueries: headQueries, accessQueries: h.policyTargets.length });
  expect(cost).toEqual({ graphQueries: 2, accessQueries: 2 });
});

// The disclosure owner must fence Zone/Realm authority and policy in the same final cut.
test.failing('a restriction arriving during the final Zone authority read withholds the captured home', async () => {
  const h = zoneHomeTargetFixture();
  let authorityReads = 0;
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone,
    targets: [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }] }],
  ANONYMOUS_VIEWER, 'read', async () => {
    if (++authorityReads === 2) h.deny(true);
    return new Set([h.zone]);
  });
  expect(await fence()).toEqual(new Set());
});
