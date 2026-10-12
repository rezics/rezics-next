import { expect, test } from 'bun:test';
import { readZoneVisibilities } from '../src/modules/space/visibility.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { zoneHomeTargetId as id, zoneHomeTargetCell as cell } from './support/zone-home-target.ts';

for (const size of [16, 64, 256]) {
  test(`${size} home Zones share one exact visibility query`, async () => {
    const zones = Array.from({ length: size }, id);
    const queries: string[] = [];
    const env = { lineage: { dataEpoch: id().slice(-36), routingEpoch: id().slice(-36) }, fuseki: {
      query: async (query: string) => {
        queries.push(query);
        expect(query).toContain('VALUES ?target');
        for (const zone of zones) expect(query).toContain(`<${zone}>`);
        return { results: { bindings: zones.map(zone => ({ target: cell(zone), kind: cell('space'),
          space: cell(id()), disclosure: cell(`${RV}Public`), zoneDisclosure: cell(`${RV}Private`) })) } };
      },
    } } as unknown as WorkActivationEnvironment;
    const result = await readZoneVisibilities(env, zones);
    expect(result.size).toBe(size);
    expect([...result.values()].every(policy => policy.readable && policy.visibility === 'public')).toBe(true);
    expect(queries).toHaveLength(1);
  });
}

test('batched homes retain private Zone authority and the independent Realm proof', async () => {
  const zones = [id(), id(), id()], realm = id(), scopes: string[] = [];
  const env = { lineage: { dataEpoch: id().slice(-36), routingEpoch: id().slice(-36) }, fuseki: {
    query: async () => ({ results: { bindings: zones.map((zone, index) => ({ target: cell(zone), kind: cell('space'),
      space: cell(id()), disclosure: cell(`${RV}Private`), zoneDisclosure: cell(`${RV}Private`),
      ...(index === 1 ? { realm: cell(realm) } : {}) })) } }),
  } } as unknown as WorkActivationEnvironment;
  const policies = await readZoneVisibilities(env, zones, {
    zoneReadable: async zone => { scopes.push(zone); return true; }, realmReadProof: async () => null,
  });
  expect(policies.get(zones[0]!)?.readable).toBe(true);
  expect(policies.get(zones[1]!)?.readable).toBe(false);
  expect(policies.get(zones[2]!)?.readable).toBe(true);
  expect(scopes).toEqual([zones[0]!, zones[2]!]);
});
