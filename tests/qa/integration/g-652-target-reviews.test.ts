import { CatalogueIntakeStore } from '../../../services/main/src/modules/catalogue-intake/store.ts';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccountAssertionDenied } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { AgentProvisioning } from '../../../services/main/src/modules/agent/provision.ts';
import { engageAccessRecoveryFence, releaseAccessRecoveryFence } from '../../../services/main/src/modules/access/admission.ts';
import { ReaderReviews } from '../../../services/main/src/modules/review/store.ts';
import { TargetRatingInventoryStore } from '../../../services/main/src/modules/rating/target-inventory.ts';
import { TARGET_RATING_WRITE_COST } from '../../../services/main/src/modules/rating/target.ts';
import { fusekiReadBudget } from '../../../services/main/src/infrastructure/fuseki.ts';
import { startMediaStack } from './media-support.ts';

const short = (value: string) => value.slice(-36);
const nativeId = () => `https://rezics.com/id/${randomUUID()}`;
interface Context { context: string; contextRevision: string }
interface Opinion { observation: string; observationRevision: string; value: number | null }
interface Review { review: string; revision: string }

test('G-652: SAO edition, translation, chapter and resource reviews use exact grains with optional scores', async () => {
  const preparation = Date.now();
  const s = await startMediaStack('g-652');
  let invalidNativeReport: unknown;
  let loseGraphAcknowledgement = false;
  const nativeCommand = s.fuseki.commandWithReceipt.bind(s.fuseki);
  s.fuseki.commandWithReceipt = async envelope => {
    const result = await nativeCommand(envelope);
    if (result.status === 'invalid') invalidNativeReport = result.report;
    if (loseGraphAcknowledgement && result.status === 'committed' && envelope.update.includes('TargetRatingObservation')) {
      loseGraphAcknowledgement = false;
      throw new Error('Lost graph acknowledgement after commit');
    }
    return result;
  };
  try {
    const a = await s.member('reader'), b = await s.member('other-reader');
    const principals = new Map([[a.token, a.principal], [b.token, b.principal]]);
    const account = { verify: async (request: Request) => {
      const principal = principals.get(request.headers.get('authorization')?.replace('Bearer ', '') ?? '');
      if (!principal) throw new AccountAssertionDenied('Authentication required');
      const verified = { ...principal, emailVerified: true };
      return { ...verified, currentAssertion: async () => verified };
    } };
    s.access.configureBaseline(s.fuseki);
    const structureObjects = s.objects('semantic/structure/');
    await structureObjects.initialize();
    const app = createMainApp(s.fuseki, { environment: s.env, catalogueIntake: new CatalogueIntakeStore(s.accessPool, s.env), account, access: s.access,
      content: s.content, contentAuthoring: s.content, structureObjects,
      agentProvisioning: new AgentProvisioning(s.accessPool, s.env),
      reviews: new ReaderReviews(s.accessPool), targetRatingInventory: new TargetRatingInventoryStore(s.accessPool) });
    const call = (method: string, path: string, body?: object, token?: string, key = randomUUID()) =>
      app.handle(new Request(`http://main.local${path}`, { method, headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
    const json = async <T>(response: Response, status = 200): Promise<T> => {
      const body = await response.text();
      if (response.status !== status) throw new Error(`Expected ${status}, got ${response.status}: ${body}; native report: ${JSON.stringify(invalidNativeReport)}`);
      return JSON.parse(body) as T;
    };
    const actor = (await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'SAO reader' }, a.token), 201)).agent;
    const other = (await json<{ agent: string }>(await call('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'SAO reader two' }, b.token), 201)).agent;
    const grant = async (scope: string, action: string, who = actor, principalId = a.principalId) => {
      await s.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
      await s.accessPool.query(`INSERT INTO access.representation(id,principal_id,subject_id,action,valid_until)
        VALUES ($1,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), principalId, who, action]);
      await s.accessPool.query(`INSERT INTO access.permission_grant(id,issuer_subject,recipient_subject,scope_id,action,valid_until)
        VALUES ($1,$2,$2,$3,$4,now() + interval '1 hour')`, [randomUUID(), who, scope, action]);
    };
    const { candidateReceipt } = await json<{ candidateReceipt: string }>(await call('POST', '/v1/catalogue/candidates', {
      profile: 'catalogue-candidates-v1', originalTitle: { value: 'sao.bunko volume 1', language: 'ja' },
      aliases: [], romanizations: [], creators: [], dates: [], identifiers: [],
    }, a.token));
    const bunko = await json<{ work: string; mainVersion: string }>(await call('POST', '/v1/works', {
      profile: 'metadata-only-v1', grain: 'new-creative-scope', candidateReceipt, language: 'ja', title: 'sao.bunko volume 1', semanticTypes: ['https://schema.org/Book'],
      actingSubject: actor }, a.token), 201);
    const translate = async (language: string, text: string) => {
      await grant(`contribution:create:${bunko.work}`, 'contribution.create');
      const draft = await json<{ contribution: string; draftRevision: string }>(await call('POST', '/v1/contributions', {
        profile: 'text-contribution-v1', work: bunko.work, language, body: text, actingSubject: actor }, a.token), 201);
      await grant(`contribution:publish:${draft.contribution}`, 'contribution.publish');
      const publication = await json<{ publicationDecision: string }>(await call('POST', '/v1/contribution-publications', {
        profile: 'text-publication-v1', contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
        expectedPublicationHead: null, rightsBasis: 'original-contribution', disclosure: 'public', actingSubject: actor }, a.token), 201);
      return { ...draft, ...publication };
    };
    const original = await translate('ja', 'ソードアート・オンライン');
    const translation = await translate('en', 'Sword Art Online translation');
    await grant(`publication:select:${bunko.mainVersion}`, 'publication.select');
    await json(await call('POST', '/v1/publication-selections', { profile: 'main-default-selection-v1',
      context: { kind: 'main-version-default', id: bunko.mainVersion }, work: bunko.work,
      contribution: original.contribution, publicationDecision: original.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer', actingSubject: actor }, a.token), 201);
    await grant(`work:edit:${bunko.work}`, 'work.edit');
    const release = nativeId();
    await json(await call('PUT', `/v1/works/${short(bunko.work)}/releases/${short(release)}`, {
      profile: 'release-v1', id: release, expectedHead: null, actingSubject: actor, kind: 'formal', status: 'official',
      contentLanguages: ['en'], isTranslation: true, originalLanguages: ['ja'], titleLanguage: 'en', tracklistLanguage: null,
      title: { value: 'Sword Art Online volume 1', language: 'en' }, editionStatement: null,
      publisher: 'Yen Press', publicationYear: 2014, isbn13: null, originalUrl: null,
      fixedRelease: null, coverage: null, evidence: null }, a.token));
    const structure = await json<{ structure: string; revision: string }>(await call('POST', '/v1/compositions', {
      profile: 'book-composition', work: bunko.work, mainVersion: bunko.mainVersion, actingSubject: actor }, a.token), 201);
    const placed = await json<{ occurrences: string[] }>(await call('POST', `/v1/compositions/${short(structure.structure)}/changes`, {
      profile: 'book-composition', expectedHead: structure.revision, actingSubject: actor, operations: [{ op: 'insert',
        parent: structure.structure, position: 'last', role: 'chapter', target: 'https://schema.org/DigitalDocument',
        label: { value: 'Aincrad chapter one', language: 'en' } }] }, a.token));
    await grant('semantic:create:root', 'semantic.change');
    const character = await json<{ component: string }>(await call('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: actor, state: { component: 'resource',
        types: ['https://rezics.com/vocab/Character'], properties: [{ predicate: 'https://schema.org/name',
          value: { kind: 'language-string', lexical: 'Kirito', language: 'en', direction: 'ltr' } }] } }, a.token), 201);
    await grant(`semantic:read:${character.component}`, 'semantic.read');
    await grant('space:create:root', 'space.create');
    const realm = await json<{ realm: string }>(await call('POST', '/v1/spaces', {
      profile: 'space-realm-v1', name: 'SAO rating questions', capabilities: ['realm'], actingSubject: actor }, a.token), 201);
    await grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const story = await json<Context>(await call('POST', '/v1/rating-contexts', { profile: 'realm-standing-rating-context-v1',
      realm: realm.realm, question: 'How good is the bunko story?', actingSubject: actor }, a.token), 201);
    await grant(`rating:observe:${story.context}`, 'rating.observation.set');
    await json(await call('POST', '/v1/rating-observations', { profile: 'realm-standing-rating-observation-v1',
      context: story.context, work: bunko.work, mainVersion: bunko.mainVersion, value: 9,
      expectedRevisionHead: null, actingSubject: actor }, a.token), 201);
    const storyAggregate = () => call('POST', '/v1/rating-aggregates', { profile: 'realm-standing-latest-mean-v1',
      context: story.context, work: bunko.work, mainVersion: bunko.mainVersion });
    expect(await json(await storyAggregate())).toMatchObject({ count: 1, mean: 9 });
    const review = (context: string, target: string, rating?: number | null) => ({ profile: 'reader-review-command-v1',
      actingSubject: actor, context, target, expectedRevision: null, language: 'en', text: `Review of ${target}`, spoiler: false,
      ...(rating === undefined ? {} : { rating }) });
    const targets = [{ grain: 'release', target: release, question: 'How good is this Yen Press edition?' },
      { grain: 'realization', target: translation.contribution, question: 'How good is this translation?' },
      { grain: 'occurrence', target: placed.occurrences[0]!, question: 'How good is this chapter?' },
      { grain: 'resource', target: character.component, question: 'How good is this character?' }] as const;
    const storyReview = await json<Review>(await call('POST', '/v1/reviews', review(story.context, bunko.work), a.token), 201);
    expect(await json(await call('GET', `/v1/resources/${short(bunko.work)}/reviews?context=${encodeURIComponent(story.context)}`)))
      .toMatchObject({ items: [{ id: storyReview.review, rating: 9 }] });
    expect(await json(await call('GET', `/v1/resources/${short(bunko.work)}/ratings?scope=realm&realm=${encodeURIComponent(realm.realm)}&context=${encodeURIComponent(story.context)}`)))
      .toMatchObject({ count: 1, mean: 9, aggregationScope: { question: 'How good is the bunko story?',
        grain: 'main-version', population: 'account-principal', countedTarget: bunko.mainVersion } });
    const contexts: Context[] = [];
    for (const target of targets) {
      const body = { profile: 'realm-target-rating-context-v2', language: 'en', realm: realm.realm,
        targetGrain: target.grain, question: target.question, actingSubject: actor };
      const key = randomUUID();
      const context = await json<Context>(await call('POST', '/v1/rating-contexts', body, a.token, key), 201);
      contexts.push(context);
      expect(await json(await call('POST', '/v1/rating-contexts', body, a.token, key)))
        .toMatchObject({ context: context.context, replayed: true });
      expect((await call('POST', '/v1/rating-contexts', { ...body, question: 'Another question' }, a.token, key)).status).toBe(409);
      expect(await json(await call('GET', `/v1/rating-contexts/${short(context.context)}`)))
        .toMatchObject({ targetGrain: target.grain, question: target.question });
      await grant(`rating:observe:${context.context}`, 'rating.observation.set');
      const rating = { profile: 'realm-target-rating-observation-v1', context: context.context, target: target.target,
        value: 8, expectedRevisionHead: null, actingSubject: actor };
      const ratingKey = randomUUID();
      const budget = { signal: AbortSignal.timeout(TARGET_RATING_WRITE_COST.commandDeadlineMs),
        callsLeft: TARGET_RATING_WRITE_COST.graphCalls, bytesLeft: TARGET_RATING_WRITE_COST.graphBytes };
      loseGraphAcknowledgement = target.grain === 'release';
      const opinion = await json<Opinion>(await fusekiReadBudget.run(budget,
        () => call('POST', '/v1/rating-observations', rating, a.token, ratingKey)), 201);
      expect(budget.callsLeft).toBeGreaterThanOrEqual(0);
      expect(await json(await call('POST', '/v1/rating-observations', rating, a.token, ratingKey)))
        .toMatchObject({ ...opinion, replayed: true });
      expect((await call('POST', '/v1/rating-observations', { ...rating, value: 7 }, a.token, ratingKey)).status).toBe(409);
      expect((await call('POST', '/v1/rating-observations', rating, a.token)).status).toBe(409);
      const automatic = await json<Review>(await call('POST', '/v1/reviews', review(context.context, target.target), a.token), 201);
      expect(await json(await call('GET', `/v1/reviews/${automatic.review}?actingSubject=${encodeURIComponent(actor)}`, undefined, a.token)))
        .toMatchObject({ rating: 8, ratingObservation: opinion.observation, ratingRevision: opinion.observationRevision });
      const unscored = await json<Review>(await call('POST', '/v1/reviews', { ...review(context.context, target.target, null),
        expectedRevision: automatic.revision }, a.token));
      const path = `/v1/resources/${short(target.target)}/reviews?context=${encodeURIComponent(context.context)}`;
      const suffix = target.grain === 'resource' ? `&actingSubject=${encodeURIComponent(actor)}` : '';
      expect(await json(await call('GET', path + suffix, undefined, suffix ? a.token : undefined)))
        .toMatchObject({ items: [{ id: unscored.review, work: target.target, rating: null,
          ratingObservation: null, ratingRevision: null }] });
      expect((await call('POST', '/v1/reviews', { ...review(context.context, target.target, 7),
        expectedRevision: unscored.revision }, a.token)).status).toBe(403);
      let scored = await json<Review>(await call('POST', '/v1/reviews', { ...review(context.context, target.target, 8),
        expectedRevision: unscored.revision }, a.token));
      expect(await json(await call('GET', `/v1/reviews/${scored.review}?actingSubject=${encodeURIComponent(actor)}`, undefined, a.token)))
        .toMatchObject({ rating: 8, ratingObservation: opinion.observation, ratingRevision: opinion.observationRevision });
      const aggregateBody = { profile: 'realm-target-latest-mean-v1', context: context.context, target: target.target,
        ...(suffix ? { actingSubject: actor } : {}) };
      const aggregate = () => call('POST', '/v1/rating-aggregates', aggregateBody, suffix ? a.token : undefined);
      // One rating is under the display threshold: the sum and histogram show, the mean does not.
      expect(await json(await aggregate())).toMatchObject({ count: 1, sum: 8, mean: null, meanDisplay: 'withheld-below-threshold', target: target.target,
        scope: { question: target.question, grain: target.grain, population: 'account-principal', countedTarget: target.target } });
      if (target.grain === 'release') {
        await s.fuseki.update(`DELETE DATA { GRAPH <urn:rezics:graph:current> { <${opinion.observation}>
          <https://rezics.com/vocab/observationHead> <${opinion.observationRevision}> } }`);
        try { expect((await aggregate()).status).toBe(503); }
        finally { await s.fuseki.update(`INSERT DATA { GRAPH <urn:rezics:graph:current> { <${opinion.observation}>
          <https://rezics.com/vocab/observationHead> <${opinion.observationRevision}> } }`); }
        expect(await json(await aggregate())).toMatchObject({ count: 1, sum: 8, mean: null, meanDisplay: 'withheld-below-threshold' });
        await json(await call('PUT', `/v1/reviews/${unscored.review}/helpful`, {
          profile: 'reader-review-helpful-v1', actingSubject: other, helpful: true, expectedRevision: null }, b.token));
      }
      const readQuery = `scope=realm&realm=${encodeURIComponent(realm.realm)}` + suffix;
      expect(await json(await call('GET', `/v1/resources/${short(target.target)}/rating-contexts?${readQuery}`,
        undefined, suffix ? a.token : undefined))).toMatchObject({ items: [{ context: context.context, question: target.question }] });
      expect(await json(await call('GET', `/v1/resources/${short(target.target)}/ratings?${readQuery}&context=${encodeURIComponent(context.context)}`,
        undefined, suffix ? a.token : undefined))).toMatchObject({ count: 1, mean: null, meanDisplay: 'withheld-below-threshold', target: target.target,
        aggregationScope: { question: target.question, grain: target.grain,
          population: 'account-principal', countedTarget: target.target } });
      await grant(`rating:read:${context.context}`, 'rating.observation.read');
      expect(await json(await call('GET', `/v1/rating-observations/${short(opinion.observation)}/revisions/${short(opinion.observationRevision)}`
        + `?profile=realm-target-rating-observation-v1&context=${encodeURIComponent(context.context)}`
        + `&target=${encodeURIComponent(target.target)}&actingSubject=${encodeURIComponent(actor)}`, undefined, a.token)))
        .toMatchObject({ value: 8, target: target.target });
      const changes = await Promise.all([7, 6].map(value => call('POST', '/v1/rating-observations', {
        ...rating, expectedRevisionHead: opinion.observationRevision, value }, a.token)));
      expect(changes.map(response => response.status).sort()).toEqual([201, 409]);
      const winner = await changes.find(response => response.status === 201)!.json() as Opinion;
      scored = await json<Review>(await call('POST', '/v1/reviews', { ...review(context.context, target.target),
        expectedRevision: scored.revision, text: 'An edit binding the newly current rating' }, a.token));
      expect(await json(await call('GET', `/v1/reviews/${scored.review}?actingSubject=${encodeURIComponent(actor)}`, undefined, a.token)))
        .toMatchObject({ rating: winner.value, ratingObservation: winner.observation, ratingRevision: winner.observationRevision });
      await json(await call('POST', '/v1/rating-observations', { ...rating, expectedRevisionHead: winner.observationRevision,
        value: null }, a.token), 201);
      expect(await json(await aggregate())).toMatchObject({ population: 1, count: 0, withdrawnCount: 1, mean: null });
      const omittedKey = randomUUID();
      const editText = { ...review(context.context, target.target), expectedRevision: scored.revision,
        text: 'An edit after withdrawing the current rating' };
      scored = await json<Review>(await call('POST', '/v1/reviews', editText, a.token, omittedKey));
      expect(await json(await call('GET', `/v1/reviews/${scored.review}?actingSubject=${encodeURIComponent(actor)}`, undefined, a.token)))
        .toMatchObject({ rating: null, ratingObservation: null, ratingRevision: null });
      expect((await call('POST', '/v1/reviews', { ...editText, rating: null }, a.token, omittedKey)).status).toBe(409);
      expect((await call('POST', '/v1/reviews', { ...review(context.context, target.target, 8),
        expectedRevision: scored.revision }, a.token)).status).toBe(404);
      const noScoreKey = randomUUID();
      const noScore = { ...review(context.context, target.target, null), expectedRevision: scored.revision };
      await json(await call('POST', '/v1/reviews', noScore, a.token, noScoreKey));
      expect(await json(await call('POST', '/v1/reviews', noScore, a.token, noScoreKey))).toMatchObject({ replayed: true });
      expect(await json(await storyAggregate())).toMatchObject({ count: 1, mean: 9 });
    }
    const realization = contexts[1]!.context;
    expect((await call('POST', '/v1/rating-observations', { profile: 'realm-target-rating-observation-v1',
      context: realization, target: targets[2]!.target, expectedRevisionHead: null, value: 8, actingSubject: actor }, a.token)).status).toBe(422);
    expect((await call('POST', '/v1/reviews', review(realization, targets[2]!.target), a.token)).status).toBe(422);
    expect((await call('POST', '/v1/reviews', { ...review(realization, targets[1]!.target), actingSubject: other }, b.token)).status).toBe(201);
    const secondQuestion = await json<Context>(await call('POST', '/v1/rating-contexts', {
      profile: 'realm-target-rating-context-v2', language: 'en', realm: realm.realm, targetGrain: 'realization',
      question: 'How faithful is this translation?', actingSubject: actor }, a.token), 201);
    expect(await json(await call('GET', `/v1/resources/${short(targets[1]!.target)}/reviews?context=${encodeURIComponent(secondQuestion.context)}`)))
      .toMatchObject({ items: [] });
    const separate = await json<Review>(await call('POST', '/v1/reviews', review(secondQuestion.context, targets[1]!.target), a.token), 201);
    const existing = await json<{ items: { id: string }[] }>(await call('GET', `/v1/resources/${short(targets[1]!.target)}/reviews?context=${encodeURIComponent(realization)}`));
    expect(existing.items.some(item => item.id === separate.review)).toBe(false);
    const missing = await call('POST', '/v1/reviews', review(realization, nativeId()), a.token);
    expect(missing.status).toBe(404);
    const rows = (await s.accessPool.query('SELECT main_version, rating, rating_observation, rating_revision FROM access.reader_review WHERE context = $1', [realization])).rows;
    expect(rows.every(row => row.main_version === null && row.rating === null && row.rating_observation === null && row.rating_revision === null)).toBe(true);
    await expect(s.accessPool.query('UPDATE access.reader_review SET rating = 5 WHERE context = $1', [realization])).rejects.toThrow();
    const generation = await engageAccessRecoveryFence(s.accessPool);
    try { expect((await call('GET', `/v1/resources/${short(release)}/reviews?context=${encodeURIComponent(contexts[0]!.context)}`)).status).toBe(503); }
    finally { await releaseAccessRecoveryFence(s.accessPool, generation); }
    expect(Date.now() - preparation).toBeLessThan(600_000);
  } finally { await s.stop(); }
}, 120_000);
