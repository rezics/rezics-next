import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import type { SparqlResult } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { WorkReadMissing, WorkReadSession } from '../src/modules/work/read-session.ts';
import { ZONE_CONFIG_FORMAT, ZONE_PROFILE } from '../src/modules/zone/config-format.ts';
import { resolveZoneRoute, ZoneRouteMissing } from '../src/modules/zone/route.ts';
import { ZONE_VISIBILITY_COST } from '../src/modules/zone/route-visibility.ts';
import { readRealmZone } from '../src/modules/realm-reads/read-zone.ts';
import { RankingHomeTrendingReader } from '../src/modules/feed/trending.ts';
import type { ReadRankingProjection } from '../src/modules/rankings/projection.ts';
import { defaultPreferences } from '../src/modules/feed/personal.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const rows = (values: Record<string, string>[]): SparqlResult => ({ results: { bindings: values.map(value =>
  Object.fromEntries(Object.entries(value).map(([key, text]) => [key, { type: 'literal', value: text }]))) } });

function fixture(input: { spacePrivate: boolean; zonePrivate: boolean; member: boolean; grant: boolean;
  listing?: 'listed' | 'unlisted'; revoke?: 'member' | 'member-fence' | 'grant'; deniedWorkScope?: boolean }) {
  const zone = id(), space = id(), realm = id(), navigation = id(), head = id(), actor = id();
  const directory = resolve('.temp', `g-964-zone-${randomUUID()}`);
  const manifest = prepareComponent(directory, zone, { configuration: {
    format: ZONE_CONFIG_FORMAT, zone, space, navigation, state: 'active',
    disclosure: input.zonePrivate ? 'private' : 'public', defaultRealm: realm,
    budget: { timeMs: 500, rows: 20 }, queryBlocks: [], model: ZONE_PROFILE,
  } }, ZONE_PROFILE);
  const queries: string[] = [], grants: string[] = [];
  let proofs = 0;
  const work = { environment: { objectDirectory: directory, lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: { query: async (query: string) => {
      queries.push(query);
      if (query.includes('ASK')) return { boolean: true };
      if (query.includes('SELECT ?spaceDisclosure')) return rows([{ spaceDisclosure: RV + (input.spacePrivate ? 'Private' : 'Public') }]);
      if (query.includes('SELECT ?sequence WHERE')) return rows([{ sequence: '7' }]);
      if (query.includes('SELECT ?space ?navigation')) return rows([{ space, navigation, head,
        manifest: `urn:rezics:sha256:${manifest}`, state: RV + 'Active',
        disclosure: RV + (input.zonePrivate ? 'Private' : 'Public'),
        spaceDisclosure: RV + (input.spacePrivate ? 'Private' : 'Public'), realm,
        listing: input.listing ?? 'listed' }]);
      if (query.includes('?kind ?space ?realm ?disclosure')) return rows([{ kind: 'space', space, realm,
        disclosure: RV + (input.spacePrivate ? 'Private' : 'Public'),
        zoneDisclosure: RV + (input.zonePrivate ? 'Private' : 'Public'), listing: input.listing ?? 'listed' }]);
      if (query.includes('SELECT ?space ?realmRevision')) return rows([{ space, realmRevision: head,
        disclosure: RV + (input.spacePrivate ? 'Private' : 'Public'), listing: input.listing ?? 'listed' }]);
      if (query.includes('SELECT DISTINCT ?zone ?official')) return rows([{ zone }]);
      throw new Error(`Unexpected G-964 query: ${query}`);
    } } }, account: { verify: async (_request: Request, scopes: string[]) => {
      if (input.deniedWorkScope && scopes.includes('work:read')) throw new Error('Work read scope denied');
      return { issuer: 'test', subject: 'reader' };
    } },
    access: { realmReadProof: async () => {
      proofs++;
      return input.member && !(input.revoke === 'member' && proofs > 1
        || input.revoke === 'member-fence' && proofs > 2) ? 'episode-1' : null;
    },
      canReadSemanticResource: async (_principal: unknown, _actor: string, target: string) => {
        grants.push(target);
        return input.grant && !(input.revoke === 'grant' && grants.length > 1);
      } }, homePersonal: { read: async () => ({ revision: '1', preferences: defaultPreferences, exclusions: [] }) },
  } as unknown as MainWorkDependencies;
  const request = new Request('http://main.local/v1/zones/test/routes');
  const session = (authenticated: boolean) => {
    const value = new WorkReadSession(work, request, authenticated ? { actingSubject: actor } : {},
      { dataEpoch: 'epoch', sequence: '7' });
    value.principal = authenticated ? { issuer: 'test', subject: 'reader' } : null;
    return value;
  };
  return { work, request, zone, space, realm, actor, session, grants, queries,
    close: () => rmSync(directory, { recursive: true, force: true }) };
}

