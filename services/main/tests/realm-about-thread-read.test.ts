import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { Value } from 'typebox/value';
import { configureDisclosure, type DisclosureDecision } from '../src/modules/disclosure/read.ts';
import { configureFixtureDisclosureAncestry, fixtureDisclosureReader } from './support/disclosure-ancestry.ts';
import { RealmReplyThreadStore } from '../src/modules/realm-reply/thread-store.ts';
import { readRealmAboutThread } from '../src/modules/realm-reply/thread-read.ts';
import { realmAboutThread, REALM_ABOUT_THREAD_COST } from '../src/modules/realm-reply/thread-contract.ts';
import { GRAPHS, RV } from '../src/modules/work/activate.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import { realmReplyThreadRoutes, openApiOperations } from '../src/routes/realm-reply-threads.ts';
import { workReadError } from '../src/routes/work-reads.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { createRateLimitResolver } from '../src/modules/rate-limit/routes.ts';

const ref = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const realm = ref(1), about = ref(2), opener = ref(3), author = ref(4), root = ref(5), currentRoot = ref(6);
const revision = '00000000-0000-4000-a000-000000000001';
const review = '00000000-0000-4000-b000-000000000001';
const bind = (value: string) => ({ value });
const emptyKey = { realm: null, about: null, opener_reply: null, root_revision: null, revision_id: null, state: null };

interface Scenario {
  key?: 'absent' | 'reserved';
  hiddenThread?: boolean; unplaced?: boolean; approved?: boolean; approvalMoved?: boolean;
  hiddenResource?: boolean; absentResource?: boolean; targetMoved?: 'hidden' | 'revision';
  privateRealm?: boolean; absentRealm?: boolean; hiddenRealm?: boolean; admitted?: boolean;
  historyHidden?: boolean; historyMoved?: boolean; rootErased?: boolean;
  unavailable?: 'canonical' | 'approval' | 'graph' | 'disclosure';
  malformed?: 'canonical-count' | 'canonical-state' | 'placement-count' | 'placement-field'
    | 'placement-root' | 'placement-parent' | 'identity-count' | 'identity-parent' | 'identity-root' | 'disclosure-count';
  unrelated?: number;
}

/** Storage doubles retain the real owner SQL, resolver, disclosure adapter and
 * route envelope. Count every returned storage row as well as every request. */
