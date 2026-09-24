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
import { activateMetadataWork, ID, metadataWorkRequestDigest,
  type WorkActivationEnvironment } from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';

const root = resolve(import.meta.dir, '../../..');

class CountingFusekiClient extends FusekiClient {
  inventories = 0;
  queryCalls = 0;
  healthCalls = 0;
  override async query(sparql: string, maxResponseBytes?: number): Promise<SparqlResult> {
    this.queryCalls++;
    if (sparql.includes('"body:*"')) this.inventories++;
    return super.query(sparql, maxResponseBytes);
  }
  override async commandHealth() {
    this.healthCalls++;
    return super.commandHealth();
  }
}

test('SEARCH02/SEARCH18: complete late language match survives a 101-unit native corpus', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH
    || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `search-scale-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const actor = ID + randomUUID();
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
  function admission(scope: string, action: string, requestDigest: string): RegisteredAdmission {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `scale-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  }
  async function addWork(index: number, language: string) {
    const title = `Search scale ${index} ${randomUUID()}`;
    const created = await activateMetadataWork(env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    const draftInput = { work: created.work, language,
      body: `${phrase} selected article ${index}`, actingSubject: actor };
    const draft = await activateTextContribution(env,
      admission(`contribution:create:${created.work}`, 'contribution.create',
        textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('scale Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: actor };
    const published = await publishTextContribution(env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publishInput)), publishInput);
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
  async function query(language: string | null) {
    const response = await app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'public-main-phrase-v1', phrase, language }),
    }));
    if (response.status !== 200) {
      throw new Error(`public scale query returned ${response.status}: ${await response.text()}`);
    }
    return response.json() as Promise<{ complete: boolean; population: number; total: number;
      results: Array<{ work: string }> }>;
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
    const nextWork = await addWork(102, 'en');
    const afterWrite = await query('en');
    expect(afterWrite.population).toBe(existingPopulation + 103);
    expect(afterWrite.total).toBe(2);
    expect(new Set(afterWrite.results.map(row => row.work))).toEqual(new Set([lateWork, nextWork]));
    expect(fuseki.inventories).toBe(2);

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
    expect((await classified(null)).results.map(row => row.work)).toEqual([lateWork]);

    const ratingInput = { realm: space.realm, question: 'Scale quality', actingSubject: actor };
    const ratingContext = await createRatingContext(env,
      admission(`rating:context:${space.realm}`, 'rating.context.create',
        ratingContextDigest(ratingInput)), ratingInput);
    if (ratingContext.outcome !== 'succeeded' || !ratingContext.context) {
      throw new Error('scale rating context failed');
    }
    async function joinedRated() {
      const response = await app.handle(new Request('http://main.local/v1/queries', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ profile: 'public-realm-classified-rated-phrase-v1',
          context: { kind: 'realm-local', id: space.realm }, phrase, language: 'en',
          sense, ratingContext: ratingContext.context,
          minimumMeanTimes10: 80 }),
      }));
      if (response.status !== 200) {
        throw new Error(`joined rated query returned ${response.status}: ${await response.text()}`);
      }
      return response.json() as Promise<{ total: number; population: number;
        ratingPopulation: number; results: Array<{ work: string;
          classification: { decision: string; source: string };
          rating: { count: number; sum: number } }> }>;
    }
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
    expect(rated.ratingPopulation).toBe(1);
    expect(rated.results).toMatchObject([{ work: nextWork,
      classification: { decision: localDecision, source: 'local' },
      rating: { count: 1, sum: 9 } }]);
  } finally {
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 300_000);
