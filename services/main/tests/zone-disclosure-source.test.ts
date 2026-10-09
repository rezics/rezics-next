import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { profileRegistry } from '../../../packages/model/src/generated/profiles.ts';
import { InvalidCompositionChange } from '../src/modules/structure/change.ts';
import { iri, prepareComponent, RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { deliverZoneSpacePolicy } from '../src/modules/space/policy.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { readZoneConfiguration } from '../src/modules/zone/configuration.ts';
import { zoneDisclosureFromSpace } from '../src/modules/zone/owner-create.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const binding = (value: string) => ({ type: 'literal', value });

function reader(input: { zoneDisclosure?: 'public' | 'private'; spaceDisclosure: 'public' | 'private' }) {
  const zone = id(), space = id(), navigation = id();
  const directory = mkdtempSync('.temp/zone-disclosure-source-');
  const stored = { format: ZONE_CONFIG_FORMAT, zone, space, navigation, state: 'active' as const,
    disclosure: 'private' as const, budget: { timeMs: 2000, rows: 1000 }, queryBlocks: [], model: ZONE_PROFILE };
  const manifest = prepareComponent(directory, zone, { configuration: stored, name: 'Site', language: 'en' }, ZONE_PROFILE);
  const row = Object.fromEntries(Object.entries({
    space, navigation, head: zone, manifest: `urn:rezics:sha256:${manifest}`, state: RV + 'Active',
    ...(input.zoneDisclosure ? { disclosure: RV + (input.zoneDisclosure === 'public' ? 'Public' : 'Private') } : {}),
    spaceDisclosure: RV + (input.spaceDisclosure === 'public' ? 'Public' : 'Private'), listing: 'listed',
  }).map(([key, value]) => [key, binding(value)]));
  const env = { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (query: string) => {
      if (query.includes('ASK')) return { boolean: true };
      if (query.includes('SELECT ?space ?navigation ?head')) return { results: { bindings: [row] } };
      throw new Error(`Unexpected query: ${query}`);
    } } } as unknown as WorkActivationEnvironment;
  return { env, zone, row, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('a Zone reader uses its Space disclosure when the stored Zone copy disagrees', async () => {
  for (const spaceDisclosure of ['public', 'private'] as const) {
    const created = reader({ zoneDisclosure: spaceDisclosure === 'public' ? 'private' : 'public', spaceDisclosure });
    try {
      const read = await readZoneConfiguration(created.env, created.zone);
      expect(read.disclosure).toBe(spaceDisclosure);
      expect(read.spaceVisibility).toBe(spaceDisclosure);
      expect(read.configuration.disclosure).toBe(spaceDisclosure);
    } finally { created.close(); }
  }
  const absent = reader({ spaceDisclosure: 'public' });
  try {
    expect((await readZoneConfiguration(absent.env, absent.zone)).disclosure).toBe('public');
  } finally { absent.close(); }
});

test('Space settings change what the Zone reader returns and do not write the Zone', async () => {
  const created = reader({ zoneDisclosure: 'private', spaceDisclosure: 'private' });
  const updates: string[] = [];
  let committed = false;
  const space = id(), zone = id();
  const settings = { objectDirectory: '', lineage: { dataEpoch: 'current', routingEpoch: 'current' },
    fuseki: { commandHealth: async () => ({ moduleVersion: '', instanceId: '', publicSearchWriteEpoch: '',
      publicSearchWriteActive: false, profiles: Object.fromEntries(Object.entries(profileRegistry)
        .map(([profile, pinned]) => [profile, pinned.sha256])) }),
    query: async (sparql: string) => sparql.includes('ASK') ? { boolean: committed } : { results: { bindings: [] } },
    commandWithReceipt: async (envelope: { update: string }) => {
      updates.push(envelope.update);
      committed = true;
      return { status: 'committed' as const, position: { datasetId: 'dataset', dataEpoch: 'current', sequence: '1' } };
    } } } as unknown as WorkActivationEnvironment;
  try {
    expect((await readZoneConfiguration(created.env, created.zone)).disclosure).toBe('private');
    created.row.spaceDisclosure = binding(RV + 'Public');
    expect((await readZoneConfiguration(created.env, created.zone)).configuration.disclosure).toBe('public');
    await deliverZoneSpacePolicy(settings, { space, zone, receipt_id: randomUUID(), generation: '1',
      visibility: 'public', listing: 'listed' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`${iri(space)} rv:disclosure rv:Public`);
    expect(updates[0]).not.toContain(`${iri(zone)} rv:disclosure`);
  } finally { created.close(); }
});

test('Zone creation accepts only the Space disclosure', async () => {
  const space = id();
  const env = (value: string | undefined) => ({ fuseki: { query: async () => ({ results: { bindings: value
    ? [{ disclosure: binding(value) }] : [] } }) } } as unknown as WorkActivationEnvironment);
  expect(await zoneDisclosureFromSpace(env(RV + 'Public'), space, 'public')).toBe('public');
  expect(await zoneDisclosureFromSpace(env(RV + 'Private'), space, 'private')).toBe('private');
  await expect(zoneDisclosureFromSpace(env(RV + 'Public'), space, 'private')).rejects.toBeInstanceOf(InvalidCompositionChange);
  await expect(zoneDisclosureFromSpace(env(RV + 'Private'), space, 'public')).rejects.toBeInstanceOf(InvalidCompositionChange);
  await expect(zoneDisclosureFromSpace(env(undefined), space, 'public')).rejects.toBeInstanceOf(InvalidCompositionChange);
});