function fixture(s: Scenario = {}) {
  const calls = { sql: 0, sqlRows: 0, graph: 0, graphRows: 0, placement: 0, approval: 0,
    canonical: 0, disclosure: 0, writes: 0, bodies: 0 };
  let targetReads = 0, floors = 0;
  const key = { realm, about, opener_reply: opener, root_revision: root,
    revision_id: s.key === 'reserved' ? null : revision, state: s.key === 'reserved' ? 'reserved' : 'active' };
  const identity = { reply: opener, parent: s.malformed === 'identity-parent' ? ref(30) : null, author,
    origin: realm, root_target: about, root_revision: s.malformed === 'identity-root' ? currentRoot : root,
    created_at: new Date('2026-10-10') };
  const inventory = new Map(Array.from({ length: s.unrelated ?? 0 }, (_, n) => [ref(1000 + n), key]));
  inventory.set(about, key);
  const content = { query: async (sql: string, params: unknown[]) => {
    calls.sql++;
    if (!/^\s*SELECT\b/.test(sql)) { calls.writes++; throw new Error('lookup attempted a write'); }
    let rows: unknown[];
    if (sql.includes('content.realm_about_thread t')) {
      calls.canonical++;
      if (s.unavailable === 'canonical') throw new Error('Content connection lost');
      expect(sql).toContain('t.realm = $1 AND t.about = $2 LIMIT 2');
      expect(params).toEqual([realm, about]);
      rows = [s.key === 'absent' ? emptyKey : inventory.get(String(params[1]))!];
      if (s.malformed === 'canonical-count') rows.push(key);
      if (s.malformed === 'canonical-state') rows = [{ ...key, state: 'active', revision_id: null }];
    } else if (sql.includes('AS x(reply,revision,review,preparation)')) {
      calls.approval++;
      if (s.unavailable === 'approval') throw new Error('Content connection lost');
      expect(sql).toContain("d.outcome = 'approved'");
      expect(sql).toContain('publication.pin_active');
      expect(sql).toContain('later.supersedes = d.id');
      const approved = params[1] === opener && s.approved !== false && !(s.approvalMoved && calls.approval === 2);
      rows = [{ ...identity, reply: params[1] === null ? null : opener, approved }];
      if (s.malformed === 'identity-count') rows.push(rows[0]);
    } else throw new Error(`unexpected SQL: ${sql}`);
    calls.sqlRows += rows.length;
    return { rows };
  } } as unknown as Pool;
  const deps = {
    access: {
      activePrincipalId: async () => 'reader',
      assertRecoveryOpen: async () => {},
      realmReadProof: async () => s.admitted ? 'member:1' : null,
      realmHistoryFloor: async () => {
        floors++;
        return { dataEpoch: 'epoch', sequence: s.historyHidden || s.historyMoved && floors > 1 ? '100' : '0' };
      },
    },
    content: { readExactBatch: async () => { calls.bodies++; throw new Error('lookup hydrated bodies'); } },
    realmReplyThreads: new RealmReplyThreadStore(content, {} as Pool),
    environment: { objectDirectory: '.temp/about-thread-unit', lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      fuseki: { query: async (sql: string) => {
        calls.graph++;
        if (s.unavailable === 'graph') throw new Error('graph lost');
        let rows: Record<string, { value: string; 'xml:lang'?: string }>[];
        if (sql.includes('SELECT ?space ?realmRevision ?disclosure')) {
          rows = s.absentRealm ? [] : [{ space: bind(ref(7)), realmRevision: bind(ref(8)),
            disclosure: bind(`${RV}${s.privateRealm ? 'Private' : 'Public'}`),
            visibility: bind(s.privateRealm ? 'private' : 'public'), mode: bind('open'),
            history: bind(s.privateRealm ? 'from-admission' : 'everything') }];
        } else if (sql.includes('SELECT ?id ?reply ?slotRealm')) {
          calls.placement++;
          expect(sql).toContain('VALUES ?slot');
          expect(sql).toContain('OPTIONAL');
          expect(sql).toContain('LIMIT 2');
          const hidden = s.unplaced || s.key === 'absent' || s.key === 'reserved';
          rows = hidden ? [{}] : [{ id: bind(ref(9)), reply: bind(opener), work: bind(about),
            slotRealm: bind(realm), slotWork: bind(about), slotReply: bind(opener),
            eligible: bind(s.rootErased || s.historyHidden && sql.includes('FILTER EXISTS') ? 'false' : 'true'),
            author: bind(author), revision: bind(`urn:rezics:content:revision:${revision}`),
            review: bind(`urn:rezics:realm-review:${review}`), preparation: bind('prep-1'),
            rootRevision: bind(s.malformed === 'placement-root' ? currentRoot : root), sequence: bind('10'),
            ...(s.malformed === 'placement-parent' ? { parent: bind(ref(30)) } : {}) }];
          if (s.malformed === 'placement-count') rows.push(rows[0]!);
          if (s.malformed === 'placement-field') delete rows[0]!.review;
        } else if (sql.includes('SELECT ?resource ?head WHERE')) {
          rows = [...sql.matchAll(/VALUES \?resource \{([^}]+)\}/g)].flatMap(match =>
            [...match[1]!.matchAll(/<([^>]+)>/g)].map(iri => ({ resource: bind(iri[1]!), head: bind(currentRoot) })));
        } else if (sql.includes('SELECT ?work ?head ?owningWork ?owningHead')) {
          rows = [about, realm].filter(id => sql.includes(`<${id}>`)).map(id => ({ work: bind(id), head: bind(currentRoot) }));
        } else if (sql.includes('AS ?hasCurrentIdentity')) {
          targetReads++;
          rows = s.absentResource ? [{ epoch: bind('epoch'), sequence: bind('9'), r: bind(about),
            hasCurrentIdentity: bind('false') }] : [{ epoch: bind('epoch'), sequence: bind('9'), r: bind(about),
            hasCurrentIdentity: bind('true'), type: bind('work'), work: bind(about), head: bind(currentRoot),
            public: bind('true'), erased: bind('false'), label: { value: 'A page', 'xml:lang': 'en' } }];
        } else if (sql.includes('SELECT ?epoch ?sequence ?r ?revision')) {
          rows = [{ epoch: bind('epoch'), sequence: bind('9'), r: bind(about),
            revision: bind(s.targetMoved === 'revision' && targetReads > 1 ? ref(20) : currentRoot),
            type: bind('https://schema.org/CreativeWork') }];
        } else if (sql.includes('rv:RestoreCutover')) rows = [];
        else if (sql.includes(`GRAPH <${GRAPHS.control}>`)) rows = [{ epoch: bind('epoch'), sequence: bind('9') }];
        else throw new Error(`unexpected graph query: ${sql}`);
        calls.graphRows += rows.length;
        return { results: { bindings: rows } };
      } },
    },
  } as unknown as MainWorkDependencies;
  configureDisclosure(deps.environment, fixtureDisclosureReader(async (targets, _viewer, channel) => {
    calls.disclosure++;
    if (s.unavailable === 'disclosure') throw new Error('disclosure owner lost');
    const result: DisclosureDecision[] = targets.map(target =>
      target.resource === realm && s.hiddenRealm
        || target.resource === about && (s.hiddenResource || s.targetMoved === 'hidden' && targetReads > 1)
        || target.owner === 'content' && s.hiddenThread ? 'hidden' : 'visible');
    if (s.malformed === 'disclosure-count' && channel === 'thread') result.pop();
    return result;
  }));
  configureFixtureDisclosureAncestry(deps.environment, target => target.work ? { resource: target.work, head: currentRoot,
    ...(target.workRevision !== undefined ? { protectedRevision: target.workRevision } : {}) } : undefined);
  const request = new Request(`http://main.test/v1/realms/${realm.slice(-36)}/about-thread?about=${encodeURIComponent(about)}`);
  const session = new WorkReadSession(deps, request, s.admitted ? { actingSubject: author } : {},
    { dataEpoch: 'epoch', sequence: '9' });
  if (s.admitted) session.principal = { issuer: 'account', subject: 'reader', emailVerified: true } as NonNullable<typeof session.principal>;
  return { deps, calls, session, request, read: () => readRealmAboutThread(session, realm, about) };
}

