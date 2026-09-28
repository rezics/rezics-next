import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { startMediaStack } from '../../../tests/qa/integration/media-support.ts';
import { createMainApp } from '../src/app.ts';
import { AgentProvisioning } from '../src/modules/agent/provision.ts';
import { createAgentGraph, compensateAgentGraph } from '../src/modules/agent/graph.ts';
import { ProfilesAccess } from '../src/modules/profiles/access.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { DATASET, GRAPHS, RV, iri } from '../src/modules/work/activate.ts';
import { activateTextContribution, textContributionDigest } from '../src/modules/contribution/draft.ts';
import { GLOBAL_CONTEXT_SCOPE } from '../src/modules/rating/global.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch } from '../src/modules/outbox/relay.ts';

const id = () => `https://rezics.com/id/${randomUUID()}`;
const short = (value: string) => value.slice(-36);
async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}
interface Page<T> { items: T[]; nextCursor: string | null; count: { value: number; kind: string; total: null } }

test('G238: native Agent profiles, credits and library enforce disclosure, authority, pagination and restore fences', async () => {
  const stack = await startMediaStack('profiles');
  try {
    let loseNativeResponse = false;
    const command = stack.fuseki.commandWithReceipt.bind(stack.fuseki);
    stack.fuseki.commandWithReceipt = async envelope => {
      const result = await command(envelope);
      if (result.status === 'invalid') console.error('Native profile validation:', JSON.stringify(result));
      if (loseNativeResponse && result.status === 'committed' && envelope.update.includes('a rv:NativeAgentCredit')) {
        loseNativeResponse = false;
        throw new Error('Simulated lost response after native commit');
      }
      return result;
    };
    const a = await stack.member('private-account-a');
    const b = await stack.member('private-account-b');
    const principals = new Map<string, { issuer: string; subject: string }>([[a.token, a.principal], [b.token, b.principal]]);
    const account = { verify: async (request: Request, scopes: readonly string[]) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal || (request.headers.has('x-without-rating-scope') && scopes.includes('rating:read'))) {
        throw new AccountAssertionDenied('QA bearer or scope unavailable');
      }
      return principal;
    } };
    const structureObjects = stack.objects('profiles/structure/');
    await structureObjects.initialize();
    const deps = { environment: stack.env, access: stack.access, account, media: stack.media,
      structureObjects,
      profiles: new ProfilesAccess(stack.accessPool), agentProvisioning: new AgentProvisioning(stack.accessPool, stack.env) };
    const app = createMainApp(stack.fuseki, deps);
    const call = (method: string, path: string, body?: unknown, token?: string, key = randomUUID(), headers = {}) => app.handle(
      new Request(`http://main.local${path}`, { method, headers: { ...headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) }));
    const provision = async (name: string, kind = 'person', token = a.token) => json<{ agent: string }>(
      await call('POST', '/v1/agents', { profile: 'agent-provision-v1', displayName: name, kind }, token), 201);
    const person = await provision('Public pen name');
    const org = await provision('Public organization', 'organization');
    const service = await provision('Public service', 'service');
    const other = await provision('Other person', 'person', b.token);
    const root = `/v1/agents/${short(person.agent)}`;
    const before = stack.fuseki.queries;
    const headerResponse = await call('GET', root);
    expect(headerResponse.headers.get('cache-control')).toContain('no-store');
    const header = await json<{ id: string; displayName: string; kind: string; handle: string }>(headerResponse);
    expect(stack.fuseki.queries - before).toBe(3);
    expect(header).toMatchObject({ id: person.agent, kind: 'person', displayName: 'Public pen name' });
    expect(header.handle).toBe(`agent-${short(person.agent)}`);
    const serialized = JSON.stringify(header);
    for (const secret of [a.principalId, a.principal.subject, a.principal.issuer, b.principalId]) expect(serialized).not.toContain(secret);
    expect(await json(await call('GET', `/v1/handles/${header.handle}`))).toMatchObject({ id: person.agent });
    expect(await json(await call('GET', `/v1/agents/${short(org.agent)}`))).toMatchObject({ kind: 'organization' });
    expect(await json(await call('GET', `/v1/agents/${short(service.agent)}`))).toMatchObject({ kind: 'service' });
    expect((await call('GET', `/v1/agents/${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/v1/handles/not-allocated')).status).toBe(404);
    // Existing provision-v1 Agents were already explicitly public. The same
    // immutable handle allocation works without a data rewrite on a GET.
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(service.agent)} rv:profileHandle ?handle } }; DELETE WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(service.agent)} rv:profileDisclosure ?disclosure } }`);
    expect(await json(await call('GET', `/v1/handles/agent-${short(service.agent)}`))).toMatchObject({ id: service.agent });

    const grant = async (actor: string, principalId: string, scope: string, action: string) => {
      await stack.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await stack.accessPool.query(`INSERT INTO access.representation(id, principal_id, subject_id, action, valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, actor, action]);
      await stack.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), actor, scope, action]);
    };
    const read = (path: string, actor = person.agent, token = a.token) => call('GET',
      `${path}${path.includes('?') ? '&' : '?'}actingSubject=${encodeURIComponent(actor)}`, undefined, token);
    const first = await stack.publicWork(person.agent, ['en'], 'First credited Work');
    const second = await stack.publicWork(person.agent, ['en'], 'Second credited Work');
    const hidden = await stack.privateWork(person.agent, 'Private Work');
    const workHead = async (work: string) => {
      const rows = await stack.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head WHERE {
        GRAPH ${iri(GRAPHS.current)} { ${iri(work)} rv:head ?head } }`);
      return rows.results!.bindings[0]!.head!.value;
    };
    const credit = async (work: string, role = 'author', token = a.token, actor = person.agent) => {
      const body = { profile: 'native-agent-credit-v1', credit: id(), agent: person.agent,
        role, expectedWorkHead: await workHead(work), actingSubject: actor };
      return { body, response: await call('POST', `/v1/works/${short(work)}/agent-credits`, body, token) };
    };
    for (const work of [first.work, second.work, hidden.work]) await grant(person.agent, a.principalId, `work:edit:${work}`, 'work.edit');
    expect((await credit(first.work, 'author', b.token, other.agent)).response.status).toBe(403);
    loseNativeResponse = true;
    const saved = await credit(first.work);
    await json(saved.response, 201);
    expect(loseNativeResponse).toBe(false);
    const replayBody = { ...saved.body, credit: id(), role: 'translator' };
    const creditPath = `/v1/works/${short(first.work)}/agent-credits`;
    const replayKey = randomUUID();
    const initial = await json<{ credit: string; revision: string; sourcePosition: { dataEpoch: string; sequence: string } }>(
      await call('POST', creditPath, replayBody, a.token, replayKey), 201);
    const batch = await readNextMainOutboxBatch(stack.fuseki, initial.sourcePosition.dataEpoch,
      String(BigInt(initial.sourcePosition.sequence) - 1n));
    expect(batch?.eventIds).toHaveLength(1);
    expect(await readMainOutboxEnvelope(stack.fuseki, batch!, batch!.eventIds[0]!)).toMatchObject({
      type: 'com.rezics.agent.credit-created.v1', data: { receipt: { credit: initial.credit, agent: person.agent, role: 'translator' } } });
    expect(await json(await call('POST', creditPath, replayBody, a.token, replayKey))).toMatchObject({ ...initial, replayed: true });
    expect((await call('POST', creditPath, { ...replayBody, role: 'editor' }, a.token, replayKey)).status).toBe(409);
    await json((await credit(second.work)).response, 201);
    await json((await credit(hidden.work)).response, 201);
    const racing = await Promise.all([credit(first.work, 'editor'), credit(first.work, 'editor')]);
    expect(racing.map(item => item.response.status).sort()).toEqual([201, 409]);
    const stale = { ...saved.body, credit: id(), expectedWorkHead: id() };
    expect((await call('POST', creditPath, stale, a.token)).status).toBe(409);
    const nativeCredits = await json<Page<{ agent: string; role: string }>>(await call('GET', creditPath));
    expect(nativeCredits.items).toHaveLength(3);
    expect(nativeCredits.items.every(item => item.agent === person.agent)).toBe(true);
    const workReadsBefore = stack.fuseki.queries;
    const works = await json<Page<{ id: string }>>(await call('GET', `${root}/works?limit=1`));
    expect(stack.fuseki.queries - workReadsBefore).toBeLessThanOrEqual(12);
    expect(works.items).toHaveLength(1);
    expect(works.nextCursor).toBeString();
    const more = await json<Page<{ id: string }>>(await call('GET', `${root}/works?limit=1&cursor=${works.nextCursor}`));
    expect(new Set([...works.items, ...more.items].map(item => item.id))).toEqual(new Set([first.work, second.work]));
    expect(more.nextCursor).toBeNull();
    expect(works.count).toEqual({ kind: 'exact-page', value: 1, total: null });
    expect((await call('GET', `${root}/collections?cursor=${works.nextCursor}`)).status).toBe(400);
    expect((await call('GET', `${root}/works?limit=21`)).status).toBe(400);

    for (const disclosure of ['private', 'public', 'public']) {
      const collection = id();
      await grant(person.agent, a.principalId, `collection:edit:${collection}`, 'collection.edit');
      await json(await call('POST', '/v1/collections', { collection, name: `${disclosure} shelf`, disclosure,
        actingSubject: person.agent }, a.token), 201);
    }
    const collectionReadsBefore = stack.fuseki.queries;
    const shelves = await json<Page<{ name: string }>>(await call('GET', `${root}/collections?limit=1`));
    expect(stack.fuseki.queries - collectionReadsBefore).toBe(5);
    expect(shelves.items).toMatchObject([{ name: 'public shelf' }]);
    expect(shelves.nextCursor).toBeString();
    const shelfNext = await json<Page<{ name: string }>>(await call('GET', `${root}/collections?limit=1&cursor=${shelves.nextCursor}`));
    expect(shelfNext.items).toMatchObject([{ name: 'public shelf' }]);
    expect(shelfNext.nextCursor).toBeNull();
    // An unrelated graph command invalidates all earlier continuation tokens.
    expect((await call('GET', `${root}/works?cursor=${works.nextCursor}`)).status).toBe(409);

    for (const contribution of [first.variants[0]!.contribution, second.variants[0]!.contribution]) {
      await grant(person.agent, a.principalId, `contribution:read:${contribution}`, 'contribution.read');
    }
    const own = await json<Page<{ id: string; work: { id: string } }>>(await read('/v1/me/contributions?limit=1'));
    expect(own.items).toHaveLength(1);
    expect(own.nextCursor).toBeString();
    const ownNext = await json<Page<{ id: string }>>(await read(`/v1/me/contributions?limit=1&cursor=${own.nextCursor}`));
    expect(ownNext.items).toHaveLength(1);
    const draftInput = { work: hidden.work, language: 'en', body: 'Never expose the draft body', actingSubject: person.agent };
    const draft = await activateTextContribution(stack.env, stack.admission(person.agent, `contribution:create:${hidden.work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    await grant(person.agent, a.principalId, `contribution:read:${draft.contribution!}`, 'contribution.read');
    const privateLibrary = await json<Page<{ id: string; publication: string; work: unknown }>>(await read('/v1/me/contributions'));
    expect(privateLibrary.items.find(item => item.id === draft.contribution)).toMatchObject({ publication: 'draft', work: null });
    expect(JSON.stringify(privateLibrary)).not.toContain(draftInput.body);
    await grant(person.agent, a.principalId, `work:read:${hidden.work}`, 'work.read');
    const admittedPrivate = await json<Page<{ id: string; work: { title: { value: string } } }>>(await read('/v1/me/contributions'));
    expect(admittedPrivate.items.find(item => item.id === draft.contribution)?.work.title.value).toBe('Private Work');
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(draft.draftRevision!)} a rv:ErasedRevision } }`);
    expect((await json<Page<{ id: string }>>(await read('/v1/me/contributions'))).items.some(item => item.id === draft.contribution)).toBe(false);
    expect((await call('GET', '/v1/me/contributions')).status).toBe(401);
    expect((await read('/v1/me/contributions', person.agent, b.token)).status).toBe(403);
    expect((await read(`/v1/me/ratings?cursor=${own.nextCursor}`)).status).toBe(403);

    await grant(person.agent, a.principalId, GLOBAL_CONTEXT_SCOPE, 'rating.context.create');
    const context = await json<{ context: string }>(await call('POST', '/v1/global-rating-contexts',
      { profile: 'global-rating-standing-context-v1', question: 'Quality', actingSubject: person.agent }, a.token), 201);
    for (const [actor, principalId, token, value] of [[person.agent, a.principalId, a.token, 5], [other.agent, b.principalId, b.token, 1]] as const) {
      await grant(actor, principalId, `rating:observe:${context.context}`, 'rating.observation.set');
      await grant(actor, principalId, `rating:read:${context.context}`, 'rating.observation.read');
      for (const work of [first, second]) await json(await call('POST', '/v1/global-rating-observations', {
        profile: 'global-rating-standing-observation-v1', context: context.context, work: work.work,
        mainVersion: work.mainVersion, expectedRevisionHead: null, value, actingSubject: actor }, token), 201);
    }
    const authored = await json<Page<{ id: string; types: string[]; tagline: null | { value: string };
      completionStatus: string | null; rating: { context: string; mean: number; count: number } | null }>>(
      await call('GET', `${root}/works?context=${encodeURIComponent(context.context)}`));
    expect(authored.items).toHaveLength(2);
    expect(authored.items.every(item => item.rating?.context === context.context
      && item.rating.count === 2 && item.rating.mean === 3)).toBe(true);
    expect(authored.items.every(item => Array.isArray(item.types)
      && item.tagline === null && item.completionStatus === null)).toBe(true);
    const ratingReadsBefore = stack.fuseki.queries;
    const ratings = await json<Page<{ value: number; scope: string; id: string; revision: string;
      mainVersion: string; work: { id: string } }>>(await read('/v1/me/ratings?limit=1'));
    // Position fences, receipt, two summary batches and the semantic-type batch.
    expect(stack.fuseki.queries - ratingReadsBefore).toBe(6);
    expect(ratings.items).toMatchObject([{ value: 5, scope: 'global' }]);
    const ratingsNext = await json<Page<{ value: number }>>(await read(`/v1/me/ratings?limit=1&cursor=${ratings.nextCursor}`));
    expect(ratingsNext.items).toMatchObject([{ value: 5 }]);
    expect(ratingsNext.nextCursor).toBeNull();
    expect((await json<Page<{ value: number }>>(await read('/v1/me/ratings', other.agent, b.token))).items)
      .toMatchObject([{ value: 1 }, { value: 1 }]);
    expect((await read(`/v1/me/ratings?cursor=${ratings.nextCursor}`, other.agent, b.token)).status).toBe(400);
    expect((await read('/v1/me/ratings?scope=realm')).status).toBe(400);
    expect((await call('GET', `/v1/me/ratings?actingSubject=${encodeURIComponent(person.agent)}`, undefined, a.token,
      randomUUID(), { 'x-without-rating-scope': '1' })).status).toBe(401);

    // Graph damage cannot masquerade as an empty library or an unrecorded rating.
    const rating = ratings.items[0]!;
    const damagedHead = id();
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(rating.id)} rv:observationHead ${iri(rating.revision)} } }; INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(rating.id)} rv:observationHead ${iri(damagedHead)} } }`);
    expect((await read('/v1/me/ratings')).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(rating.id)} rv:observationHead ${iri(damagedHead)} } }; INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(rating.id)} rv:observationHead ${iri(rating.revision)} } }`);
    await json(await call('POST', '/v1/global-rating-observations', { profile: 'global-rating-standing-observation-v1',
      context: context.context, work: rating.work.id, mainVersion: rating.mainVersion,
      expectedRevisionHead: rating.revision, value: null, actingSubject: person.agent }, a.token), 201);
    expect((await json<Page<{ id: string; value: number | null; availability: string }>>(await read('/v1/me/ratings'))).items
      .find(item => item.id === rating.id)).toMatchObject({ value: null, availability: 'withdrawn' });
    expect((await read(`/v1/me/ratings?cursor=${ratings.nextCursor}`)).status).toBe(409);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(await workHead(second.work))} a rv:ErasedRevision } }`);
    expect((await json<Page<{ id: string }>>(await call('GET', `${root}/works`))).items.map(item => item.id)).toEqual([first.work]);
    expect((await json<Page<{ work: { id: string } }>>(await read('/v1/me/ratings'))).items.some(item => item.work?.id === second.work)).toBe(false);
    // Native validation rejects the erased exact revision before command guards.
    expect((await credit(second.work, 'translator')).response.status).toBe(400);

    // A real Access grant revocation during graph hydration must withhold the page.
    let revoked = false;
    const originalQuery = stack.fuseki.query.bind(stack.fuseki);
    const graph = new Proxy(stack.fuseki, { get(target, property) {
      if (property === 'query') return async (sparql: string, bytes?: number) => {
        const result = await originalQuery(sparql, bytes);
        if (!revoked && sparql.includes('SELECT ?id ?work ?revision ?language ?disclosure')) {
          revoked = true;
          await stack.accessPool.query(`UPDATE access.representation SET active = false
            WHERE principal_id = $1 AND subject_id = $2 AND action = 'contribution.read'`, [a.principalId, person.agent]);
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const racingApp = createMainApp(graph, { ...deps, environment: { ...stack.env, fuseki: graph } });
    expect((await racingApp.handle(new Request(`http://main.local/v1/me/contributions?actingSubject=${encodeURIComponent(person.agent)}`,
      { headers: { authorization: `Bearer ${a.token}` } }))).status).toBe(403);
    expect(revoked).toBe(true);

    // Pending and compensated Agents never become public profiles.
    const pending = { id: randomUUID(), agent: id(), kind: 'person' as const, displayName: 'Never active', digest: 'a'.repeat(64) };
    await createAgentGraph(stack.env, pending);
    expect((await call('GET', `/v1/agents/${short(pending.agent)}`)).status).toBe(404);
    await compensateAgentGraph(stack.env, pending);
    expect((await call('GET', `/v1/handles/agent-${short(pending.agent)}`)).status).toBe(404);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(person.agent)} rv:profileDisclosure rv:Public } }; INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(person.agent)} rv:profileDisclosure rv:Private } }`);
    for (const suffix of ['', '/works', '/collections']) expect((await call('GET', root + suffix)).status).toBe(404);
    expect((await call('GET', `/v1/handles/${header.handle}`)).status).toBe(404);
    expect((await json<Page<unknown>>(await call('GET', creditPath))).items).toEqual([]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(person.agent)} rv:profileDisclosure rv:Private } }; INSERT DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(person.agent)} rv:profileDisclosure rv:Public } }`);
    await stack.accessPool.query('UPDATE access.authority_subject SET active = false WHERE id = $1', [person.agent]);
    expect((await call('GET', root)).status).toBe(404);
    await stack.accessPool.query('UPDATE access.authority_subject SET active = true WHERE id = $1', [person.agent]);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(await workHead(person.agent))} a rv:ErasedRevision } }`);
    expect((await call('GET', root)).status).toBe(404);
    await stack.fuseki.update(`PREFIX rv: <${RV}> INSERT DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`);
    expect((await call('GET', `/v1/agents/${short(org.agent)}`)).status).toBe(503);
    expect((await read('/v1/me/ratings')).status).toBe(503);
    await stack.fuseki.update(`PREFIX rv: <${RV}> DELETE DATA { GRAPH ${iri(GRAPHS.control)} {
      ${iri(DATASET)} rv:restoreHold true } }`);
    expect((await call('GET', `/v1/agents/${short(org.agent)}`)).status).toBe(200);
  } finally { await stack.stop(); }
}, 120_000);
