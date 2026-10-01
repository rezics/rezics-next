import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { GRAPHS, RV, iri, lit, prepareComponent } from '../../../services/main/src/modules/work/activate.ts';
import { LEGACY_TARGET_CONTEXT_PROFILE, TARGET_CONTEXT_PROFILE } from '../../../services/main/src/modules/rating/target.ts';
import { readComponentState } from '../../../services/main/src/modules/work/history.ts';
import { startMediaStack } from './media-support.ts';
import { spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';

const short = (value: string) => value.slice(-36);
interface Context { context: string; contextRevision: string; language: string }
interface Opinion { observation: string; observationRevision: string }
test('G-935: declared question languages survive writes, inventories, ratings and legacy recovery', async () => {
  const s = await startMediaStack('g-935', { profileCredits: true });
  let nativeReport: unknown;
  const nativeCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
  s.fuseki.commandWithReceipt = async envelope => {
    const result = await nativeCommand(envelope);
    if (result.status === 'invalid') nativeReport = result.report;
    return result;
  };
  const json = async <T>(response: Response, status = 200): Promise<T> => {
    const body = await response.text();
    if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}; native: ${JSON.stringify(nativeReport)}`);
    return JSON.parse(body) as T;
  };
  try {
    const member = await s.member('rating-editor');
    const account = { verify: async (request: Request) => {
      if (request.headers.get('authorization') !== `Bearer ${member.token}`) throw new AccountAssertionDenied();
      const principal = { ...member.principal, emailVerified: true };
      return { ...principal, currentAssertion: async () => principal };
    } };
    s.access.configureBaseline(s.fuseki);
    const app = createMainApp(s.fuseki, { environment: s.env, account, access: s.access,
      targetRatingInventory: new TargetRatingInventoryStore(s.accessPool) });
    const call = (method: string, path: string, body?: object, key = randomUUID(), authenticated = true) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(authenticated ? { authorization: `Bearer ${member.token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    await member.grant('space:create:root', 'space.create');
    const space = { profile: 'space-realm-v1', name: '評価の質問', language: 'ja', capabilities: ['realm'], actingSubject: member.actor };
    expect(() => spaceCreationDigest(space)).not.toThrow();
    const realm = (await json<{ realm: string }>(await call('POST', '/v1/spaces', space), 201)).realm;
    await member.grant('semantic:create:root', 'semantic.change');
    const target = (await json<{ component: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: member.actor,
      state: { component: 'resource', types: ['https://rezics.com/vocab/Character'], properties: [{
        predicate: 'https://schema.org/name', value: { kind: 'language-string', lexical: 'キリト', language: 'ja', direction: 'ltr' } }] } }), 201)).component;
    await member.grant(`semantic:read:${target}`, 'semantic.read');
    await member.grant(`rating:context:${realm}`, 'rating.context.create');
    const question = { profile: 'realm-target-rating-context-v2', realm, question: 'この人物の評価は？', language: 'ja',
      targetGrain: 'resource', actingSubject: member.actor };
    const key = randomUUID();
    const { language: _language, ...missingLanguage } = question;
    expect((await call('POST', '/v1/rating-contexts', missingLanguage)).status).toBe(400);
    expect((await call('POST', '/v1/rating-contexts', { ...question, language: 'ja ; INSERT' })).status).toBe(400);
    expect((await call('POST', '/v1/rating-contexts', question, randomUUID(), false)).status).toBe(401);
    const context = await json<Context>(await call('POST', '/v1/rating-contexts', question, key), 201);
    expect(context.language).toBe('ja');
    expect(await json(await call('POST', '/v1/rating-contexts', question, key))).toMatchObject({ language: 'ja', replayed: true });
    expect((await call('POST', '/v1/rating-contexts', { ...question, language: 'zh' }, key)).status).toBe(409);
    const read = () => call('GET', `/v1/rating-contexts/${short(context.context)}`);
    expect(await json(await read())).toMatchObject({ question: question.question, language: 'ja' });
    const scope = `scope=realm&realm=${encodeURIComponent(realm)}&actingSubject=${encodeURIComponent(member.actor)}`;
    expect(await json(await call('GET', `/v1/resources/${short(target)}/rating-contexts?${scope}`)))
      .toMatchObject({ items: [{ context: context.context, question: question.question, language: 'ja' }] });
    await member.grant(`rating:observe:${context.context}`, 'rating.observation.set');
    const rating = { profile: 'realm-target-rating-observation-v1', context: context.context, target,
      value: 8, expectedRevisionHead: null, actingSubject: member.actor };
    const ratingKey = randomUUID();
    const opinion = await json<Opinion>(await call('POST', '/v1/rating-observations', rating, ratingKey), 201);
    expect(await json(await call('POST', '/v1/rating-observations', rating, ratingKey))).toMatchObject({ ...opinion, replayed: true });
    const aggregate = () => call('POST', '/v1/rating-aggregates', { profile: 'realm-target-latest-mean-v1',
      context: context.context, target, actingSubject: member.actor });
    expect(await json(await aggregate())).toMatchObject({ count: 1, mean: 8, scope: { question: question.question, language: 'ja' } });
    expect(await json(await call('GET', `/v1/resources/${short(target)}/ratings?${scope}&context=${encodeURIComponent(context.context)}`)))
      .toMatchObject({ aggregationScope: { question: question.question, language: 'ja' }, count: 1 });
    await member.grant(`rating:read:${context.context}`, 'rating.observation.read');
    expect(await json(await call('GET', `/v1/rating-observations/${short(opinion.observation)}/revisions/${short(opinion.observationRevision)}`
      + `?profile=realm-target-rating-observation-v1&context=${encodeURIComponent(context.context)}`
      + `&target=${encodeURIComponent(target)}&actingSubject=${encodeURIComponent(member.actor)}`))).toMatchObject({ value: 8 });
    const changes = await Promise.all([6, 7].map(value => call('POST', '/v1/rating-observations', {
      ...rating, value, expectedRevisionHead: opinion.observationRevision })));
    expect(changes.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await changes.find(response => response.status === 201)!.json() as Opinion;
    await json(await call('POST', '/v1/rating-observations', { ...rating, value: null,
      expectedRevisionHead: winner.observationRevision }), 201);
    expect(await json(await aggregate())).toMatchObject({ count: 0, withdrawnCount: 1, scope: { language: 'ja' } });

    // Reconstruct a historical v1 Context from immutable bytes, retaining its
    // receipt/head and recorded tag. Recovery neither rewrites v1 nor guesses.
    const legacy = await json<Context>(await call('POST', '/v1/rating-contexts', {
      ...question, question: 'How good is this character?', language: 'en' }), 201);
    const rows = (await s.fuseki.query(`SELECT ?manifest WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(legacy.contextRevision)} <${RV}manifest> ?manifest } }`)).results!.bindings!;
    const current = readComponentState(s.env.objectDirectory, rows[0]!.manifest!.value, legacy.context, TARGET_CONTEXT_PROFILE);
    const { language: _recorded, ...oldState } = current;
    const oldManifest = prepareComponent(s.env.objectDirectory, legacy.context, oldState, LEGACY_TARGET_CONTEXT_PROFILE);
    await s.fuseki.update(`PREFIX rv: <${RV}> DELETE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(legacy.context)} a rv:LanguageTaggedTargetRatingContext }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(legacy.contextRevision)} rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape }
    } INSERT { GRAPH ${iri(GRAPHS.revisions)} { ${iri(legacy.contextRevision)}
      rv:manifest ${iri(`urn:rezics:sha256:${oldManifest}`)} ; rv:modelRevision ${iri(LEGACY_TARGET_CONTEXT_PROFILE)} ;
      rv:shapeRevision ${iri(LEGACY_TARGET_CONTEXT_PROFILE)} } } WHERE { GRAPH ${iri(GRAPHS.revisions)} {
      ${iri(legacy.contextRevision)} rv:manifest ?manifest ; rv:modelRevision ?model ; rv:shapeRevision ?shape } }`);
    expect(await json(await call('GET', `/v1/rating-contexts/${short(legacy.context)}`)))
      .toMatchObject({ profile: 'realm-target-rating-context-v1', language: 'en' });
    await member.grant(`rating:observe:${legacy.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', { ...rating, context: legacy.context }), 201);
    expect(await json(await call('POST', '/v1/rating-aggregates', { profile: 'realm-target-latest-mean-v1',
      context: legacy.context, target, actingSubject: member.actor }))).toMatchObject({ count: 1, mean: 8, scope: { language: 'en' } });

    const replaceTag = async (from: string, to: string) => s.fuseki.update(`DELETE DATA { GRAPH ${iri(GRAPHS.current)} {
      ${iri(context.context)} <${RV}question> ${lit(question.question)}@${from} } };
      INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(context.context)} <${RV}question> ${lit(question.question)}@${to} } }`);
    await replaceTag('ja', 'zh');
    expect(await json(await read(), 409)).toMatchObject({ code: 'rating_observation_unavailable' });
    await replaceTag('zh', 'ja');
    expect(await json(await read())).toMatchObject({ language: 'ja' });
  } finally { await s.stop(); }
}, 120_000);
