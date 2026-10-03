import { expect, test } from 'bun:test';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { RV } from '../src/modules/work/activate.ts';
import { readResourceVisibility } from '../src/modules/space/visibility.ts';

const zone = 'https://rezics.com/id/00000000-0000-8000-8000-000000000963';
function env(realm = false) {
  return { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' }, fuseki: {
    query: async (query: string) => query.includes('SELECT DISTINCT') ? {
      results: { bindings: [{ kind: { value: 'space' }, space: { value: zone },
        disclosure: { value: RV + 'Private' }, zoneDisclosure: { value: RV + 'Private' },
        listing: { value: 'unlisted' }, ...(realm ? { realm: { value: zone } } : {}) }] },
    } : { boolean: true },
  } } as unknown as WorkActivationEnvironment;
}

test('G-963: a private Zone-only Space uses Zone read authority without inventing Realm membership', async () => {
  expect(await readResourceVisibility(env(), zone, { zoneReadable: async () => true }))
    .toMatchObject({ readable: true, findable: false, visibility: 'private', realm: null });
  expect(await readResourceVisibility(env(), zone, { zoneReadable: async () => false }))
    .toMatchObject({ readable: false, findable: false });
});

test('G-963: a Zone grant cannot bypass the independent private Realm fence', async () => {
  expect(await readResourceVisibility(env(true), zone, { zoneReadable: async () => true,
    realmReadProof: async () => null })).toMatchObject({ readable: false });
  expect(await readResourceVisibility(env(true), zone, { zoneReadable: async () => true,
    realmReadProof: async () => 'admitted' })).toMatchObject({ readable: true });
});
