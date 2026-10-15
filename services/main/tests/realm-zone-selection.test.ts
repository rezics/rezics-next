import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { configureDisclosure, DisclosureStore } from '../src/modules/disclosure/read.ts';
import { ANONYMOUS_VIEWER } from '../src/modules/suitability/policy.ts';
import { readRealmZone } from '../src/modules/realm-reads/read-zone.ts';
import { DEFAULT_ZONE_PRESENTATION } from '../src/modules/zone/presentation-format.ts';
import { RV, type WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../src/modules/work/read-session.ts';
import { REALM_ATTACHMENT_CAP } from '../src/modules/zone/config-format.ts';
import { ZoneUnavailable } from '../src/modules/zone/configuration.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';

const native = (number: number) => `https://rezics.com/id/00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const realm = native(1), revision = native(3), realmSpace = native(4);
const first = native(10), second = native(11);
const zoneSpace = (zone: string) => native(1000 + Number.parseInt(zone.slice(-12), 16));
const term = (value: string) => ({ type: 'uri', value });
const candidate = (zone: string, official = false) => ({ zone: term(zone), zoneSpace: term(zoneSpace(zone)),
  ...(official ? { official: term('true') } : {}) });
const publication = (zone: string, patch: object = {}) => ({ zone, realm, space: zoneSpace(zone), revision,
  official: null, disclosure: 'public', storedDisclosure: 'public', listing: 'listed', discovery: 'listed',
  presentation: DEFAULT_ZONE_PRESENTATION, ...patch });

class RealmDisclosure extends DisclosureStore {
  closed = false;
  constructor() { super({} as Pool); }
  override async read() { return [this.closed ? 'hidden' as const : 'visible' as const]; }
}

function owner(rows = [candidate(first), candidate(second)], signedIn = true) {
  const disclosure = new RealmDisclosure();
  const queries: { body: string; limit: number }[] = [];
  const visibility: string[] = [];
  let access = new Set([first, second]);
  const environment = { lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    fuseki: { query: async (body: string) => {
      if (body.includes('ASK')) return { boolean: true };
      const zone = [first, second].find(id => body.includes(`<${id}>`))!;
      visibility.push(zone);
      return { results: { bindings: [{ target: term(zone), kind: term('space'), space: term(zoneSpace(zone)),
        disclosure: term(`${RV}Private`), zoneDisclosure: term(`${RV}Private`) }] } };
    } },
  } as unknown as WorkActivationEnvironment;
  configureFixtureDisclosureAncestry(environment, () => undefined);
  configureDisclosure(environment, fixtureDisclosureReader(async () => disclosure.read()));
  const session = { options: signedIn ? { actingSubject: native(20) } : {},
    principal: signedIn ? {} : null, viewer: ANONYMOUS_VIEWER,
    position: { dataEpoch: 'epoch', sequence: '8' },
    deps: { environment, access: { canReadSemanticResource: async (_principal: unknown, _actor: string, zone: string) => access.has(zone) } },
    realm: async () => ({ space: realmSpace, realmRevision: revision, visibility: 'public', reviewMode: 'open', revision: null }),
    observeDependency: () => '',
    query: async (body: string, limit: number) => { queries.push({ body, limit }); return rows; },
  } as unknown as WorkReadSession;
  return { session, queries, visibility, disclosure, revoke: () => { access = new Set(); } };
}

test('owner selects the first published ordinary Zone from legal multiple attachments', async () => {
  const fixture = owner();
  const read = async (_env: WorkActivationEnvironment, zone: string) => publication(zone) as never;
  expect(await readRealmZone(fixture.session, realm, read)).toMatchObject({
    zone: first, realm, revision, presentation: DEFAULT_ZONE_PRESENTATION,
    sourcePosition: fixture.session.position });
});

test('an eligible official Zone precedes an earlier ordinary IRI without changing inventory order', async () => {
  const fixture = owner([candidate(first), candidate(second, true)]);
  const hydrated: string[] = [];
  expect((await readRealmZone(fixture.session, realm, async (_env, zone) => {
    hydrated.push(zone);
    return publication(zone, { official: zone === second ? 'fiction' : null }) as never;
  })).zone).toBe(second);
  expect(hydrated).toEqual([second]);
  expect(fixture.queries[0]!.body).toContain('ORDER BY STR(?zone)');
});

for (const signedIn of [false, true]) {
  test(`${signedIn ? 'signed-in' : 'anonymous'} reader skips an invisible first ordinary or official candidate`, async () => {
    for (const official of [false, true]) {
      const fixture = owner([candidate(first, official), candidate(second)], signedIn);
      fixture.revoke();
      const selected = await readRealmZone(fixture.session, realm, async (_env, zone) => publication(zone,
        zone === first ? { disclosure: 'private', official: official ? 'fiction' : null } : {}) as never);
      expect(selected.zone).toBe(second);
      expect(JSON.stringify(selected)).not.toContain(first);
    }
  });

  test(`${signedIn ? 'signed-in' : 'anonymous'} reader skips null and different published Realms before a valid candidate`, async () => {
    const third = native(12), fixture = owner([candidate(first), candidate(second), candidate(third)], signedIn);
    const selected = await readRealmZone(fixture.session, realm, async (_env, zone) => publication(zone,
      { realm: zone === first ? null : zone === second ? native(99) : realm }) as never);
    expect(selected.zone).toBe(third);
  });

  test(`${signedIn ? 'signed-in' : 'anonymous'} reader gets existing absence when no candidate is eligible`, async () => {
    for (const rows of [[], [candidate(first)], [candidate(first), candidate(second)]]) {
      const fixture = owner(rows, signedIn);
      await expect(readRealmZone(fixture.session, realm, async (_env, zone) => publication(zone,
        { realm: zone === first ? null : native(99) }) as never)).rejects.toBeInstanceOf(WorkReadMissing);
    }
    const hidden = owner(undefined, signedIn);
    hidden.revoke();
    await expect(readRealmZone(hidden.session, realm, async (_env, zone) => publication(zone,
      { disclosure: 'private' }) as never)).rejects.toBeInstanceOf(WorkReadMissing);
  });
}

test('private access changes which eligible selection a signed-in reader receives', async () => {
  const fixture = owner();
  const read = async (_env: WorkActivationEnvironment, zone: string) => publication(zone,
    zone === first ? { disclosure: 'private' } : {}) as never;
  expect((await readRealmZone(fixture.session, realm, read)).zone).toBe(first);
  fixture.revoke();
  expect((await readRealmZone(fixture.session, realm, read)).zone).toBe(second);
});

test('private access lost at the final live basis prevents delivery of the selected Zone', async () => {
  const fixture = owner();
  const basis = fixture.session.realm.bind(fixture.session);
  let probes = 0;
  fixture.session.realm = async target => {
    const value = await basis(target);
    if (++probes === 2) fixture.revoke();
    return value;
  };
  await expect(readRealmZone(fixture.session, realm, async (_env, zone) => publication(zone,
    zone === first ? { disclosure: 'private' } : {}) as never)).rejects.toBeInstanceOf(WorkReadMissing);
});

test('Realm closure during publication hydration still refuses the selected entry', async () => {
  const fixture = owner();
  await expect(readRealmZone(fixture.session, realm, async (_env, zone) => {
    fixture.disclosure.closed = true;
    return publication(zone) as never;
  })).rejects.toBeInstanceOf(WorkReadMissing);
});

test('the last eligible attachment remains reachable within the command cap, without enumerating all Zones', async () => {
  const zones = Array.from({ length: REALM_ATTACHMENT_CAP }, (_, index) => native(100 + index));
  const fixture = owner(zones.map(zone => candidate(zone)));
  const hydrated: string[] = [];
  expect((await readRealmZone(fixture.session, realm, async (_env, zone) => {
    hydrated.push(zone);
    return publication(zone, { realm: zone === zones.at(-1) ? realm : null }) as never;
  })).zone).toBe(zones.at(-1)!);
  expect(hydrated).toEqual(zones);
  expect(fixture.queries).toHaveLength(1);
  expect(fixture.queries[0]!.limit).toBe(REALM_ATTACHMENT_CAP + 2);
  expect(fixture.queries[0]!.body).toContain(`rv:defaultRealm <${realm}>`);
  expect(fixture.queries[0]!.body).toContain(`LIMIT ${REALM_ATTACHMENT_CAP + 2}`);
});

test('the Realm same-Space Zone remains selectable alongside the full cross-Space attachment cap', async () => {
  const ownZone = native(200), ownRow = { ...candidate(ownZone, true), zoneSpace: term(realmSpace) };
  const fixture = owner([...Array.from({ length: REALM_ATTACHMENT_CAP }, (_, index) => candidate(native(100 + index))), ownRow]);
  expect((await readRealmZone(fixture.session, realm, async (_env, zone) => publication(zone,
    zone === ownZone ? { space: realmSpace, official: 'fiction' } : {}) as never)).zone).toBe(ownZone);
});

test('attachment corruption and publication identity inconsistencies remain faults', async () => {
  for (const rows of [[candidate(first), candidate(first, true)], [{ zone: term(first) }] as never,
    [first, second].map(zone => ({ ...candidate(zone), zoneSpace: term(realmSpace) })),
    Array.from({ length: REALM_ATTACHMENT_CAP + 1 }, (_, index) => candidate(native(100 + index)))]) {
    await expect(readRealmZone(owner(rows).session, realm,
      async (_env, zone) => publication(zone) as never)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
  for (const patch of [{ zone: second }, { space: second }, { official: 'fiction' }]) {
    await expect(readRealmZone(owner().session, realm,
      async (_env, zone) => publication(zone, patch) as never)).rejects.toBeInstanceOf(WorkReadUnavailable);
  }
});

test('publication unavailability and infrastructure failures are not converted to another selection or absence', async () => {
  const fixture = owner();
  await expect(readRealmZone(fixture.session, realm, async () => {
    throw new ZoneUnavailable('Published bundle is corrupt');
  })).rejects.toBeInstanceOf(WorkReadUnavailable);
  const failure = new Error('Graph disconnected');
  await expect(readRealmZone(fixture.session, realm, async () => { throw failure; })).rejects.toBe(failure);
});