async function outcome(f: ReturnType<typeof fixture>) {
  try { return { status: 200, body: await f.read() }; }
  catch (error) { const response = workReadError(error); return { status: response.status, body: await response.json() }; }
}

test('empty lookup is singular, does not reserve anything or hydrate bodies, and has fixed bounded probes', async () => {
  const f = fixture({ key: 'absent' });
  const result = await f.read();
  expect(result).toEqual({ realm, about, thread: null });
  expect(Value.Check(realmAboutThread, result)).toBe(true);
  expect(f.calls).toMatchObject({ writes: 0, bodies: 0, canonical: 1, placement: 1, approval: 2, sqlRows: 3 });
});

test('visible canonical opener retains its original root after page edits', async () => {
  const f = fixture();
  const result = await f.read();
  expect(result).toEqual({ realm, about, thread: { reply: opener, rootRevision: root } });
  expect(Value.Check(realmAboutThread, result)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(REALM_ABOUT_THREAD_COST.responseBytes);
});

for (const hidden of [{ hiddenThread: true }, { approved: false }, { unplaced: true }, { rootErased: true }, { key: 'reserved' as const }]) {
  test(`hidden thread equals absent body and all read counters: ${JSON.stringify(hidden)}`, async () => {
    const hiddenFixture = fixture(hidden), absent = fixture({ key: 'absent' });
    expect(await outcome(hiddenFixture)).toEqual(await outcome(absent));
    expect(hiddenFixture.calls).toEqual(absent.calls);
  });
}

test('hidden resource equals absent 404 without disclosing the canonical opener', async () => {
  const hidden = fixture({ hiddenResource: true }), absent = fixture({ absentResource: true });
  const hiddenResult = await outcome(hidden), absentResult = await outcome(absent);
  expect(hiddenResult.status).toBe(404);
  expect(hiddenResult).toEqual(absentResult);
});

// Class B known limits: resource denial uses 6 graph reads versus 8 for an absent
// resource; authenticated Realm denial also lacks read-count equality. Their 404
// bodies match. Do not pad the hidden path to manufacture cost equality.
test('hidden and absent Realm share 404; authenticated Realm cost equality remains the recorded owner limit', async () => {
  expect(await outcome(fixture({ privateRealm: true }))).toEqual(await outcome(fixture({ absentRealm: true })));
  expect((await outcome(fixture({ hiddenRealm: true }))).status).toBe(404);
});

test('closing approval and target disclosure suppress stale results', async () => {
  expect((await fixture({ approvalMoved: true }).read()).thread).toBeNull();
  expect((await outcome(fixture({ targetMoved: 'hidden' }))).status).toBe(404);
  expect((await outcome(fixture({ targetMoved: 'revision' }))).status).toBe(409);
});

test('private history applies to the opener origin, and a moving floor refuses the lookup', async () => {
  expect((await fixture({ privateRealm: true, admitted: true, historyHidden: true }).read()).thread).toBeNull();
  expect((await outcome(fixture({ privateRealm: true, admitted: true, historyMoved: true }))).status).toBe(409);
});

test('unrelated inventories cannot increase graph or SQL rows read', async () => {
  const small = fixture(), large = fixture({ unrelated: 10_000 });
  expect(await large.read()).toEqual(await small.read());
  expect(large.calls).toEqual(small.calls);
});

for (const malformed of ['canonical-count', 'canonical-state', 'placement-count', 'placement-field', 'placement-root',
  'placement-parent', 'identity-count', 'identity-parent', 'identity-root', 'disclosure-count'] as const) {
  test(`malformed owner cardinality or identity fails closed: ${malformed}`, async () => {
    expect((await outcome(fixture({ malformed }))).status).toBe(503);
  });
}

for (const unavailable of ['canonical', 'approval', 'graph', 'disclosure'] as const) {
  test(`unavailable ${unavailable} owner is never an empty successful lookup`, async () => {
    const f = fixture({ unavailable });
    const response = await realmReplyThreadRoutes(f.deps).handle(f.request);
    expect(response.status).toBe(503);
  });
}

test('public route uses the same uncharged read declaration and serves a singular no-store response', async () => {
  expect(openApiOperations['/v1/realms/{realm}/about-thread'].get).toEqual({ rateLimitFamily: 'read', exposure: 'public', bearer: false });
  expect(createRateLimitResolver([openApiOperations])('GET', `/v1/realms/${realm.slice(-36)}/about-thread`)).toBeNull();
  const f = fixture();
  const response = await realmReplyThreadRoutes(f.deps).handle(f.request);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({ realm, about, thread: { reply: opener, rootRevision: root } });
  expect(f.calls.writes).toBe(0);
});
