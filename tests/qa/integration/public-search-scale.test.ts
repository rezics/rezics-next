import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient, type SparqlResult } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { createClassificationContext, classificationContextDigest }
  from '../../../services/main/src/modules/classification/context.ts';
import { setClassificationDecision, classificationDecisionDigest, classificationDecisionScope,
  type ClassificationDecisionContext } from '../../../services/main/src/modules/classification/decision.ts';
import { createClassificationProposition, classificationPropositionDigest }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { resolveClassification } from '../../../services/main/src/modules/classification/resolve.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRatingContext, ratingContextDigest }
  from '../../../services/main/src/modules/rating/context.ts';
import { setStandingRating, standingRatingDigest }
  from '../../../services/main/src/modules/rating/observation.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, iri, lit, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import type { SearchContinuation }
  from '../../../services/main/src/modules/work/search-continuation.ts';

const root = resolve(import.meta.dir, '../../..');

class CountingFusekiClient extends FusekiClient {
  inventories = 0;
  queryCalls = 0;
  healthCalls = 0;
  joinedQueries = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queryCalls++;
    if (sparql.includes('"body:*"')) this.inventories++;
    if (sparql.includes('ratingPopulation') && sparql.includes('text:query')) this.joinedQueries++;
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth() {
    this.healthCalls++;
    return super.commandHealth();
  }
}

