import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { GRAPHS, RV, iri, lit } from '../src/modules/work/activate.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../src/modules/rating/global.ts';
import { authorCreditTriples } from '../src/modules/work/author-credit.ts';
import { AccessJudgments } from '../src/modules/judgment/access.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; total: null; kind: string } }
interface Rating { scope: { kind: string }; scale: { max: number }; count: number; mean: number | null;
  distribution: { value: number; count: number }[] }

test('Work reads: native public/private/erased disclosure, fallback, scoped ratings and cursor pages', async () => {
  const stack = await startMediaStack('work-read');
  try {
    const a = await stack.member('reader-a');
    const b = await stack.member('reader-b');
    const first = await stack.publicWork(a.actor, ['en', 'ja'], 'Read template first');
    const second = await stack.publicWork(a.actor, ['en'], 'Read template second');
    const restricted = await stack.privateWork(a.actor, 'Private title must stay private');
    await a.grant(`work:read:${restricted.work}`, 'work.read');
    const unreviewed = await stack.privateWork(a.actor, 'Unselected publication');
    await stack.contribution(unreviewed.work, a.actor, 'en', 'Published but never selected');
    const root = `/v1/works/${short(first.work)}`;
    const get = (path: string) => stack.call('GET', path);
    const before = stack.fuseki.queries;
    const header = await json<{ id: string; revision: string; title: { value: string; language: string; basis: string };
      originalTitle: null; mainVersion: string; selectedLanguage: string }>(await get(`${root}?language=fr`));
    expect(header).toMatchObject({ id: first.work, mainVersion: first.mainVersion,
      title: { value: first.title, language: 'en', basis: 'fallback' }, originalTitle: null, selectedLanguage: 'en' });
    expect(stack.fuseki.queries - before).toBe(5);
    expect((await get(`/v1/works/${short(restricted.work)}`)).status).toBe(404);
    expect((await get(`/v1/works/${short(unreviewed.work)}`)).status).toBe(404);
    expect((await get(`/v1/works/${randomUUID()}`)).status).toBe(404);
    expect((await b.read(`/v1/works/${short(restricted.work)}`)).status).toBe(404);
    expect(await json(await a.read(`/v1/works/${short(restricted.work)}`)))
      .toMatchObject({ disclosure: 'restricted', title: { value: restricted.title } });
    expect((await get(`${root}?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(401);

    const discover = await json<Page<{ id: string }>>(await get('/v1/works?limit=1'));
    expect(discover.items.map(item => item.id)).toEqual([second.work]);
    expect(discover.count).toEqual({ value: 1, kind: 'exact-page', total: null });
    expect(discover.nextCursor).toBeString();
    const next = await json<Page<{ id: string }>>(await get(`/v1/works?limit=1&cursor=${discover.nextCursor}`));
    expect(next.items.map(item => item.id)).toEqual([first.work]);
    expect(next.nextCursor).toBeNull();
    expect((await get(`/v1/works?language=ja&cursor=${discover.nextCursor}`)).status).toBe(400);
    expect((await get('/v1/works?limit=21')).status).toBe(400);
    expect((await get('/v1/works?cursor=invalid')).status).toBe(400);

    const versions = await json<Page<{ id: string; language: string }>>(await get(`${root}/versions?limit=1`));
    const more = await json<Page<{ id: string }>>(await get(`${root}/versions?limit=1&cursor=${versions.nextCursor}`));
    expect(new Set([...versions.items, ...more.items].map(item => item.id)).size).toBe(2);
    expect(more.nextCursor).toBeNull();
    expect((await json<Page<{ language: string }>>(await get(`${root}/versions?contentLanguage=ja`))).items)
      .toMatchObject([{ language: 'ja' }]);
    expect((await get(`/v1/works/${short(second.work)}/versions?cursor=${versions.nextCursor}`)).status).toBe(400);
    expect((await json<Page<{ kind: string }>>(await get(`${root}/history`))).items.map(item => item.kind))
      .toEqual(['publication-decision', 'publication-decision', 'metadata-revision']);
    expect((await json<Page<unknown>>(await get(`${root}/credits`))).items).toEqual([]);
    expect((await json<Page<unknown>>(await get(`${root}/adoptions`))).items).toEqual([]);
    expect((await json<Page<unknown>>(await get(`${root}/classifications`))).items).toEqual([]);

    await a.grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string; space: string }>(await a.send('POST', '/v1/spaces',
      { profile: 'space-realm-v1', name: 'Read ratings Realm', capabilities: ['realm'], actingSubject: a.actor }), 201);
    await a.grant(`publication:adopt:${realm.realm}`, 'publication.adopt');
    await json(await a.send('POST', '/v1/publication-selections', { profile: 'realm-local-selection-v1',
      context: { kind: 'realm-local', id: realm.realm }, work: first.work, mainVersion: first.mainVersion,
      contribution: first.variants[0]!.contribution, publicationDecision: first.variants[0]!.decision,
      expectedSelectionHead: null, selectionBasis: 'realm-manager-review', actingSubject: a.actor }), 201);
    expect((await json<Page<{ realm: string }>>(await get(`${root}/adoptions`))).items)
      .toMatchObject([{ realm: realm.realm, name: { value: 'Read ratings Realm' } }]);
    await a.grant('classification:define:global', 'classification.proposition.define');
    await a.grant('classification:decide:global', 'classification.decision.set');
    await a.grant(`classification:context:${realm.realm}`, 'classification.context.configure');
    await a.grant(`classification:decide:${realm.realm}`, 'classification.decision.set');
    await json(await a.send('POST', '/v1/classification-contexts', { profile: 'classification-context-v1',
      realm: realm.realm, actingSubject: a.actor }), 201);
    const proposition = await json<{ sense: string; concept: string }>(await a.send('POST', '/v1/classification-propositions',
      { profile: 'classification-proposition-v1', label: 'Adventure', actingSubject: a.actor }), 201);
    const decision = { profile: 'classification-direct-decision-v1', work: first.work,
      mainVersion: first.mainVersion, sense: proposition.sense, expectedDecisionHead: null, actingSubject: a.actor };
    await json(await a.send('POST', '/v1/classification-decisions',
      { ...decision, context: { kind: 'global' }, outcome: 'accepted' }), 201);
    expect((await json<Page<unknown>>(await get(`${root}/classifications`))).items)
      .toMatchObject([{ sense: proposition.sense, concept: proposition.concept,
        name: { value: 'Adventure' }, source: 'global', relevance: null }]);
    expect((await json<Page<unknown>>(await get(`${root}/classifications?scope=realm&realm=${encodeURIComponent(realm.realm)}`))).items.length).toBe(1);
    await json(await a.send('POST', '/v1/classification-decisions',
      { ...decision, context: { kind: 'realm-classification', id: realm.realm }, outcome: 'rejected' }), 201);
    expect((await json<Page<unknown>>(await get(`${root}/classifications?scope=realm&realm=${encodeURIComponent(realm.realm)}`))).items).toEqual([]);
    const credit = `https://rezics.com/id/${randomUUID()}`;
    const creditTriples = authorCreditTriples({ work: first.work, credit, revision: `https://rezics.com/id/${randomUUID()}`,
      expectedHead: header.revision, sourceKey: '/authors/OL1A', sourceRoleKey: null, nativeOrdinal: 0,
      actingSubject: a.actor }, stack.env.lineage.dataEpoch, '0');
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${creditTriples.current} }
      GRAPH ${iri(GRAPHS.revisions)} { ${creditTriples.revision} } }`);
    expect((await json<Page<unknown>>(await get(`${root}/credits`))).items)
      .toMatchObject([{ id: credit, key: '/authors/OL1A', agent: null, handle: null }]);
    await a.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    await a.grant(GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const global = await json<{ context: string }>(await a.send('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'Global quality', actingSubject: a.actor }), 201);
    const local = await json<{ context: string }>(await a.send('POST', '/v1/rating-contexts',
      { profile: 'realm-standing-rating-context-v1', realm: realm.realm, question: 'Realm quality', actingSubject: a.actor }), 201);
    for (const member of [a, b]) {
      await member.grant(`rating:observe:${global.context}`, 'rating.observation.set');
      await member.grant(`rating:observe:${local.context}`, 'rating.observation.set');
      await json(await member.send('POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context: global.context,
        work: first.work, mainVersion: first.mainVersion, expectedRevisionHead: null,
        value: member === a ? 5 : 1, actingSubject: member.actor }), 201);
      await json(await member.send('POST', '/v1/rating-observations', {
        profile: 'realm-standing-rating-observation-v1', context: local.context,
        work: first.work, mainVersion: first.mainVersion, expectedRevisionHead: null,
        value: member === a ? 8 : 6, actingSubject: member.actor }), 201);
    }
    const globalRating = await json<Rating>(await get(`${root}/ratings`));
    expect((await json<Page<unknown>>(await get(`${root}/rating-contexts`))).items)
      .toMatchObject([{ context: global.context, question: 'Global quality', scale: { max: 5 } }]);
    expect(globalRating).toMatchObject({ scope: { kind: 'global' }, scale: { max: 5 }, count: 2, mean: 3 });
    expect(globalRating.distribution).toEqual([1, 0, 0, 0, 1].map((count, i) => ({ value: i + 1, count })));
    expect(await json(await get(`${root}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}`)))
      .toMatchObject({ scope: { kind: 'realm', realm: realm.realm }, scale: { max: 10 }, count: 2, mean: 7 });
    expect(await json(await a.read(`${root}/ratings?scope=mine`)))
      .toMatchObject({ scope: { kind: 'mine' }, scale: { max: 5 }, count: 1, mean: 5 });
    expect(await json(await b.read(`${root}/ratings?scope=mine`))).toMatchObject({ count: 1, mean: 1 });
    expect((await get(`${root}/ratings?scope=mine`)).status).toBe(401);
    expect((await get(`${root}/ratings?scope=realm`)).status).toBe(400);
    expect((await get(`${root}/ratings?context=${encodeURIComponent(local.context)}`)).status).toBe(404);

    // The same read must keep working after the legacy decision writer is retired.
    await a.grant('statement:migrate:root', 'statement.migrate');
    await a.grant('statement:migrate:root', 'statement.cutover');
    const pending = await json<{ pending: { application: string; decision: string }[] }>(
      await a.read('/v1/statement-migrations/v1/pending'));
    for (const item of pending.pending) await json(await a.send('POST',
      `/v1/statement-migrations/v1/${short(item.application)}`, { profile: 'statement-migration-v1',
        expectedDecision: item.decision, actingSubject: a.actor }), 201);
    await json(await a.send('POST', '/v1/statement-migrations/v1/cutover',
      { profile: 'statement-cutover-v1', actingSubject: a.actor }), 201);
    const protectedApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      judgments: new AccessJudgments(stack.accessPool), account: { verify: async () => a.principal } });
    const protectedRead = (path: string) => protectedApp.handle(new Request(`http://main.local${path}`));
    expect((await json<Page<unknown>>(await protectedRead(`${root}/classifications`))).items).toEqual([]);
    await a.grant('classification:decide:global', 'statement.decide');
    const hint = (value: string, expectedGeneration: string) => protectedApp.handle(new Request(
      `http://main.local/v1/concepts/${short(proposition.concept)}/spoiler-hints`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}`, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ profile: 'concept-spoiler-hint-v1', context: { kind: 'global' }, hint: value,
          expectedGeneration, actingSubject: a.actor }) }));
    await json(await hint('not-spoiler', '0'), 201);
    expect((await json<Page<unknown>>(await protectedRead(`${root}/classifications`))).items)
      .toMatchObject([{ sense: proposition.sense, concept: proposition.concept, source: 'global' }]);
    expect((await json<Page<unknown>>(await protectedRead(`${root}/classifications?scope=realm&realm=${encodeURIComponent(realm.realm)}`))).items).toEqual([]);
    await json(await hint('major', '1'), 201);
    expect((await json<Page<unknown>>(await protectedRead(`${root}/classifications`))).items).toEqual([]);

    // Real SQL revocation during graph hydration must be observed by the final admission.
    let revoked = false;
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    const graph = new Proxy(stack.fuseki, { get(target, property) {
      if (property === 'query') return async (sparql: string, maxBytes?: number) => {
        const result = await originalQuery(sparql, maxBytes);
        if (!revoked && sparql.includes('SELECT ?epoch ?sequence ?hold ?r')) {
          revoked = true;
          await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
            WHERE scope_id = $1 AND recipient_subject = $2`, [`work:read:${restricted.work}`, a.actor]);
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const racing = createMainApp(graph, { environment: { ...stack.env, fuseki: graph },
      access: stack.access, account: { verify: async () => a.principal } });
    expect((await racing.handle(new Request(`http://main.local/v1/works/${short(restricted.work)}?actingSubject=${encodeURIComponent(a.actor)}`,
      { headers: { authorization: `Bearer ${a.token}` } }))).status).toBe(404);
    expect(revoked).toBe(true);

    // Damage/privacy probes use only the disposable raw-update QA graph.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Public } } INSERT { GRAPH ${iri(GRAPHS.current)} {
      ${iri(realm.space)} rv:disclosure rv:Private } } WHERE {}`);
    expect((await get(`${root}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}`)).status).toBe(404);
    expect((await get(`${root}/classifications?scope=realm&realm=${encodeURIComponent(realm.realm)}`)).status).toBe(404);
    expect((await json<Page<unknown>>(await get(`${root}/adoptions`))).items).toEqual([]);
    const erasedVariant = `urn:rezics:variant:${randomUUID()}`;
    const erasedPin = `urn:rezics:content-publication:${'a'.repeat(64)}`;
    const erasedRevision = `urn:rezics:content:revision:${randomUUID()}`;
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(erasedVariant)} rv:resource ${iri(first.work)} ; rv:contentPublicationHead ${iri(erasedPin)} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(erasedPin)} rv:contentRevision ${iri(erasedRevision)} .
        ${iri(erasedRevision)} a rv:ErasedRevision } }`);
    for (const suffix of ['', '/versions', '/history', '/ratings', '/classifications', '/adoptions', '/credits']) {
      expect((await get(`${root}${suffix}`)).status).toBe(404);
    }
    const remaining = await json<Page<{ id: string }>>(await get('/v1/works'));
    expect(remaining.items.map(item => item.id)).toEqual([second.work]);
    // A fresh metadata edit changes the graph position, invalidating an old cursor.
    await stack.privateWork(a.actor, 'Unrelated corpus growth');
    expect((await get(`/v1/works?cursor=${discover.nextCursor}`)).status).toBe(409);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get('/v1/works')).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:restoreHold true } }`);
    expect((await get('/v1/works')).status).toBe(200);
    const oldEpoch = stack.env.lineage.dataEpoch;
    const newEpoch = randomUUID();
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE { GRAPH ${iri(GRAPHS.control)} {
      <urn:rezics:dataset:product> rv:dataEpoch ?epoch ; rv:sequence ?sequence } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:dataEpoch ${lit(newEpoch)} ; rv:sequence 0 .
        <urn:rezics:restore:read-test> a rv:RestoreCutover ; rv:dataEpoch ${lit(newEpoch)} ; rv:priorDataEpoch ${lit(oldEpoch)} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { <urn:rezics:dataset:product> rv:dataEpoch ?epoch ; rv:sequence ?sequence } }`);
    stack.env.lineage.dataEpoch = newEpoch;
    expect((await json<Page<{ id: string }>>(await get('/v1/works'))).items.map(item => item.id)).toEqual([second.work]);
  } finally { await stack.stop(); }
}, 120_000);
