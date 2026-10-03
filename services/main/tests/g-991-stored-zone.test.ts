import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Value } from 'typebox/value';
import { checkStoredZoneConfiguration, checkZoneConfiguration, InvalidZoneConfiguration,
  ZoneConfiguration, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { readZoneConfiguration } from '../src/modules/zone/configuration.ts';
import { readZonePublication } from '../src/modules/zone/publication.ts';
import { hash, prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';

// Golden retained bytes from the v1 shape before 87b6b3dbc. Do not build these
// with current schema constants: future required fields must break this test.
// Closed JSON schemas need an explicit stored reader when fields are removed:
// https://docs.confluent.io/platform/current/schema-registry/fundamentals/schema-evolution.html#json-schema-with-strict-policy
export const legacyOfficialZone = `{
  "format":"rezics-zone-config-v1",
  "zone":"https://rezics.com/id/00000000-0000-4000-8000-000000000001",
  "space":"https://rezics.com/id/00000000-0000-4000-8000-000000000002",
  "navigation":"https://rezics.com/id/00000000-0000-4000-8000-000000000003",
  "state":"active","disclosure":"public",
  "defaultRealm":"https://rezics.com/id/00000000-0000-4000-8000-000000000004",
  "official":{"routeSegment":"light-novels"},
  "budget":{"timeMs":2000,"rows":1000},"queryBlocks":[],
  "model":"https://rezics.com/definition/zone-capability-v1"
}`;
const legacyRichZone = `{
  "format":"rezics-zone-config-v1",
  "zone":"https://rezics.com/id/00000000-0000-4000-8000-000000000001",
  "space":"https://rezics.com/id/00000000-0000-4000-8000-000000000002",
  "navigation":"https://rezics.com/id/00000000-0000-4000-8000-000000000003",
  "state":"active","disclosure":"public",
  "defaultRealm":"https://rezics.com/id/00000000-0000-4000-8000-000000000004",
  "official":{"routeSegment":"light-novels"},
  "defaultContext":{"context":"https://rezics.com/id/00000000-0000-4000-8000-000000000005",
    "semanticRevision":"https://rezics.com/id/00000000-0000-4000-8000-000000000006"},
  "presentation":"https://rezics.com/definition/zone-presentation-v1",
  "advanced":"sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "budget":{"timeMs":1000,"rows":24},
  "queryBlocks":[{"block":"shelf","definition":"https://rezics.com/id/00000000-0000-4000-8000-000000000005","maxRows":24},
    {"block":"nested-shelf","parent":"shelf","definition":"https://rezics.com/id/00000000-0000-4000-8000-000000000005","maxRows":12}],
  "model":"https://rezics.com/definition/zone-capability-v1"
}`;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));

test('G991: stored v1 golden payloads normalize only the former official name; new writes stay closed', () => {
  for (const golden of [legacyOfficialZone, legacyRichZone]) {
    const raw = JSON.parse(golden);
    const read = checkStoredZoneConfiguration(Buffer.from(golden));
    expect(read).toEqual({ ...raw, official: {} });
    expect(Value.Check(ZoneConfiguration, raw)).toBe(false);
    expect(() => checkZoneConfiguration(Buffer.from(golden))).toThrow(InvalidZoneConfiguration);
    expect(checkZoneConfiguration(bytes(read))).toEqual(read);
    expect(checkStoredZoneConfiguration(bytes(read))).toEqual(read);
  }
  const ordinary = JSON.parse(legacyOfficialZone);
  delete ordinary.official;
  delete ordinary.defaultRealm;
  expect(checkStoredZoneConfiguration(bytes(ordinary))).toEqual(ordinary);
});

test('G991: legacy tolerance retains corruption, semantic and byte-bound checks', () => {
  const raw = JSON.parse(legacyOfficialZone);
  for (const official of [{ routeSegment: '../unsafe' }, { routeSegment: 42 },
    { routeSegment: 'a'.repeat(65) }, { routeSegment: 'books', unknown: true }, null]) {
    expect(() => checkStoredZoneConfiguration(bytes({ ...raw, official }))).toThrow(InvalidZoneConfiguration);
  }
  for (const patch of [{ unexpected: true }, { format: 'rezics-zone-config-v2' },
    { defaultRealm: undefined }, { disclosure: 'private' },
    { queryBlocks: [{ block: 'nested', parent: 'missing', definition: raw.zone, maxRows: 10 }] }]) {
    expect(() => checkStoredZoneConfiguration(bytes({ ...raw, ...patch }))).toThrow(InvalidZoneConfiguration);
  }
  for (const bad of [Buffer.from('{'), Buffer.from([0xff]), Buffer.alloc(65_537)]) {
    expect(() => checkStoredZoneConfiguration(bad)).toThrow(InvalidZoneConfiguration);
  }
});

test('G991: deferred-import stored heads and publication reads preserve immutable bytes and use registry authority', async () => {
  const directory = mkdtempSync('.temp/g-991-stored-');
  const raw = JSON.parse(legacyOfficialZone);
  const manifest = prepareComponent(directory, raw.zone,
    { configuration: raw, name: 'Light Novels', language: 'en' }, ZONE_PROFILE);
  const originalManifest = readFileSync(`${directory}/${manifest}`);
  const payload = JSON.parse(originalManifest.toString()).payload.slice(7);
  const originalPayload = readFileSync(`${directory}/${payload}`);
  const row = Object.fromEntries(Object.entries({ space: raw.space, navigation: raw.navigation,
    head: raw.zone, manifest: `urn:rezics:sha256:${manifest}`, state: RV + 'Active',
    disclosure: RV + 'Public', spaceDisclosure: RV + 'Public', listing: 'listed',
    official: 'true', realm: raw.defaultRealm }).map(([key, value]) => [key, { type: 'literal', value }]));
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (query: string) => {
      if (query.includes('ASK')) return { boolean: true };
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [row] } };
      throw new Error(`Unexpected query: ${query}`);
    } },
    addresses: { currents: async () => new Map() },
  } as unknown as WorkActivationEnvironment;
  try {
    expect((await readZoneConfiguration(env, raw.zone)).configuration).toEqual({ ...raw, official: {} });
    const deferred = await readZonePublication(env, raw.zone);
    expect(deferred.address.key).not.toBe('light-novels');
    env.addresses!.currents = async () => new Map([[`space\0${raw.space}`, { key: 'renamed-site' }]]) as never;
    expect((await readZonePublication(env, raw.zone)).official).toBe('renamed-site');
    expect(readFileSync(`${directory}/${manifest}`)).toEqual(originalManifest);
    expect(hash(readFileSync(`${directory}/${payload}`))).toBe(hash(originalPayload));
    row.official!.value = 'false';
    await expect(readZoneConfiguration(env, raw.zone)).rejects.toThrow('Official Zone marker differs');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