test('SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging and author switch', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `search-scale-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const actor = ID + randomUUID();
  const otherAuthor = ID + randomUUID();
  const phrase = `scale${randomUUID().replaceAll('-', '')}`;
  const fuseki = new CountingFusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = {
    fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects'),
  };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const mainByWork = new Map<string, string>();
  const app = createMainApp(fuseki, { environment: env,
    account: { verify: async () => { throw new Error('no authority request in search test'); } },
    access: new AccessAdmissionRegistry(accessPool) });
  function admission(scope: string, action: string, requestDigest: string,
    actingSubject = actor, principalId = randomUUID()): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId, actingSubject, scope, action,
      idempotencyKey: `scale-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function addWork(index: number, language: string,
    body = `${phrase} selected article ${index}`, author = actor) {
    const title = `Search scale ${index} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const draftInput = { work: created.work, language, body, actingSubject: author };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${created.work}`, 'contribution.create',
        textContributionDigest(draftInput), author), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('scale Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: author };
    const published = await publishTextContribution(env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput), author), publishInput);
    if (published.outcome !== 'succeeded' || !published.publicationDecision) {
      throw new Error('scale Contribution publication failed');
    }
    const selectionInput = { context: { kind: 'main-version-default' as const,
      id: created.mainVersion }, work: created.work,
      contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const,
      actingSubject: actor };
    const selected = await selectMainDefault(env,
      admission(`publication:select:${created.mainVersion}`, 'publication.select',
        mainSelectionDigest(selectionInput)), selectionInput);
    if (selected.outcome !== 'succeeded' || !selected.matchUnit) {
      throw new Error('scale Main selection failed');
    }
    mainByWork.set(created.work, created.mainVersion);
    return created.work;
  }
  async function query(language: string | null, author?: string) {
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language, author }),
    }));
    if (response.status !== 200) {
      throw new Error(`public scale query returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<{ complete: boolean; population: number; total: number;
      results: Array<{ work: string }> }>;
  }
  async function page(continuation?: SearchContinuation) {
    return app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-page-v1', phrase,
        language: null, pageSize: 35, continuation }),
    }));
  }
  async function selectedHeads(works: readonly string[]) {
    const values = works.map(work => `<${work}>`).join(' ');
    const result = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT ?work ?selection ?unit WHERE {
        VALUES ?work { ${values} }
        GRAPH <urn:rezics:graph:current> {
          ?work rv:mainVersion ?main . ?main rv:selectionHead ?selection . }
        GRAPH <urn:rezics:graph:revisions> { ?selection rv:matchUnit ?unit . }
        GRAPH <urn:rezics:search:public> {
          ?unit a rv:MatchUnit ; rv:work ?work ; rv:selection ?selection . }
      }`);
    const rows = result.results?.bindings ?? [];
    expect(rows).toHaveLength(works.length);
    const selected = new Map(rows.map(row => [row.work!.value,
      { selection: row.selection!.value, unit: row.unit!.value }]));
    expect(selected.size).toBe(works.length);
    return selected;
  }
  try {
    const prior = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      SELECT (COUNT(DISTINCT ?unit) AS ?count) WHERE {
        GRAPH <urn:rezics:search:public> { ?unit a rv:MatchUnit }
      }`);
    const existingPopulation = Number(prior.results?.bindings[0]?.count?.value);
    if (!Number.isSafeInteger(existingPopulation) || existingPopulation < 0) {
      throw new Error('existing shared-stack public unit count is invalid');
    }
    const works: string[] = [];
    for (let index = 0; index < 101; index++) works.push(await addWork(index, 'fr'));
    const lateWork = await addWork(101, 'en');
    const coldStart = { queries: fuseki.queryCalls, health: fuseki.healthCalls };
    const late = await query('en');
    expect(late.complete).toBe(true);
    expect(late.population).toBe(existingPopulation + 102);
    expect(late.total).toBe(1);
    expect(late.results[0]?.work).toBe(lateWork);
    expect(fuseki.inventories).toBe(1);
    expect(fuseki.queryCalls - coldStart.queries).toBe(4);
    expect(fuseki.healthCalls - coldStart.health).toBe(3);
    const warmStart = { queries: fuseki.queryCalls, health: fuseki.healthCalls };
    const all = await query(null);
    expect(all.complete).toBe(true);
    expect(all.population).toBe(existingPopulation + 102);
    expect(all.total).toBe(102);
    expect(new Set(all.results.map(row => row.work))).toEqual(new Set([...works, lateWork]));
    expect(fuseki.inventories).toBe(1);
    expect(fuseki.queryCalls - warmStart.queries).toBe(3);
    expect(fuseki.healthCalls - warmStart.health).toBe(3);
    const pageStart = { queries: fuseki.queryCalls, inventories: fuseki.inventories };
    const firstPageResponse = await page();
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await firstPageResponse.json() as { relationComplete: boolean;
      total: number; results: Array<{ work: string }>; next: SearchContinuation | null };
    expect(firstPage.relationComplete).toBe(true);
    expect(firstPage.total).toBe(102);
    const secondPageResponse = await page(firstPage.next!);
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await secondPageResponse.json() as typeof firstPage;
    const thirdPageResponse = await page(secondPage.next!);
    expect(thirdPageResponse.status).toBe(200);
    const thirdPage = await thirdPageResponse.json() as typeof firstPage;
    expect(thirdPage.next).toBeNull();
    expect([...firstPage.results, ...secondPage.results, ...thirdPage.results]
      .map(row => row.work)).toEqual(all.results.map(row => row.work));
    expect(fuseki.inventories).toBe(pageStart.inventories);
    expect(fuseki.queryCalls - pageStart.queries).toBeLessThanOrEqual(12);
    const nextWork = await addWork(102, 'en');
    const stalePage = await page(firstPage.next!);
    expect(stalePage.status).toBe(409);
    expect(await stalePage.json()).toMatchObject({ code: 'search_restart_required' });
    const afterWrite = await query('en');
    expect(afterWrite.population).toBe(existingPopulation + 103);
    expect(afterWrite.total).toBe(2);
    expect(new Set(afterWrite.results.map(row => row.work))).toEqual(new Set([lateWork, nextWork]));
    expect(fuseki.inventories).toBe(2);
    const corpus = [...works, lateWork, nextWork];
    const beforeAuthorSwitch = await selectedHeads(corpus);
    const alternateInput = { work: lateWork, language: 'en',
      body: `${phrase} selected article 101 second author`, actingSubject: otherAuthor };
    const alternateDraft = await activateTextContribution(env,
      admission(`contribution:create:${lateWork}`, 'contribution.create',
        textContributionDigest(alternateInput), otherAuthor), alternateInput);
    if (alternateDraft.outcome !== 'succeeded' || !alternateDraft.contribution
      || !alternateDraft.draftRevision) throw new Error('alternate author draft failed');
    const alternatePublicationInput = { contribution: alternateDraft.contribution,
      expectedDraftHead: alternateDraft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: otherAuthor };
    const alternatePublication = await publishTextContribution(env,
      admission(`contribution:publish:${alternateDraft.contribution}`, 'contribution.publish',
        textPublicationDigest(alternatePublicationInput), otherAuthor), alternatePublicationInput);
    if (alternatePublication.outcome !== 'succeeded' || !alternatePublication.publicationDecision) {
      throw new Error('alternate author publication failed');
    }
    const authorSelectionInput = { context: { kind: 'main-version-default' as const,
      id: mainByWork.get(lateWork)! }, work: lateWork,
      contribution: alternateDraft.contribution,
      publicationDecision: alternatePublication.publicationDecision,
      expectedSelectionHead: beforeAuthorSwitch.get(lateWork)!.selection,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const authorSelection = await selectMainDefault(env,
      admission(`publication:select:${mainByWork.get(lateWork)!}`, 'publication.select',
        mainSelectionDigest(authorSelectionInput)), authorSelectionInput);
    if (authorSelection.outcome !== 'succeeded' || !authorSelection.selection
      || !authorSelection.matchUnit) {
      throw new Error('alternate author selection failed');
    }
    const afterAuthorSwitch = await selectedHeads(corpus);
    for (const work of corpus.filter(work => work !== lateWork)) {
      expect(afterAuthorSwitch.get(work)).toEqual(beforeAuthorSwitch.get(work));
    }
    expect(afterAuthorSwitch.get(lateWork)).toEqual({
      selection: authorSelection.selection, unit: authorSelection.matchUnit });
    expect(afterAuthorSwitch.get(lateWork)).not.toEqual(beforeAuthorSwitch.get(lateWork));
    const afterSwap = await query('en');
    expect(afterSwap.population).toBe(existingPopulation + 103);
    expect(new Set(afterSwap.results.map(row => row.work))).toEqual(new Set([lateWork, nextWork]));
    expect(fuseki.inventories).toBe(3);
    const authorStart = { queries: fuseki.queryCalls, health: fuseki.healthCalls };
    const firstAuthor = await query('en', actor);
    expect(firstAuthor.complete).toBe(true);
    expect(firstAuthor.results.map(row => row.work)).toEqual([nextWork]);
    expect(fuseki.queryCalls - authorStart.queries).toBe(3);
    expect(fuseki.healthCalls - authorStart.health).toBe(3);
    const secondAuthorStart = { queries: fuseki.queryCalls, health: fuseki.healthCalls };
    const secondAuthor = await query('en', otherAuthor);
    expect(secondAuthor.complete).toBe(true);
    expect(secondAuthor.results.map(row => row.work)).toEqual([lateWork]);
    expect(fuseki.queryCalls - secondAuthorStart.queries).toBe(3);
    expect(fuseki.healthCalls - secondAuthorStart.health).toBe(3);
    expect(fuseki.inventories).toBe(3);

    const spaceInput = { name: `Scale Realm ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(env,
      admission('space:create:root', 'space.create', spaceCreationDigest(spaceInput)), spaceInput);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('scale Realm failed');
    const contextInput = { realm: space.realm, actingSubject: actor };
    const context = await createClassificationContext(env,
      admission(`classification:context:${space.realm}`, 'classification.context.configure',
        classificationContextDigest(contextInput)), contextInput);
    if (context.outcome !== 'succeeded' || !context.context) {
      throw new Error('scale classification context failed');
    }
    const senseInput = { label: `Scale Sense ${randomUUID()}`, actingSubject: actor };
    const proposition = await createClassificationProposition(env,
      admission('classification:define:global', 'classification.proposition.define',
        classificationPropositionDigest(senseInput)), senseInput);
    if (proposition.outcome !== 'succeeded' || !proposition.definitions?.sense) {
      throw new Error('scale classification proposition failed');
    }
    const sense = proposition.definitions.sense;
    async function classified(realm: string | null) {
      const response = await app.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(realm
          ? { profile: 'public-realm-classified-phrase-v1',
            context: { kind: 'realm-local', id: realm }, phrase, language: 'en', sense }
          : { profile: 'public-main-classified-phrase-v1', phrase, language: 'en', sense }),
      }));
      if (response.status !== 200) {
        throw new Error(`classified query returned ${response.status}: ${await response.text()}`);
      }
      return response.json() as Promise<{ total: number; sourcePosition: {
        dataEpoch: string; sequence: string }; results: Array<{ work: string;
        classification: { decision: string; source: string } }> }>;
    }
    async function decide(work: string, context: ClassificationDecisionContext,
      outcome: 'accepted' | 'rejected') {
      const input = { context, work, mainVersion: mainByWork.get(work)!, sense,
        expectedDecisionHead: null, outcome, actingSubject: actor };
      const result = await setClassificationDecision(env,
        admission(classificationDecisionScope(context), 'classification.decision.set',
          classificationDecisionDigest(input)), input);
      if (result.outcome !== 'succeeded' || !result.decision) {
        throw new Error('scale classification decision failed');
      }
      return result.decision;
    }
    expect((await classified(null)).total).toBe(0);
    const globalDecision = await decide(lateWork, { kind: 'global' }, 'accepted');
    const mainClassified = await classified(null);
    expect(mainClassified.results.map(row => row.work)).toEqual([lateWork]);
    expect(mainClassified.results[0]?.classification).toMatchObject({
      decision: globalDecision, source: 'global' });
    const classifiedPageResponse = await app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-classified-phrase-page-v1',
        phrase, language: 'en', sense, pageSize: 1 }),
    }));
    expect(classifiedPageResponse.status).toBe(200);
    expect(await classifiedPageResponse.json()).toMatchObject({ relationComplete: true,
      classificationSense: sense, total: 1,
      results: [{ work: lateWork }], next: null });
    const inherited = await classified(space.realm);
    expect(inherited.results.map(row => row.work)).toEqual([lateWork]);
    expect(inherited.results[0]?.classification).toMatchObject({
      decision: globalDecision, source: 'inherited-global' });
    const directInherited = await resolveClassification(env, { work: lateWork,
      mainVersion: mainByWork.get(lateWork)!, sense,
      context: { kind: 'realm-classification', id: space.realm } });
    expect(directInherited.sourcePosition).toEqual({ datasetId: 'product',
      ...inherited.sourcePosition });
    expect(directInherited.decision).toBe(inherited.results[0]?.classification.decision);
    await decide(lateWork, { kind: 'realm-classification', id: space.realm }, 'rejected');
    expect((await classified(space.realm)).total).toBe(0);
    const localDecision = await decide(nextWork,
      { kind: 'realm-classification', id: space.realm }, 'accepted');
    const local = await classified(space.realm);
    expect(local.results.map(row => row.work)).toEqual([nextWork]);
    expect(local.results[0]?.classification).toMatchObject({
      decision: localDecision, source: 'local' });
    const realmPageResponse = await app.handle(new Request('http://main.local/v1/queries/page', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-realm-classified-phrase-page-v1',
        context: { kind: 'realm-local', id: space.realm },
        phrase, language: 'en', sense, pageSize: 1 }),
    }));
    expect(realmPageResponse.status).toBe(200);
    expect(await realmPageResponse.json()).toMatchObject({ relationComplete: true,
      classificationSense: sense, total: 1,
      results: [{ work: nextWork }], next: null });
    expect((await classified(null)).results.map(row => row.work)).toEqual([lateWork]);

    const ratingInput = { realm: space.realm, question: 'Scale quality', actingSubject: actor };
    const ratingContext = await createRatingContext(env,
      admission(`rating:context:${space.realm}`, 'rating.context.create',
        ratingContextDigest(ratingInput)), ratingInput);
    if (ratingContext.outcome !== 'succeeded' || !ratingContext.context) {
      throw new Error('scale rating context failed');
    }
    async function joinedRated(searchPhrase = phrase, searchLanguage = 'en', author?: string) {
      const response = await app.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-realm-classified-rated-phrase-v1',
          context: { kind: 'realm-local', id: space.realm },
          phrase: searchPhrase, language: searchLanguage, author,
          sense, ratingContext: ratingContext.context,
          minimumMeanTimes10: 80 }),
      }));
      if (response.status !== 200) {
        throw new Error(`joined rated query returned ${response.status}: ${await response.text()}`);
      }
      return response.json() as Promise<{ total: number; population: number;
        ratingPopulation: number; results: Array<{ work: string; matchUnit: string;
          mainVersion: string; score: number;
          classification: { decision: string; source: string };
          rating: { count: number; sum: number } }> }>;
    }
    expect((await joinedRated()).total).toBe(0);
    const rejectedStandingInput = { context: ratingContext.context, work: lateWork,
      mainVersion: mainByWork.get(lateWork)!, expectedRevisionHead: null,
      value: 10, actingSubject: otherAuthor };
    const rejectedStanding = await setStandingRating(env,
      admission(`rating:observe:${ratingContext.context}`, 'rating.observation.set',
        standingRatingDigest(rejectedStandingInput), otherAuthor), rejectedStandingInput);
    expect(rejectedStanding.outcome).toBe('succeeded');
    expect((await joinedRated()).total).toBe(0);
    const standingInput = { context: ratingContext.context, work: nextWork,
      mainVersion: mainByWork.get(nextWork)!, expectedRevisionHead: null,
      value: 9, actingSubject: actor };
    const standing = await setStandingRating(env,
      admission(`rating:observe:${ratingContext.context}`, 'rating.observation.set',
        standingRatingDigest(standingInput)), standingInput);
    if (standing.outcome !== 'succeeded') throw new Error('scale standing rating failed');
    const rated = await joinedRated();
    expect(rated.population).toBe(existingPopulation + 103);
    expect(rated.ratingPopulation).toBe(2);
    expect(rated.results).toMatchObject([{ work: nextWork,
      classification: { decision: localDecision, source: 'local' },
      rating: { count: 1, sum: 9 } }]);
    expect(rated.results.some(row => row.work === lateWork)).toBe(false);
    const joinedAuthorStart = fuseki.joinedQueries;
    expect((await joinedRated(phrase, 'en', actor)).results.map(row => row.work))
      .toEqual([nextWork]);
    expect(fuseki.joinedQueries - joinedAuthorStart).toBe(1);
    expect((await joinedRated(phrase, 'en', otherAuthor)).total).toBe(0);

    const chinesePhrase = '山河书页';
    const chineseA = await addWork(103, 'zh', `${chinesePhrase} 甲卷`);
    const chineseB = await addWork(104, 'zh', `${chinesePhrase} 乙卷`);
    const chineseUnscoped = await addWork(105, 'zh', `${chinesePhrase} 丙卷`);
    await decide(chineseA, { kind: 'global' }, 'accepted');
    const chineseDecisionA = await decide(chineseA,
      { kind: 'realm-classification', id: space.realm }, 'accepted');
    const chineseDecisionB = await decide(chineseB,
      { kind: 'realm-classification', id: space.realm }, 'accepted');
    for (const [work, value] of [[chineseA, 9], [chineseB, 8]] as const) {
      const observation = { context: ratingContext.context, work,
        mainVersion: mainByWork.get(work)!, expectedRevisionHead: null,
        value, actingSubject: actor };
      const result = await setStandingRating(env,
        admission(`rating:observe:${ratingContext.context}`, 'rating.observation.set',
          standingRatingDigest(observation)), observation);
      expect(result.outcome).toBe('succeeded');
    }
    const beforeRepeated = await joinedRated(chinesePhrase, 'zh');
    expect(beforeRepeated.total).toBe(2);
    expect(beforeRepeated.ratingPopulation).toBe(4);
    const firstByWork = new Map(beforeRepeated.results.map(row => [row.work, row]));
    expect(firstByWork.get(chineseA)?.rating).toMatchObject({ count: 1, sum: 9 });
    expect(firstByWork.get(chineseB)?.rating).toMatchObject({ count: 1, sum: 8 });
    expect(new Set(beforeRepeated.results.map(row => row.matchUnit)).size).toBe(2);
    async function ratedPage(continuation?: SearchContinuation) {
      return app.handle(new Request('http://main.local/v1/queries/page', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-realm-classified-rated-phrase-page-v1',
          context: { kind: 'realm-local', id: space.realm }, phrase: chinesePhrase,
          language: 'zh', sense, ratingContext: ratingContext.context,
          minimumMeanTimes10: 80, pageSize: 1, continuation }),
      }));
    }
    const beforeRepeatedPageResponse = await ratedPage();
    expect(beforeRepeatedPageResponse.status).toBe(200);
    const beforeRepeatedPage = await beforeRepeatedPageResponse.json() as {
      next: SearchContinuation | null };
    expect(beforeRepeatedPage.next).not.toBeNull();
    const secondRater = ID + randomUUID();
    const secondObservation = { context: ratingContext.context, work: chineseA,
      mainVersion: mainByWork.get(chineseA)!, expectedRevisionHead: null,
      value: 7, actingSubject: secondRater };
    const secondRating = await setStandingRating(env,
      admission(`rating:observe:${ratingContext.context}`, 'rating.observation.set',
        standingRatingDigest(secondObservation), secondRater), secondObservation);
    expect(secondRating.outcome).toBe('succeeded');
    const staleRatedPage = await ratedPage(beforeRepeatedPage.next!);
    expect(staleRatedPage.status).toBe(409);
    expect(await staleRatedPage.json()).toMatchObject({ code: 'search_restart_required' });
    // The real text hit joins two current standing-rating paths for A and one for B.
    const repeatedPaths = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
      PREFIX text: <http://jena.apache.org/text#>
      SELECT ?unit ?observation ?nativeScore WHERE {
        VALUES ?work { ${iri(chineseA)} ${iri(chineseB)} }
        GRAPH <urn:rezics:search:public> {
          (?unit ?nativeScore) text:query (rv:searchBody ${lit(`"${chinesePhrase}"`)} 513) .
          ?unit a rv:MatchUnit ; rv:work ?work ; rv:mainVersion ?main .
        }
        GRAPH <urn:rezics:graph:current> {
          ?observation a rv:RatingObservation ;
            rv:ratingContext ${iri(ratingContext.context)} ;
            rv:targetMainVersion ?main ; rv:observationHead ?head .
        }
        GRAPH <urn:rezics:graph:revisions> {
          ?head a rv:RatingObservationRevision ; rv:ratingAvailability rv:Available ;
            rv:ratingValue ?value .
        }
      }`);
    const pathRows = repeatedPaths.results?.bindings ?? [];
    const pathsByUnit = new Map<string, typeof pathRows>();
    for (const row of pathRows) {
      const unit = row.unit?.value;
      if (!unit || !row.observation || !row.nativeScore) throw new Error('rating path is incomplete');
      pathsByUnit.set(unit, [...(pathsByUnit.get(unit) ?? []), row]);
    }
    expect(pathsByUnit.size).toBe(2);
    expect(pathsByUnit.get(firstByWork.get(chineseA)!.matchUnit)).toHaveLength(2);
    expect(pathsByUnit.get(firstByWork.get(chineseB)!.matchUnit)).toHaveLength(1);
    expect(new Set(pathsByUnit.get(firstByWork.get(chineseA)!.matchUnit)!
      .map(row => row.observation!.value)).size).toBe(2);
    const joinedBefore = fuseki.joinedQueries;
    const chineseRated = await joinedRated(chinesePhrase, 'zh');
    expect(fuseki.joinedQueries - joinedBefore).toBe(1);
    expect(chineseRated.total).toBe(2);
    expect(chineseRated.ratingPopulation).toBe(5);
    expect(new Set(chineseRated.results.map(row => row.work))).toEqual(new Set([chineseA, chineseB]));
    expect(chineseRated.results.every(row => row.work !== chineseUnscoped)).toBe(true);
    expect(new Set(chineseRated.results.map(row => row.matchUnit)).size).toBe(2);
    expect(new Set(chineseRated.results.map(row => row.classification.decision)))
      .toEqual(new Set([chineseDecisionA, chineseDecisionB]));
    expect(chineseRated.results.every(row => row.classification.source === 'local')).toBe(true);
    const ratingByWork = new Map(chineseRated.results.map(row => [row.work, row.rating]));
    expect(ratingByWork.get(chineseA)).toMatchObject({ count: 2, sum: 16 });
    expect(ratingByWork.get(chineseB)).toMatchObject({ count: 1, sum: 8 });
    for (const row of chineseRated.results) {
      expect(row.score).toBe(firstByWork.get(row.work)?.score);
      expect(pathsByUnit.get(row.matchUnit)?.every(path =>
        Number(path.nativeScore!.value) === row.score)).toBe(true);
    }
    expect(chineseRated.results).toEqual([...chineseRated.results].sort((left, right) =>
      right.score - left.score || left.mainVersion.localeCompare(right.mainVersion)));
    const firstRatedResponse = await ratedPage();
    expect(firstRatedResponse.status).toBe(200);
    const firstRated = await firstRatedResponse.json() as {
      relationComplete: boolean; total: number; ratingPopulation: number;
      results: Array<{ work: string }>; next: SearchContinuation | null };
    expect(firstRated).toMatchObject({ relationComplete: true, total: 2,
      ratingPopulation: 5 });
    const secondRatedResponse = await ratedPage(firstRated.next!);
    expect(secondRatedResponse.status).toBe(200);
    const secondRated = await secondRatedResponse.json() as typeof firstRated;
    expect(secondRated.next).toBeNull();
    expect([...firstRated.results, ...secondRated.results].map(row => row.work))
      .toEqual(chineseRated.results.map(row => row.work));
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 300_000);