test('G-964: Zone routes require membership for a private Space and a separate grant for stored private Zone disclosure', async () => {
  for (const spacePrivate of [false, true]) for (const zonePrivate of [false, true])
    for (const member of [false, true]) for (const grant of [false, true]) {
      const f = fixture({ spacePrivate, zonePrivate, member, grant, listing: 'unlisted' });
      try {
        const readable = (!spacePrivate || member) && (!zonePrivate || grant);
        const reading = resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/', actingSubject: f.actor });
        if (readable) expect(await reading).toMatchObject({ kind: 'home', listing: 'unlisted',
          discovery: { indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' } });
        else await expect(reading).rejects.toBeInstanceOf(ZoneRouteMissing);
        expect(f.grants).not.toContain(f.space);
        if (spacePrivate || zonePrivate) await expect(resolveZoneRoute(f.work, f.request,
          { zone: f.zone, path: '/' })).rejects.toBeInstanceOf(ZoneRouteMissing);
      } finally { f.close(); }
    }
});

test('G-964: private-Space membership and Zone semantic authority admit the home without inventing private Work OAuth scope', async () => {
  const f = fixture({ spacePrivate: true, zonePrivate: true, member: true, grant: true, deniedWorkScope: true });
  try {
    expect(await resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/', actingSubject: f.actor }))
      .toMatchObject({ kind: 'home', discovery: { indexable: false } });
    expect(f.queries.length).toBeLessThanOrEqual(16);
    expect(ZONE_VISIBILITY_COST).toMatchObject({ graphReads: 2, rows: 2, realmPolicyReads: 1, accessPointReads: 2 });
  } finally { f.close(); }
});

test('G-964: membership and Zone-grant revocation during route hydration fails closed without a graph write', async () => {
  for (const revoke of ['member', 'member-fence', 'grant'] as const) {
    const f = fixture({ spacePrivate: revoke !== 'grant', zonePrivate: revoke === 'grant', member: true, grant: true, revoke });
    try { await expect(resolveZoneRoute(f.work, f.request, { zone: f.zone, path: '/', actingSubject: f.actor }))
      .rejects.toBeInstanceOf(ZoneRouteMissing); }
    finally { f.close(); }
  }
});

test('G-964: Realm-to-Zone reads apply both admissions instead of interpreting private Realm visibility as a Zone grant', async () => {
  for (const zonePrivate of [false, true]) for (const grant of [false, true]) {
    const f = fixture({ spacePrivate: true, zonePrivate, member: true, grant });
    try {
      const reading = readRealmZone(f.session(true), f.realm);
      if (!zonePrivate || grant) expect(await reading).toMatchObject({ zone: f.zone, discovery: { indexable: false } });
      else await expect(reading).rejects.toBeInstanceOf(WorkReadMissing);
    } finally { f.close(); }
  }
});

test('G-964: Zone-scoped trending retains private-Space membership through its ranking session and fences Zone grants', async () => {
  const projection = { current: async () => ({ generation: '1', contentSequence: '7', reviewPosition: '1', contentEpoch: 'epoch' }),
    candidates: async () => [] } as unknown as ReadRankingProjection;
  for (const member of [false, true]) for (const grant of [false, true]) {
    const f = fixture({ spacePrivate: true, zonePrivate: true, member, grant });
    try {
      const session = f.session(true);
      const reading = new RankingHomeTrendingReader(projection).read(session,
        { query: { scope: `zone:${f.zone}` }, principal: session.principal, agent: f.actor });
      if (member && grant) expect(await reading).toMatchObject({ profile: 'home-trending-v1', items: [] });
      else await expect(reading).rejects.toBeInstanceOf(WorkReadMissing);
    } finally { f.close(); }
  }
  const revoked = fixture({ spacePrivate: false, zonePrivate: true, member: false, grant: true, revoke: 'grant' });
  try {
    const session = revoked.session(true);
    await expect(new RankingHomeTrendingReader(projection).read(session,
      { query: { scope: `zone:${revoked.zone}` }, principal: session.principal, agent: revoked.actor }))
      .rejects.toBeInstanceOf(WorkReadMissing);
  } finally { revoked.close(); }
});
