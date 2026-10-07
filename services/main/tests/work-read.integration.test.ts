import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { Static } from 'typebox';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { authorCreditFixture, author } from '../../../tests/qa/fixtures/author-credit.ts';
import { createMainApp } from '../src/app.ts';
import { GRAPHS, RV, iri, lit } from '../src/modules/work/activate.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../src/modules/rating/global.ts';
import { authorCreditTriples } from '../src/modules/work/author-credit.ts';
import { AccessJudgments } from '../src/modules/judgment/access.ts';
import { DiscoveryProjection } from '../src/modules/discovery/store.ts';
import { AccessExposure } from '../src/modules/access/exposure.ts';
import { MANAGE_ACTION, MANAGE_SCOPE } from '../src/modules/recommendation/derived-generation.ts';
import { mainSelectionDigest, selectMainDefault } from '../src/modules/work/select-main.ts';
import type { TemplateQueryEnvelope } from '../src/infrastructure/fuseki.ts';
import { template as creditsTemplate } from '../src/modules/query/templates/work-credits.schema.ts';

const short = (id: string) => id.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; total: null; kind: string } }
interface Rating { scope: { kind: string }; scale: { max: number }; count: number; mean: number | null;
  distribution: { value: number; count: number }[] }

test('WORKCREDITS01: native GET and POST credits retain empty, source-only and exhausted source tails with source and rights fences', async () => {
  const stack = await startMediaStack('work-credits');
  const directory = join(resolve('.temp'), `work-credits-source-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  let source: Awaited<ReturnType<typeof authorCreditFixture>> | undefined;
  type Credit = Static<typeof creditsTemplate.response>['items'][number];
  interface Credits extends Page<Credit> {
    profile: 'template-result-v1'; query: string; revision: number; complete: boolean;
    sourcePosition: { dataEpoch: string; sequence: string; dependencyToken: string };
  }
  try {
    const writer = await stack.member('credits-reader');
    const empty = await stack.publicWork(writer.actor, ['en'], 'Empty credits integration');
    const emptyRoot = `/v1/works/${short(empty.work)}`;
    const emptyResponse = await stack.call('GET', `${emptyRoot}/credits`);
    expect(emptyResponse.headers.get('cache-control')).toBe('private, no-store');
    const emptyGet = await json<Credits>(emptyResponse);
    expect(Value.Check(creditsTemplate.response, emptyGet)).toBe(true);
    const emptyPost = await json<{ result: Credits }>(await stack.call('POST', '/v1/query', {
      body: { profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
        parameters: { roots: [empty.work] }, limit: 20 },
    }));
    expect(emptyGet).toEqual(emptyPost.result);
    expect(emptyGet).toMatchObject({ profile: 'template-result-v1', revision: 1,
      query: 'https://rezics.com/query/work-credits', items: [], complete: true,
      nextCursor: null, count: { value: 0, kind: 'exact-page', total: null } });
    const emptyHeader = await json<{ links: { credits: string } }>(await stack.call('GET', emptyRoot));
    expect(emptyHeader.links.credits).toBe(`${emptyRoot}/credits`);

    // Reuse the source owner's acquisition/conversion/adoption fixture, retaining real SQL tuples.
    source = await authorCreditFixture(Bun.env as Record<string, string>, directory);
    const base = Number(String(Date.now()).slice(-9));
    const keys = [0, 1, 2].map(offset => `/authors/OL${base + offset}A`);
    const proposal = await source.propose(`OL${base}W`, keys.map(key => author(key)), 'Source credits integration');
    const adopted = await source.adoptWork(proposal);
    const body = await stack.contribution(adopted.work, writer.actor, 'en', `Credits body ${randomUUID()}`);
    const selection = { context: { kind: 'main-version-default' as const, id: adopted.mainVersion },
      work: adopted.work, contribution: body.contribution, publicationDecision: body.decision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: writer.actor };
    expect((await selectMainDefault(stack.env, stack.admission(writer.actor,
      `publication:select:${adopted.mainVersion}`, 'publication.select', mainSelectionDigest(selection)), selection)).outcome)
      .toBe('succeeded');
    const sourceReferences = (await source.adoptions.authorReferences([adopted.work])).get(adopted.work)!;
    expect(sourceReferences.map(ref => ref.key)).toEqual(keys);
    const dependencies = { environment: stack.env, access: stack.access, templateSeek: stack.templateSeek,
      sourceAdoptions: source.adoptions, sourceAuthorNames: source.sourceAuthorNames,
      account: { verify: async () => writer.principal } };
    const app = createMainApp(stack.fuseki, dependencies);
    const root = `/v1/works/${short(adopted.work)}/credits`;
    const request = async (method: 'GET' | 'POST', limit = 20, cursor?: string, etag?: string) => {
      const headers = { ...(etag ? { 'if-none-match': etag } : {}) };
      return method === 'GET'
        ? await app.handle(new Request(`http://main.local${root}?${new URLSearchParams({ limit: String(limit),
          ...(cursor ? { cursor } : {}) })}`, { headers }))
        : await app.handle(new Request('http://main.local/v1/query', { method, headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ profile: 'template-query-v1', query: 'https://rezics.com/query/work-credits', revision: 1,
            parameters: { roots: [adopted.work] }, limit, cursor }) }));
    };
    const read = async (method: 'GET' | 'POST', limit = 20, cursor?: string) => {
      const response = await request(method, limit, cursor);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const result = method === 'GET' ? await json<Credits>(response) : (await json<{ result: Credits }>(response)).result;
      expect(Value.Check(creditsTemplate.response, result)).toBe(true);
      return result;
    };
    const sourceOnly = await read('GET');
    expect(sourceOnly).toEqual(await read('POST'));
    expect(sourceOnly.items).toEqual(sourceReferences.map(ref => ({ ...ref, role: 'author',
      participantKind: 'external-reference', provider: 'open-library', agent: null, handle: null,
      displayName: null, confirmation: 'source-reported' })));
    expect(sourceOnly.items.map(item => [item.id, item.key, item.ordinal, item.confirmation])).toEqual(
      sourceReferences.map(ref => [ref.id, ref.key, ref.ordinal, 'source-reported']));
    expect(sourceOnly).toMatchObject({ complete: true, nextCursor: null,
      count: { value: 3, kind: 'exact-page', total: null } });
    const sourceTag = (await request('GET')).headers.get('etag')!;
    expect(sourceTag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    for (const method of ['GET', 'POST'] as const) {
      const unchanged = await request(method, 20, undefined, sourceTag);
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get('etag')).toBe(sourceTag);
      expect(unchanged.headers.get('cache-control')).toBe('private, no-store');
      expect(await unchanged.text()).toBe('');
    }

    const credit = `https://rezics.com/id/${randomUUID()}`;
    const triples = authorCreditTriples({ work: adopted.work, credit, revision: `https://rezics.com/id/${randomUUID()}`,
      expectedHead: adopted.workRevision, sourceKey: keys[0]!, sourceRoleKey: null, nativeOrdinal: 0,
      actingSubject: writer.actor }, stack.env.lineage.dataEpoch, '0');
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${triples.current} } GRAPH ${iri(GRAPHS.revisions)} { ${triples.revision} } }`);
    // Raw QA writes require the same disposable seek backfill used by the original integration case.
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const expectedIds = [credit, sourceReferences[1]!.id, sourceReferences[2]!.id];
    const complete = await read('GET');
    expect(complete).toEqual(await read('POST'));
    expect(complete.items.map(item => item.id)).toEqual(expectedIds);
    expect(complete.items.map(item => item.key)).toEqual(keys);
    expect(complete.items[0]).toEqual({ id: credit, key: keys[0], ordinal: 0, role: 'author',
      participantKind: 'external-reference', provider: 'open-library', agent: null, handle: null, displayName: null });
    expect(complete.items[0]!.confirmation).toBeUndefined();
    expect(complete).toMatchObject({ complete: true, nextCursor: null,
      count: { value: 3, kind: 'exact-page', total: null } });
    const first = await read('GET', 1);
    const second = await read('POST', 1, first.nextCursor!);
    const last = await read('GET', 1, second.nextCursor!);
    expect([first.items[0]!.id, second.items[0]!.id, last.items[0]!.id]).toEqual(expectedIds);
    expect(first.complete).toBe(false); expect(second.complete).toBe(false);
    expect(last.complete).toBe(true); expect(last.nextCursor).toBeNull();

    // Withdraw retained support during actual native hydration; the continuation must refuse mixed source tuples.
    const support = await source.adoptions.readSupport(source.principalId, adopted.work);
    expect(support).not.toBeNull();
    let withdrawn = false;
    const nativeTemplate = stack.fuseki.templateQuery.bind(stack.fuseki);
    const sourceOwner = source;
    const sourceRaceGraph = new Proxy(stack.fuseki, { get(target, property) {
      if (property === 'templateQuery') return async (envelope: TemplateQueryEnvelope) => {
        const result = await nativeTemplate(envelope);
        if (!withdrawn) {
          withdrawn = true;
          const outcome = await sourceOwner.adoptions.withdrawSupport(sourceOwner.principalId, adopted.work,
            randomUUID(), { binding: support!.binding, expectedSupport: support!.supportIdentity,
              reason: 'Integration source fence' });
          expect(outcome?.withdrawal.state).toBe('withdrawn');
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const sourceRaceApp = createMainApp(sourceRaceGraph, { ...dependencies,
      environment: { ...stack.env, fuseki: sourceRaceGraph } });
    const sourceRace = await sourceRaceApp.handle(new Request(`http://main.local${root}?${new URLSearchParams({
      limit: '1', cursor: first.nextCursor! })}`));
    expect(sourceRace.status).toBe(409);
    expect((await sourceRace.json() as { code: string }).code).toBe('read_basis_changed');
    expect(withdrawn).toBe(true);

    const privateWork = await stack.privateWork(writer.actor, 'Private credits integration');
    await writer.grant(`work:read:${privateWork.work}`, 'work.read');
    const privateRoot = `/v1/works/${short(privateWork.work)}`;
    expect((await stack.call('GET', `${privateRoot}/credits`)).status).toBe(404);
    const privateHeader = await json<{ revision: string }>(await writer.read(privateRoot));
    const privateTriples = authorCreditTriples({ work: privateWork.work, credit: `https://rezics.com/id/${randomUUID()}`,
      revision: `https://rezics.com/id/${randomUUID()}`, expectedHead: privateHeader.revision,
      sourceKey: keys[0]!, sourceRoleKey: null, nativeOrdinal: 0, actingSubject: writer.actor }, stack.env.lineage.dataEpoch, '0');
    await stack.fuseki.update(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${privateTriples.current} } GRAPH ${iri(GRAPHS.revisions)} { ${privateTriples.revision} } }`);
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch, true);
    const authorized = await writer.read(`${privateRoot}/credits`);
    expect(authorized.status).toBe(200);
    const tag = authorized.headers.get('etag')!;
    expect(tag).toMatch(/^W\/"[a-f0-9]{64}"$/);
    let revoked = false;
    const rightsRaceGraph = new Proxy(stack.fuseki, { get(target, property) {
      if (property === 'templateQuery') return async (envelope: TemplateQueryEnvelope) => {
        const result = await nativeTemplate(envelope);
        if (!revoked) {
          revoked = true;
          await stack.accessPool.query(`UPDATE access.permission_grant SET active = false
            WHERE scope_id = $1 AND recipient_subject = $2`, [`work:read:${privateWork.work}`, writer.actor]);
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const rightsRaceApp = createMainApp(rightsRaceGraph, { environment: { ...stack.env, fuseki: rightsRaceGraph },
      access: stack.access, templateSeek: stack.templateSeek, account: { verify: async () => writer.principal } });
    const denied = await rightsRaceApp.handle(new Request(`http://main.local${privateRoot}/credits?actingSubject=${encodeURIComponent(writer.actor)}`,
      { headers: { authorization: `Bearer ${writer.token}`, 'if-none-match': tag } }));
    expect(denied.status).toBe(404);
    expect((await denied.json() as { code: string }).code).toBe('work_unavailable');
    expect(revoked).toBe(true);
  } finally {
    try { await source?.close(); } finally { await stack.stop(); rmSync(directory, { recursive: true, force: true }); }
  }
}, 120_000);

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
    // Discovery now consumes an explicitly built projection. Keep this template
    // exercising the integrated route; discovery's owner tests qualify its index.
    await a.grant(MANAGE_SCOPE, MANAGE_ACTION);
    const platformAccess = new AccessExposure(stack.accessPool);
    platformAccess.require = async (principal, exposure) => {
      expect(principal).toEqual(a.principal);
      expect(exposure).toBe('platform:platform-admin');
    };
    const discoveryApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      templateSeek:stack.templateSeek,
      discovery: new DiscoveryProjection(stack.accessPool), judgments: new AccessJudgments(stack.accessPool),
      platformAccess,
      account: { verify: async () => a.principal } });
    const get = async (path: string) => {
      const url=new URL(path,'http://main.local');
      const view=/^\/v1\/works\/([^/]+)\/(versions|adoptions)$/.exec(url.pathname);
      if(view) {
        const parameters={roots:[`https://rezics.com/id/${view[1]}`],
          ...(view[2]==='versions'?{contentLanguage:url.searchParams.get('contentLanguage') ?? undefined,kind:url.searchParams.get('kind') ?? undefined}:{})};
        const response=await stack.call('POST','/v1/query',{body:{profile:'template-query-v1',
          query:`https://rezics.com/query/work-${view[2]}`,revision:1,parameters,
          presentation:{language:url.searchParams.get('language') ?? undefined},
          limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined,
          cursor:url.searchParams.get('cursor') ?? undefined}});
        if(!response.ok) return response;
        return Response.json((await response.json() as {result:unknown}).result,{headers:response.headers});
      }
      return path === '/v1/works' || path.startsWith('/v1/works?')
        ? discoveryApp.handle(new Request(`http://main.local${path}`)) : stack.call('GET', path);
    };
    let discoveryHead: string | null = null;
    const refreshDiscovery = async () => {
      const post = (path: string, body: object) => discoveryApp.handle(new Request(`http://main.local${path}`, {
        method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json',
          'idempotency-key': randomUUID() }, body: JSON.stringify(body) }));
      let row = await json<{ generation: string; checkpoint: string; complete: boolean }>(await post(
        '/v1/discovery/generation-builds', { profile: 'discovery-generation-build-v1', actingSubject: a.actor,
          basis: { scope: 'global', realm: null, context: null } }));
      for (let step = 0; !row.complete && step < 10; step++) row = await json(await post(
        `/v1/discovery/generations/${row.generation}/advance`, { actingSubject: a.actor, expectedCheckpoint: row.checkpoint }));
      expect(row.complete).toBe(true);
      const active = await json<{ headRevision: string }>(await post('/v1/discovery/generation-activations', {
        profile: 'discovery-generation-activation-v1', actingSubject: a.actor, generation: row.generation,
        expectedHeadRevision: discoveryHead }));
      discoveryHead = active.headRevision;
    };
    const before = stack.fuseki.queries;
    const header = await json<{ id: string; revision: string; title: { value: string; language: string; basis: string };
      originalTitle: null; mainVersion: string; selectedLanguage: string | null;
      links: { credits: string } }>(await get(`${root}?language=fr`));
    expect(header).toMatchObject({ id: first.work, mainVersion: first.mainVersion,
      title: { value: first.title, language: 'en', basis: 'fallback' }, originalTitle: null, selectedLanguage: null });
    expect(header.links.credits).toBe(`${root}/credits`);
    expect(stack.fuseki.queries - before).toBe(9);
    expect((await get(`/v1/works/${short(restricted.work)}`)).status).toBe(404);
    expect((await get(`/v1/works/${short(unreviewed.work)}`)).status).toBe(404);
    expect((await get(`/v1/works/${randomUUID()}`)).status).toBe(404);
    expect((await b.read(`/v1/works/${short(restricted.work)}`)).status).toBe(404);
    expect(await json(await a.read(`/v1/works/${short(restricted.work)}`)))
      .toMatchObject({ disclosure: 'restricted', title: { value: restricted.title } });
    expect((await get(`${root}?actingSubject=${encodeURIComponent(a.actor)}`)).status).toBe(401);

    // Independently maintained Works retain their own semantic types and never fold into a Book.
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> INSERT DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} schema:isPartOf ${iri(second.work)} ;
        a schema:DigitalDocument, schema:Book . } }`);
    const chapterBefore = stack.fuseki.queries;
    expect(await json(await get(root))).toMatchObject({
      types: ['https://schema.org/Book', 'https://schema.org/DigitalDocument'] });
    expect(stack.fuseki.queries - chapterBefore).toBe(9);
    await stack.fuseki.update(`PREFIX schema: <https://schema.org/> DELETE DATA {
      GRAPH ${iri(GRAPHS.current)} { ${iri(first.work)} schema:isPartOf ${iri(second.work)} ;
        a schema:DigitalDocument, schema:Book . } }`);

    await refreshDiscovery();
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
    await refreshDiscovery();
    const conceptFeed=await json<{result:Page<{id:string;concept:string}>}>(await discoveryApp.handle(
      new Request('http://main.local/v1/query',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({profile:'template-query-v1',query:'https://rezics.com/query/followed-concept-feed',revision:1,
          parameters:{roots:[proposition.concept]}})})));
    expect(conceptFeed.result.items).toMatchObject([{id:first.work,concept:proposition.concept,name:{value:first.title}}]);
    expect(conceptFeed.result.nextCursor).toBeNull();
    await json(await a.send('POST','/v1/classification-decisions',{
      ...decision,work:second.work,mainVersion:second.mainVersion,context:{kind:'global'},outcome:'accepted'}),201);
    await refreshDiscovery();
    const feedPage=async(cursor?:string)=>json<{result:Page<{id:string}>}>(await discoveryApp.handle(
      new Request('http://main.local/v1/query',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({profile:'template-query-v1',query:'https://rezics.com/query/followed-concept-feed',revision:1,
          parameters:{roots:[proposition.concept]},limit:1,cursor})})));
    const newest=await feedPage();
    expect(newest.result.items.map(item=>item.id)).toEqual([second.work]);
    expect(newest.result.nextCursor).toBeString();
    const older=await feedPage(newest.result.nextCursor!);
    expect(older.result.items.map(item=>item.id)).toEqual([first.work]);
    expect(older.result.nextCursor).toBeNull();
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
    // Raw QA writes bypass the command's native projection delta. Rebuild this
    // disposable directory explicitly; production writes use receipt deltas.
    await stack.templateSeek.backfill(stack.env.lineage.dataEpoch,true);
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
    const ratingRoot = `/v1/resources/${short(first.work)}`;
    const globalRating = await json<Rating>(await get(`${ratingRoot}/ratings`));
    expect((await json<Page<unknown>>(await get(`${ratingRoot}/rating-contexts`))).items)
      .toMatchObject([{ context: global.context, question: 'Global quality', scale: { max: 5 } }]);
    expect(globalRating).toMatchObject({ scope: { kind: 'global' }, scale: { max: 5 }, count: 2, mean: 3 });
    expect(globalRating.distribution).toEqual([1, 0, 0, 0, 1].map((count, i) => ({ value: i + 1, count })));
    expect(await json(await get(`${ratingRoot}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}`)))
      .toMatchObject({ scope: { kind: 'realm', realm: realm.realm }, scale: { max: 10 }, count: 2, mean: 7 });
    expect(await json(await a.read(`${ratingRoot}/ratings?scope=mine`)))
      .toMatchObject({ scope: { kind: 'mine' }, scale: { max: 5 }, count: 1, mean: 5 });
    expect(await json(await b.read(`${ratingRoot}/ratings?scope=mine`))).toMatchObject({ count: 1, mean: 1 });
    expect((await get(`${ratingRoot}/ratings?scope=mine`)).status).toBe(401);
    expect((await get(`${ratingRoot}/ratings?scope=realm`)).status).toBe(400);
    expect((await get(`${ratingRoot}/ratings?context=${encodeURIComponent(local.context)}`)).status).toBe(404);

    // The same read must keep working after the legacy decision writer is retired.
    await a.grant('statement:migrate:root', 'statement.migrate');
    await a.grant('statement:migrate:root', 'statement.cutover');
    const protectedApp = createMainApp(stack.fuseki, { environment: stack.env, access: stack.access,
      platformAccess, judgments: new AccessJudgments(stack.accessPool), account: { verify: async () => a.principal } });
    const migrate = (method: string, path: string, body?: object) => protectedApp.handle(new Request(
      `http://main.local${path}`, { method, headers: { authorization: `Bearer ${a.token}`,
        'content-type': 'application/json', 'idempotency-key': randomUUID() },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const pending = await json<{ pending: { application: string; decision: string }[] }>(
      await migrate('GET', '/v1/statement-migrations/v1/pending'));
    for (const item of pending.pending) await json(await migrate('POST',
      `/v1/statement-migrations/v1/${short(item.application)}`, { profile: 'statement-migration-v1',
        expectedDecision: item.decision, actingSubject: a.actor }), 201);
    await json(await migrate('POST', '/v1/statement-migrations/v1/cutover',
      { profile: 'statement-cutover-v1', actingSubject: a.actor }), 201);
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
    expect((await get(`${ratingRoot}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}`)).status).toBe(404);
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
    await refreshDiscovery();
    const remaining = await json<Page<{ id: string }>>(await get('/v1/works'));
    expect(remaining.items.map(item => item.id)).toEqual([second.work]);
    // Unrelated writes preserve retained discovery order; live erasure still filters cards.
    await stack.privateWork(a.actor, 'Unrelated corpus growth');
    expect((await get(`/v1/works?cursor=${discover.nextCursor}`)).status).toBe(200);
    await refreshDiscovery();
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
    await refreshDiscovery();
    expect((await json<Page<{ id: string }>>(await get('/v1/works'))).items.map(item => item.id)).toEqual([second.work]);
  } finally { await stack.stop(); }
}, 120_000);
