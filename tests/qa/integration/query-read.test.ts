import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry, type RegisteredAdmission }
  from '../../../services/main/src/modules/access/admission.ts';
import { classificationDecisionDigest, classificationDecisionScope, setClassificationDecision }
  from '../../../services/main/src/modules/classification/decision.ts';
import { classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { createRealmSpace, spaceCreationDigest }
  from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, ID, metadataWorkRequestDigest, type WorkActivationEnvironment }
  from '../../../services/main/src/modules/work/activate.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { selectRealmLocal, realmSelectionDigest }
  from '../../../services/main/src/modules/work/select-realm.ts';
import { ZoneBrowseProjection } from '../../../services/main/src/modules/zone-browse/store.ts';

const root = resolve(import.meta.dir, '../../..');
const book = 'https://schema.org/Book';

test('QUERY01: Query type/language and Realm Context match admitted phrase reads; unsupported is typed', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `query-read-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const env: WorkActivationEnvironment = { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') };
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const relayPool = new Pool({ connectionString: Bun.env.ACCOUNT_RELAY_DATABASE_URL });
  const zoneBrowse = new ZoneBrowseProjection(accessPool, relayPool, env);
  const app = createMainApp(fuseki, { environment: env,
    zoneBrowse,
    account: { verify: async () => { throw new Error('public Query made an authority request'); } },
    access: new AccessAdmissionRegistry(accessPool) });
  const actor = ID + randomUUID();
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: randomUUID(), actingSubject: actor, scope, action,
      idempotencyKey: `query-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const send = (path: string, body: unknown) => app.handle(new Request(`http://main.local${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));
  try {
    const token = `query421${randomUUID().replaceAll('-', '')}`;
    const title = `Query Work ${token}`;
    const created = await activateMetadataWork(env, { title, semanticTypes: [book],
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title, [book])) });
    const draftInput = { work: created.work, language: 'en', body: `A searchable ${token} story`, actingSubject: actor };
    const draft = await activateTextContribution(env, admission(`contribution:create:${created.work}`,
      'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('Query Contribution draft failed');
    }
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: actor };
    const published = await publishTextContribution(env, admission(`contribution:publish:${draft.contribution}`,
      'contribution.publish', textPublicationDigest(publishInput)), publishInput);
    if (published.outcome !== 'succeeded' || !published.publicationDecision) {
      throw new Error('Query Contribution publication failed');
    }
    const selectedInput = { context: { kind: 'main-version-default' as const, id: created.mainVersion },
      work: created.work, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: actor };
    const selected = await selectMainDefault(env, admission(`publication:select:${created.mainVersion}`,
      'publication.select', mainSelectionDigest(selectedInput)), selectedInput);
    expect(selected.outcome).toBe('succeeded');

    const legacyBody = { profile: 'public-main-phrase-page-v1', phrase: token, language: 'en',
      includeTypes: [book], pageSize: 20 };
    const legacyResponse = await send('/v1/queries/page', legacyBody);
    expect(legacyResponse.status).toBe(200);
    const legacy = await legacyResponse.json() as { results: Array<{ work: string }> };
    const filter = { all: [{ facet: 'type', any: [book] }, { facet: 'language', any: ['en'] }] };
    const query = { context: 'global', scope: { kind: 'all' }, text: { phrase: token },
      filter, sort: 'relevance', page: { size: 20 } };
    const queryResponse = await send('/v1/query', query);
    expect(queryResponse.status).toBe(200);
    const result = await queryResponse.json() as { template: string;
      selection: { facetRefs: string[]; semanticRevisions: string[] };
      result: { results: Array<{ work: string }> } };
    expect(result.template).toBe('public-main-phrase-page-v1');
    expect(result.selection.facetRefs).toHaveLength(2);
    expect(result.selection.semanticRevisions).toEqual([]);
    expect(result.result.results.map(row => row.work)).toEqual(legacy.results.map(row => row.work));
    expect(result.result.results.map(row => row.work)).toContain(created.work);

    const realmInput = { name: `Query Realm ${randomUUID()}`, actingSubject: actor };
    const space = await createRealmSpace(env, admission('space:create:root', 'space.create',
      spaceCreationDigest(realmInput)), realmInput);
    if (space.outcome !== 'succeeded' || !space.realm) throw new Error('Query Realm creation failed');
    const adoptionInput = { context: { kind: 'realm-local' as const, id: space.realm },
      work: created.work, mainVersion: created.mainVersion, contribution: draft.contribution,
      publicationDecision: published.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'realm-manager-review' as const, actingSubject: actor };
    const adoption = await selectRealmLocal(env, admission(`publication:adopt:${space.realm}`,
      'publication.adopt', realmSelectionDigest(adoptionInput)), adoptionInput);
    expect(adoption.outcome).toBe('succeeded');
    const realmLegacy = await send('/v1/queries/page', { ...legacyBody,
      profile: 'public-realm-phrase-page-v1', context: { kind: 'realm-local', id: space.realm } });
    expect(realmLegacy.status).toBe(200);
    const realmQuery = await send('/v1/query', { ...query, context: { realm: space.realm } });
    expect(realmQuery.status).toBe(200);
    expect((await realmQuery.json() as { result: { results: unknown[] } }).result.results)
      .toEqual((await realmLegacy.json() as { results: unknown[] }).results);

    await zoneBrowse.backfill();
    const zoneQuery = await send('/v1/query', { context: { realm: space.realm },
      scope: { kind: 'realm', realm: space.realm }, sort: 'newest', page: { size: 20 },
      filter: { all: [{ facet: 'type', any: [book] }] } });
    expect(zoneQuery.status).toBe(200);
    const zoneResult = await zoneQuery.json() as { template: string;
      selection: { scope: { realm: string } };
      result: { items: Array<{ id: string }> } };
    expect(zoneResult.template).toBe('zone-browse-v1');
    expect(zoneResult.selection.scope.realm).toBe(space.realm);
    expect(zoneResult.result.items.map(item => item.id)).toContain(created.work);
    const zoneUrl = new URL(`/v1/realms/${space.realm.split('/').at(-1)}/modules/browse`, 'http://main.local');
    zoneUrl.searchParams.append('type', book);
    const zoneLegacy = await app.handle(new Request(zoneUrl));
    expect(zoneLegacy.status).toBe(200);
    expect(zoneResult.result.items.map(item => item.id)).toEqual(
      (await zoneLegacy.json() as { items: Array<{ id: string }> }).items.map(item => item.id));

    const define = async (label: string) => {
      const input = { label, actingSubject: actor };
      const result = await createClassificationProposition(env, admission('classification:define:global',
        'classification.proposition.define', classificationPropositionDigest(input)), input);
      if (result.outcome !== 'succeeded' || !result.definitions || !result.revision) {
        throw new Error('Query Concept definition failed');
      }
      return result;
    };
    const included = await define(`Query included ${randomUUID()}`);
    const excluded = await define(`Query excluded ${randomUUID()}`);
    const accept = async (sense: string) => {
      const input = { context: { kind: 'global' as const }, work: created.work,
        mainVersion: created.mainVersion, sense, expectedDecisionHead: null,
        outcome: 'accepted' as const, actingSubject: actor };
      const decision = await setClassificationDecision(env,
        admission(classificationDecisionScope(input.context), 'classification.decision.set',
          classificationDecisionDigest(input)), input);
      expect(decision.outcome).toBe('succeeded');
    };
    await accept(included.definitions!.sense);
    const conceptQuery = { ...query, filter: { all: [
      { facet: 'concept', any: [included.definitions!.concept],
        interpretation: { definition: included.revision } },
      { facet: 'concept', none: [excluded.definitions!.concept],
        interpretation: { definition: excluded.revision } },
    ] } };
    const includedResponse = await send('/v1/query', conceptQuery);
    expect(includedResponse.status).toBe(200);
    const positive = await includedResponse.json() as { template: string;
      selection: { semanticRevisions: string[] };
      result: { results: Array<{ work: string }> } };
    expect(positive.template).toBe('public-concept-set-phrase-v1');
    expect(positive.selection.semanticRevisions).toEqual([included.revision, excluded.revision]);
    expect(positive.result.results.map(row => row.work)).toContain(created.work);
    const current = await send('/v1/query', { ...query, filter: { all: [
      { facet: 'concept', any: [included.definitions!.concept] },
      { facet: 'concept', none: [excluded.definitions!.concept] },
    ] } });
    expect(current.status).toBe(200);
    const currentPage = await current.json() as { selection: { semanticRevisions: string[] };
      result: { results: Array<{ work: string }> } };
    expect(currentPage.selection.semanticRevisions).toEqual([included.revision, excluded.revision]);
    expect(currentPage.result.results.map(row => row.work)).toContain(created.work);
    const singleCurrent = await send('/v1/query', { ...query, filter: { all: [
      { facet: 'concept', any: [included.definitions!.concept] },
    ] } });
    expect(singleCurrent.status).toBe(200);
    expect((await singleCurrent.json() as { selection: { semanticRevisions: string[] } }).selection.semanticRevisions)
      .toEqual([included.revision]);
    const legacyIncluded = await send('/v1/queries', { profile: 'public-main-classified-phrase-v1',
      phrase: token, language: 'en', sense: included.definitions!.sense });
    expect(legacyIncluded.status).toBe(200);
    expect(positive.result.results.map(row => row.work)).toEqual(
      (await legacyIncluded.json() as { results: Array<{ work: string }> }).results.map(row => row.work));
    await accept(excluded.definitions!.sense);
    const excludedResponse = await send('/v1/query', conceptQuery);
    expect(excludedResponse.status).toBe(200);
    const negative = await excludedResponse.json() as { result: { results: Array<{ work: string }> } };
    expect(negative.result.results.map(row => row.work)).not.toContain(created.work);
    const legacyExcluded = await send('/v1/queries', { profile: 'public-main-classified-phrase-v1',
      phrase: token, language: 'en', sense: excluded.definitions!.sense });
    expect(legacyExcluded.status).toBe(200);
    expect((await legacyExcluded.json() as { results: Array<{ work: string }> }).results.map(row => row.work))
      .toContain(created.work);

    const refused = await send('/v1/query', { ...query,
      filter: { any: [{ facet: 'type', any: [book] }, { facet: 'type', none: [book] }] } });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ status: 422, code: 'unsupported_query_shape' });
  } finally {
    await relayPool.end();
    await accessPool.end();
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
