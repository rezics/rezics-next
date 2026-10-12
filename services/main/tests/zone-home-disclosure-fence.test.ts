import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { DisclosureUnavailable } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { captureHomeDisclosureFence } from '../src/modules/zone/home-disclosure-fence.ts';
import { configureZoneHomeDisclosure, zoneHomeTargetId as id, zoneHomeTargetFixture } from './support/zone-home-target.ts';

async function captured(client?: PoolClient) {
  const h = zoneHomeTargetFixture();
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone,
    targets: [{ owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' }] }],
  ANONYMOUS_VIEWER, 'read', client);
  return { ...h, fence };
}

test('one final home fence checks disclosure after the last Zone-authority await', async () => {
  const h = await captured();
  expect(await h.fence(async () => { h.deny(true); return new Set([h.zone]); })).toEqual(new Set());
});

test('an owner-visible home cannot survive revoked Zone authority at the shared final fence', async () => {
  const h = await captured();
  expect(await h.fence(async () => new Set())).toEqual(new Set());
});

test('a final home fence refuses a lent snapshot-isolated Access transaction', async () => {
  const client = { query: async (query: string) => {
    expect(query).toBe('SHOW transaction_isolation');
    return { rows: [{ transaction_isolation: 'repeatable read' }] };
  } } as unknown as PoolClient;
  const h = await captured(client);
  await expect(h.fence(async () => new Set([h.zone]))).rejects.toBeInstanceOf(DisclosureUnavailable);
});

test('a restricted optional avatar is withheld while the independent home document keeps serving', async () => {
  const h = zoneHomeTargetFixture(), asset = id();
  let restricted = false;
  configureZoneHomeDisclosure(h.env, { read: async targets => targets.map(target =>
    restricted && target.owner === 'media' ? 'hidden' : 'visible') });
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone, optionalTargets: 1, targets: [
    { owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' },
    { owner: 'media', resource: asset, component: 'cover' },
  ] }], ANONYMOUS_VIEWER, 'summary');
  restricted = true;
  expect(await fence(async () => new Set([h.zone]))).toEqual(new Set([h.resource]));
});

test('a required selected Content body withholds the home even when its native record remains visible', async () => {
  const h = zoneHomeTargetFixture();
  let restricted = false;
  configureZoneHomeDisclosure(h.env, { read: async targets => targets.map(target =>
    restricted && target.owner === 'content' ? 'hidden' : 'visible') });
  const fence = await captureHomeDisclosureFence(h.env, [{ resource: h.resource, zone: h.zone, targets: [
    { owner: 'graph', resource: h.resource, revision: h.revision, component: 'record' },
    { owner: 'content', resource: h.resource, revision: h.selections[0]!.revisionId, component: 'body' },
  ] }], ANONYMOUS_VIEWER, 'read');
  restricted = true;
  expect(await fence(async () => new Set([h.zone]))).toEqual(new Set());
});
