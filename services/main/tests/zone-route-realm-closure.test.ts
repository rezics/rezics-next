import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { readZonePublication } from '../src/modules/zone/publication.ts';
import { readZonePresentation, resolveZoneRoute, ZoneRouteMissing } from '../src/modules/zone/route.ts';

function fixture(input: { realm: 'public' | 'private' | 'closed'; granted?: boolean;
  changed?: boolean; revoked?: boolean; fault?: boolean }) {
  const id = () => `https://rezics.com/id/${randomUUID()}`;
  const zone = id(), realm = id(), space = id(), navigation = id(), revision = id();
  const directory = mkdtempSync('.temp/zone-route-closure-');
  const manifest = `urn:rezics:sha256:${prepareComponent(directory, zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation, defaultRealm: realm,
    state: 'active', disclosure: 'public', budget: { timeMs: 500, rows: 20 }, queryBlocks: [],
    model: ZONE_PROFILE,
  } }, ZONE_PROFILE)}`;
  let policyReads = 0, proofs = 0;
  const rows = (values: Record<string, string>[]) => ({ results: { bindings: values.map(value =>
    Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal', value: text }]))) } });
  const work = { environment: { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: '1' },
    fuseki: { query: async (query: string) => {
      if (query.includes('SELECT ?sequence WHERE')) return rows([{ sequence: '7' }]);
      if (query.includes('SELECT ?space ?navigation')) return rows([{ space, navigation, head: revision,
        manifest, state: `${RV}Active`, disclosure: `${RV}Public`, spaceDisclosure: `${RV}Public`, realm,
        spaceProfile: 'https://rezics.com/definition/space-zone-v1' }]);
      if (query.includes('SELECT ?creation')) return rows([{ creation: revision }]);
      if (query.includes('SELECT ?manifest')) return rows([{ manifest }]);
      if (query.includes('SELECT ?spaceDisclosure')) return rows([{ spaceDisclosure: `${RV}Public` }]);
      if (query.includes('SELECT ?space ?realmRevision')) {
        policyReads++;
        if (input.fault) throw new Error('Realm storage fault');
        return rows(input.realm === 'closed' || input.changed && policyReads > 1 ? []
          : [{ space, disclosure: `${RV}${input.realm === 'private' ? 'Private' : 'Public'}` }]);
      }
      if (query.includes('ASK')) return { boolean: true };
      throw new Error(`Unexpected closure query: ${query}`);
    } } }, account: { verify: async () => ({ issuer: 'test', subject: 'reader' }) },
    access: { assertRecoveryOpen: async () => undefined, activePrincipalId: async () => 'reader',
      realmReadProof: async () => input.granted && (!input.revoked || ++proofs === 1) ? 'membership' : null },
  } as unknown as MainWorkDependencies;
  const request = new Request('http://main.local/v1/zones/test/routes');
  return { work, request, zone, realm, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('independent shell routes and presentation expose only the reader-admitted live Realm', async () => {
  for (const realm of ['public', 'private', 'closed'] as const) for (const granted of [false, true]) {
    const f = fixture({ realm, granted });
    try {
      for (const actingSubject of [undefined, `https://rezics.com/id/${randomUUID()}`]) {
        const expected = realm === 'public' || realm === 'private' && granted && actingSubject ? f.realm : null;
        expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/', actingSubject }))
          .toMatchObject({ kind: 'home', realm: expected });
        const state = await readZonePresentation(f.work, f.request, f.zone, actingSubject, async value => value);
        expect(state.realm).toBe(expected);
        expect(state.configuration.defaultRealm ?? null).toBe(expected);
      }
      expect((await readZonePublication(f.work.environment, f.zone)).realm).toBe(f.realm);
    } finally { f.close(); }
  }
});

test('a Realm closing during hydration rechecks the selected basis before returning the independent home', async () => {
  const f = fixture({ realm: 'public', changed: true });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/' }))
      .toMatchObject({ kind: 'home', realm: null });
  } finally { f.close(); }
});

test('Realm membership revocation refuses a read rather than disclosing an admitted identity', async () => {
  const f = fixture({ realm: 'private', granted: true, revoked: true });
  try {
    await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/',
      actingSubject: `https://rezics.com/id/${randomUUID()}` })).rejects.toBeInstanceOf(ZoneRouteMissing);
  } finally { f.close(); }
});

test('Realm infrastructure faults remain faults instead of hiding identity as absence', async () => {
  const f = fixture({ realm: 'public', fault: true });
  try {
    await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/' })).rejects.toThrow('Realm storage fault');
  } finally { f.close(); }
});
