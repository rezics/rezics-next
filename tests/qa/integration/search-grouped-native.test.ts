import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessPolicyOwner } from '../../../services/main/src/modules/access/policy-owner.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { AccessJudgments } from '../../../services/main/src/modules/judgment/access.ts';
import { createRatingContext, ratingContextDigest }
  from '../../../services/main/src/modules/rating/context.ts';
import { setStandingRating, standingRatingDigest }
  from '../../../services/main/src/modules/rating/observation.ts';
import { queryPublicRealmPhrase } from '../../../services/main/src/modules/work/search-public.ts';
import { selectMainDefault, mainSelectionDigest }
  from '../../../services/main/src/modules/work/select-main.ts';
import { searchRoutes } from '../../../services/main/src/routes/search.ts';
import { contextFixture, nativeId } from './context-fixture.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

async function groupedFixture() {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated QA integration tier');
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  try {
    const fixture = await contextFixture({ ...Bun.env,
      ACCOUNT_DATABASE_URL: databases.urls.account,
      ACCESS_DATABASE_URL: databases.urls.access } as Record<string, string>);
    return { ...fixture, close: async () => {
      try { await fixture.close(); } finally { await databases.close(); }
    } };
  } catch (error) { await databases.close(); throw error; }
}

test('SEARCH01/SEARCH04/SEARCH10: public grouped route binds one lead and counts admitted facts at explicit grains', async () => {
  const f = await groupedFixture();
  try {
    const phrase = '山河书页';
    const realm = await f.realm('Grouped search');
    const work = await f.work('Grouped Work');
    const draftInput = { work: work.work!, language: 'zh', body: `${phrase} selected body`,
      actingSubject: f.actorA };
    const draft = await activateTextContribution(f.env,
      f.admission(`contribution:create:${work.work}`, 'contribution.create',
        textContributionDigest(draftInput)), draftInput);
    if (!draft.contribution || !draft.draftRevision) throw new Error('draft not created');
    const publicationInput = { contribution: draft.contribution,
      expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
      rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
      actingSubject: f.actorA };
    const publication = await publishTextContribution(f.env,
      f.admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publicationInput)), publicationInput);
    if (!publication.publicationDecision) throw new Error('publication not created');
    const selectionInput = { context: { kind: 'main-version-default' as const, id: work.mainVersion! },
      work: work.work!, contribution: draft.contribution,
      publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: f.actorA };
    const selection = await selectMainDefault(f.env,
      f.admission(`publication:select:${work.mainVersion}`, 'publication.select',
        mainSelectionDigest(selectionInput)), selectionInput);
    if (selection.outcome !== 'succeeded') throw new Error('selection failed');

    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('relation:create:root', 'relation.change');
    await f.grant('context:create:root', 'context.create');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const semantic = async (state: object) => f.json<{ component: string; revision: string }>(
      await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
        actingSubject: f.actorA, expectedHead: null, state }), 201);
    const resource = async (type = 'https://schema.org/Person') => {
      const result = await semantic({ component: 'resource', types: [type], properties: [] });
      await f.grant(`semantic:read:${result.component}`, 'semantic.read');
      return result.component;
    };
    const lead = await resource(), red = await resource(), female = await resource(), blue = await resource();
    const green = await resource();
    const supporting = await resource();
    // Keep the three-coordinate matching cases, using actual frame coordinates
    // rather than Persons that Statement applicability cannot carry.
    const coordinate = () => resource('https://rezics.com/vocab/NarrativeContinuity');
    const scope = [await coordinate(), await coordinate(), await coordinate()];
    const alternatives = [await coordinate(), await coordinate(), await coordinate()];
    const relation = await semantic({ component: 'definition', kind: 'relation', lifecycle: 'active',
      successor: null, roles: [
        { key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'lead', minParticipants: 1, maxParticipants: 1, ordered: false },
      ] });
    await f.grant(`work:read:${work.work}`, 'work.read');
    const makeOccurrence = async (participant: string, applicability: string[]) => {
      const created = await f.json<{ occurrence: string }>(await f.call('POST', '/v1/relations/changes', {
        profile: 'relation-change-v1', actingSubject: f.actorA, expectedHead: null,
        definition: relation.revision, applicability, participations: [
          { role: 'work', participant: { kind: 'resource', ref: work.work } },
          { role: 'lead', participant: { kind: 'resource', ref: participant } },
        ] }), 201);
      await f.grant(`semantic:read:${created.occurrence}`, 'semantic.read');
      return created.occurrence;
    };
    const occurrence = await makeOccurrence(lead, scope);
    const overlappingOccurrence = await makeOccurrence(lead, scope);
    await makeOccurrence(supporting, scope);
    const hair = 'https://rezics.com/vocab/hairColor';
    const gender = 'https://rezics.com/vocab/gender';
    const hairRelation = 'https://rezics.com/definition/hair-color-v1';
    const genderRelation = 'https://rezics.com/definition/gender-v1';
    const hairDefinition = nativeId(), genderDefinition = nativeId(), blueDefinition = nativeId();
    const greenDefinition = nativeId();
    const context = await f.json<{ context: string; semanticRevision: string }>(await f.call('POST',
      '/v1/contexts', { profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
        entries: [
          { target: red, relation: hair, state: 'defined', definition: hairDefinition, applicability: [] },
          { target: blue, relation: hair, state: 'defined', definition: blueDefinition, applicability: [] },
          { target: green, relation: hair, state: 'defined', definition: greenDefinition, applicability: [] },
          { target: female, relation: gender, state: 'defined', definition: genderDefinition, applicability: [] },
        ], actingSubject: f.actorA }), 201);
    const statement = async (subject: string, predicate: string, definition: string,
      value: string, applicability = scope, visible = true) => {
      const written = await f.json<{ statement: string }>(await f.call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject,
        predicate, relationDefinition: definition, value: { kind: 'resource', iri: value },
        applicability, interpretation: { kind: 'explicit', context: context.context,
          semanticRevision: context.semanticRevision }, evidence: [], actingSubject: f.actorA }), 201);
      const decided = await f.json<{ decision: string }>(await f.call('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement: written.statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null,
        outcome: 'accepted', actingSubject: f.actorA }), 201);
      decisionHeads.set(written.statement, decided.decision);
      if (visible) await f.accessPool.query(`INSERT INTO access.judgment_aggregate
        (statement, context_key, spoiler_none) VALUES ($1, 'global', 8)`, [written.statement]);
      return written.statement;
    };
    const decisionHeads = new Map<string, string>();
    const femaleStatement = await statement(lead, gender, genderRelation, female);
    const redStatement = await statement(lead, hair, hairRelation, red);
    const secondRedStatement = await statement(lead, hair, hairRelation, red);
    await statement(lead, hair, hairRelation, blue);
    await statement(lead, hair, hairRelation, green, scope, false);
    await statement(supporting, hair, hairRelation, red);
    for (let index = 0; index < 3; index++) {
      const other = await resource();
      const mismatched = [...scope];
      mismatched[index] = alternatives[index]!;
      await makeOccurrence(other, mismatched);
      await statement(other, gender, genderRelation, female);
      await statement(other, hair, hairRelation, red);
    }
    const access = new AccessAdmissionRegistry(f.accessPool);
    access.configureBaseline(f.env.fuseki);
    const app = searchRoutes(f.env.fuseki, { environment: f.env,
      access,
      account: f.account.verifier, judgments: new AccessJudgments(f.accessPool),
      accessPolicy: new AccessPolicyOwner(f.accessPool) } as Parameters<typeof searchRoutes>[1]);
    const body = { profile: 'public-grouped-statement-phrase-v1', actingSubject: f.actorA,
      context: { kind: 'realm-local', id: realm.realm }, phrase, language: 'zh',
      relation: { definition: relation.revision, workRole: 'work', participantRole: 'lead' },
      conditions: [
        { predicate: gender, relationDefinition: genderRelation, value: female,
          context: context.context, semanticRevision: context.semanticRevision, applicability: scope },
        { predicate: hair, relationDefinition: hairRelation, value: red,
          context: context.context, semanticRevision: context.semanticRevision, applicability: scope },
      ], countGrain: 'work' };
    const query = async (override: object = {}) => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`,
        'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...override }),
    }));
    const nativeFuseki = f.env.fuseki;
    let statementBatches = 0;
    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof nativeFuseki.query>) => {
        if (args[0].includes('VALUES ?statement {')) statementBatches++;
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof nativeFuseki;
    let firstResponse: Response;
    try { firstResponse = await query(); }
    finally { f.env.fuseki = nativeFuseki; }
    expect(statementBatches).toBe(1);
    const first = await f.json<{ total: number; groupGeneration: string;
      results: Array<{ work: string; participant: string; occurrence: string; score: number;
        facts: Array<{ supportingStatements: string[] }> }>; facets: Array<{ mode: string }> }>(
      firstResponse, 200);
    expect(first.total).toBe(1);
    expect(first.results).toHaveLength(2);
    expect(first.results.map(result => result.occurrence).sort())
      .toEqual([occurrence, overlappingOccurrence].sort());
    for (const result of first.results) {
      expect(result).toMatchObject({ work: work.work, participant: lead });
      expect(result.facts.flatMap(fact => fact.supportingStatements).sort())
        .toEqual([femaleStatement, redStatement, secondRedStatement].sort());
    }
    expect(first.facets).toHaveLength(2);
    expect(first.facets.map(facet => facet.mode)).toEqual(['fully-filtered', 'fully-filtered']);
    const selfFacet = await f.json<{ total: number; facets: Array<{ values: Array<{
      value: string; count: number }> }> }>(await query({ facetMode: 'self-filter-excluding' }), 200);
    expect(selfFacet.total).toBe(1);
    expect(selfFacet.facets[1]?.values).toEqual([{ value: red, count: 1 }, { value: blue, count: 1 }]
      .sort((left, right) => left.value.localeCompare(right.value)));
    const occurrences = await f.json<{ total: number }>(await query({ countGrain: 'occurrence' }), 200);
    expect(occurrences.total).toBe(2);
    const facts = await f.json<{ total: number }>(await query({ countGrain: 'qualifiedFact' }), 200);
    expect(facts.total).toBe(2);
    const supports = await f.json<{ total: number }>(await query({ countGrain: 'supportingStatement' }), 200);
    expect(supports.total).toBe(3);
    const ratingInput = { realm: realm.realm, question: 'Grouped quality', actingSubject: f.actorA };
    const ratingContext = await createRatingContext(f.env,
      f.admission(`rating:context:${realm.realm}`, 'rating.context.create',
        ratingContextDigest(ratingInput)), ratingInput);
    if (ratingContext.outcome !== 'succeeded' || !ratingContext.context) {
      throw new Error('rating context not created');
    }
    for (const [actor, principal, value] of [
      [f.actorA, f.principalA, 9], [f.actorB, f.principalB, 7],
    ] as const) {
      const input = { context: ratingContext.context, work: work.work!,
        mainVersion: work.mainVersion!, expectedRevisionHead: null,
        value, actingSubject: actor };
      const admission = { ...f.admission(`rating:observe:${ratingContext.context}`,
        'rating.observation.set', standingRatingDigest(input)),
      actingSubject: actor, principalId: principal };
      const rated = await setStandingRating(f.env, admission, input);
      expect(rated.outcome).toBe('succeeded');
    }
    let joinedRequests = 0;
    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof nativeFuseki.query>) => {
        if (args[0].includes('text:query') && args[0].includes('?ratingPopulation')
          && args[0].includes('?occurrence')) joinedRequests++;
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof nativeFuseki;
    let joinedResponse: Response;
    try { joinedResponse = await query({ rating: { context: ratingContext.context,
      minimumMeanTimes10: 80 } }); }
    finally { f.env.fuseki = nativeFuseki; }
    const joined = await f.json<{ total: number; ratingPopulation: number;
      results: Array<{ occurrence: string; score: number; rating: { count: number; sum: number } }> }>(
      joinedResponse, 200);
    expect(joinedRequests).toBe(1);
    expect(joined).toMatchObject({ total: 1, ratingPopulation: 2 });
    expect(joined.results).toHaveLength(2);
    expect(joined.results.map(result => result.occurrence).sort())
      .toEqual([occurrence, overlappingOccurrence].sort());
    expect(joined.results.every(result => result.score === first.results[0]?.score)).toBe(true);
    expect(joined.results.every(result => result.rating.count === 2 && result.rating.sum === 16))
      .toBe(true);
    const tooHigh = await f.json<{ total: number; results: unknown[] }>(await query({ rating: {
      context: ratingContext.context, minimumMeanTimes10: 90 }, }), 200);
    expect(tooHigh).toMatchObject({ total: 0, results: [] });
    const wrong = await f.json<{ total: number; results: unknown[] }>(await query({ conditions: [
      body.conditions[0], { ...body.conditions[1], value: green },
    ] }), 200);
    expect(wrong).toMatchObject({ total: 0, results: [] });
    const noBodyPhrase = `absent${randomUUID().replaceAll('-', '')}`;
    const noBody = await f.json<{ total: number; results: unknown[]; groupGeneration: string }>(
      await query({ phrase: noBodyPhrase }), 200);
    expect(noBody).toMatchObject({ total: 0, results: [] });

    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof nativeFuseki.query>) =>
        args[0].includes('VALUES ?statement {')
          ? { results: { bindings: [] } } : target.query(...args);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof nativeFuseki;
    let missingSupport: Response;
    try { missingSupport = await query(); }
    finally { f.env.fuseki = nativeFuseki; }
    expect(missingSupport.status).toBe(503);
    expect(await missingSupport.json()).toMatchObject({ code: 'query_unavailable' });

    f.faultNextContextChainRead(context.semanticRevision);
    const incomplete = await query();
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toMatchObject({ code: 'query_unavailable' });

    await f.grant(`context:change:${context.context}`, 'context.change');
    const revised = await f.json<{ semanticRevision: string }>(await f.call('POST',
      `/v1/contexts/${context.context.split('/').at(-1)}/semantic-revisions`, {
        profile: 'context-v1', expectedSemanticHead: context.semanticRevision,
        base: null,
        entries: [{ target: red, relation: hair, state: 'defined', definition: nativeId(),
          applicability: [] },
        { target: blue, relation: hair, state: 'defined', definition: blueDefinition,
          applicability: [] },
        { target: green, relation: hair, state: 'defined', definition: greenDefinition,
          applicability: [] },
        { target: female, relation: gender, state: 'defined', definition: genderDefinition,
          applicability: [] }], actingSubject: f.actorA }), 201);
    const oldPin = await f.json<{ total: number; groupGeneration: string }>(await query(), 200);
    expect(oldPin.total).toBe(1);
    expect(oldPin.groupGeneration).toBe(first.groupGeneration);
    const emptyOldPin = await f.json<{ groupGeneration: string }>(
      await query({ phrase: noBodyPhrase }), 200);
    expect(emptyOldPin.groupGeneration).toBe(noBody.groupGeneration);
    const newPin = await f.json<{ total: number }>(await query({ conditions: [
      body.conditions[0], { ...body.conditions[1], semanticRevision: revised.semanticRevision },
    ] }), 200);
    expect(newPin.total).toBe(0);

    const reject = await f.json<{ decision: string }>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: redStatement },
      acceptance: { kind: 'global' }, expectedDecisionHead: decisionHeads.get(redStatement),
      outcome: 'rejected', actingSubject: f.actorA }), 201);
    const rejected = await f.json<{ total: number; groupGeneration: string }>(await query(), 200);
    expect(rejected.total).toBe(1);
    expect(rejected.groupGeneration).not.toBe(first.groupGeneration);
    expect((await f.json<{ total: number }>(await query({ countGrain: 'supportingStatement' }), 200))
      .total).toBe(2);
    const accept = await f.json<{ decision: string }>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: redStatement },
      acceptance: { kind: 'global' }, expectedDecisionHead: reject.decision,
      outcome: 'accepted', actingSubject: f.actorA }), 201);
    expect(accept.decision).not.toBe(reject.decision);
    expect((await f.json<{ total: number }>(await query({ countGrain: 'supportingStatement' }), 200))
      .total).toBe(3);

    await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw');
    const read = await f.json<{ revision: string }>(await f.call('GET',
      `/v1/statements/${redStatement.split('/').at(-1)}`), 200);
    await f.json(await f.call('POST', `/v1/statements/${redStatement.split('/').at(-1)}/withdrawals`, {
      profile: 'statement-v1', speaker: { kind: 'personal' }, expectedHead: read.revision,
      actingSubject: f.actorA }), 201);
    expect((await f.json<{ total: number }>(await query({ countGrain: 'supportingStatement' }), 200))
      .total).toBe(2);
    const secondRead = await f.json<{ revision: string }>(await f.call('GET',
      `/v1/statements/${secondRedStatement.split('/').at(-1)}`), 200);
    await f.json(await f.call('POST',
      `/v1/statements/${secondRedStatement.split('/').at(-1)}/withdrawals`, {
        profile: 'statement-v1', speaker: { kind: 'personal' }, expectedHead: secondRead.revision,
        actingSubject: f.actorA }), 201);
    expect((await f.json<{ total: number }>(await query(), 200)).total).toBe(0);

    for (let index = 0; index < 8; index++) {
      const extra = await resource();
      await makeOccurrence(extra, scope);
      await statement(extra, hair, hairRelation, red);
    }
    const overflow = await query();
    expect(overflow.status).toBe(422);
    expect(await overflow.json()).toMatchObject({ code: 'query_budget_exceeded' });
    const ratedOverflow = await query({ rating: { context: ratingContext.context,
      minimumMeanTimes10: 80 } });
    expect(ratedOverflow.status).toBe(422);
    expect(await ratedOverflow.json()).toMatchObject({ code: 'query_budget_exceeded' });
  } finally { await f.close(); }
}, 120_000);

test('SEARCH01/SEARCH04: one Chinese text-rating-Statement join keeps overlapping paths and Context criteria exact', async () => {
  const f = await groupedFixture();
  try {
    const realm = await f.realm('Joined grouped search');
    const phrase = '山河书页';
    const selectedWork = async (label: string) => {
      const work = await f.work(label);
      const draftInput = { work: work.work!, language: 'zh', body: `${phrase} ${label}`,
        actingSubject: f.actorA };
      const draft = await activateTextContribution(f.env,
        f.admission(`contribution:create:${work.work}`, 'contribution.create',
          textContributionDigest(draftInput)), draftInput);
      if (!draft.contribution || !draft.draftRevision) throw new Error('draft not created');
      const publicationInput = { contribution: draft.contribution,
        expectedDraftHead: draft.draftRevision, expectedPublicationHead: null,
        rightsBasis: 'original-contribution' as const, disclosure: 'public' as const,
        actingSubject: f.actorA };
      const publication = await publishTextContribution(f.env,
        f.admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
          textPublicationDigest(publicationInput)), publicationInput);
      if (!publication.publicationDecision) throw new Error('publication not created');
      const selectionInput = { context: { kind: 'main-version-default' as const, id: work.mainVersion! },
        work: work.work!, contribution: draft.contribution,
        publicationDecision: publication.publicationDecision, expectedSelectionHead: null,
        selectionBasis: 'main-maintainer' as const, actingSubject: f.actorA };
      const selected = await selectMainDefault(f.env,
        f.admission(`publication:select:${work.mainVersion}`, 'publication.select',
          mainSelectionDigest(selectionInput)), selectionInput);
      if (selected.outcome !== 'succeeded' || !selected.matchUnit) {
        throw new Error('selection not created');
      }
      await f.grant(`work:read:${work.work}`, 'work.read');
      return { work: work.work!, main: work.mainVersion!, matchUnit: selected.matchUnit };
    };
    const firstWork = await selectedWork('First Chinese unit');
    const secondWork = await selectedWork('Second Chinese unit');
    const ungroupedWork = await selectedWork('Ungrouped Chinese unit');
    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('relation:create:root', 'relation.change');
    await f.grant('context:create:root', 'context.create');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorB}`, 'statement.record', f.actorB, f.principalB);
    await f.globalAcceptance();
    await f.grant('classification:decide:global', 'statement.decide');
    const semantic = async (state: object) => f.json<{ component: string; revision: string }>(
      await f.call('POST', '/v1/semantic/changes', { profile: 'semantic-change-v1',
        actingSubject: f.actorA, expectedHead: null, state }), 201);
    const resource = async () => {
      const result = await semantic({ component: 'resource', types: ['https://schema.org/Person'],
        properties: [] });
      await f.grant(`semantic:read:${result.component}`, 'semantic.read');
      return result.component;
    };
    const firstLead = await resource(), secondLead = await resource();
    const red = await resource(), female = await resource();
    const relation = await semantic({ component: 'definition', kind: 'relation', lifecycle: 'active',
      successor: null, roles: [
        { key: 'work', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'lead', minParticipants: 1, maxParticipants: 1, ordered: false },
      ] });
    const occurrence = async (work: string, participant: string) => {
      const result = await f.json<{ occurrence: string }>(await f.call('POST', '/v1/relations/changes', {
        profile: 'relation-change-v1', actingSubject: f.actorA, expectedHead: null,
        definition: relation.revision, applicability: [], participations: [
          { role: 'work', participant: { kind: 'resource', ref: work } },
          { role: 'lead', participant: { kind: 'resource', ref: participant } },
        ] }), 201);
      await f.grant(`semantic:read:${result.occurrence}`, 'semantic.read');
      return result.occurrence;
    };
    const firstPath = await occurrence(firstWork.work, firstLead);
    const secondPath = await occurrence(firstWork.work, firstLead);
    const thirdPath = await occurrence(secondWork.work, secondLead);
    const hair = 'https://rezics.com/vocab/hairColor';
    const gender = 'https://rezics.com/vocab/gender';
    const hairRelation = 'https://rezics.com/definition/hair-color-v1';
    const genderRelation = 'https://rezics.com/definition/gender-v1';
    const sharedDefinition = nativeId(), separateDefinition = nativeId(), femaleDefinition = nativeId();
    const context = async (hairDefinition: string) => f.json<{
      context: string; semanticRevision: string }>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [
        { target: red, relation: hair, state: 'defined', definition: hairDefinition, applicability: [] },
        { target: female, relation: gender, state: 'defined', definition: femaleDefinition,
          applicability: [] },
      ], actingSubject: f.actorA }), 201);
    const contextA = await context(sharedDefinition);
    const contextB = await context(sharedDefinition);
    const contextC = await context(separateDefinition);
    await f.grant(`semantic:read:${firstLead}`, 'semantic.read', f.actorB, f.principalB);
    await f.grant(`semantic:read:${red}`, 'semantic.read', f.actorB, f.principalB);
    const statement = async (subject: string, predicate: string, definition: string,
      value: string, interpretation: typeof contextA, visible = true,
      speaker = f.actorA) => {
      const written = await f.json<{ statement: string }>(await f.call('POST', '/v1/statements', {
        profile: 'statement-v1', speaker: { kind: 'personal' }, subject,
        predicate, relationDefinition: definition, value: { kind: 'resource', iri: value },
        applicability: [], interpretation: { kind: 'explicit', context: interpretation.context,
          semanticRevision: interpretation.semanticRevision }, evidence: [], actingSubject: speaker },
      randomUUID(), speaker === f.actorB ? f.account.tokenB : f.account.tokenA), 201);
      await f.json(await f.call('POST', '/v1/statement-decisions', {
        profile: 'statement-decision-v1', target: { kind: 'statement', statement: written.statement },
        acceptance: { kind: 'global' }, expectedDecisionHead: null,
        outcome: 'accepted', actingSubject: f.actorA }), 201);
      if (visible) await f.accessPool.query(`INSERT INTO access.judgment_aggregate
        (statement, context_key, spoiler_none) VALUES ($1, 'global', 8)`, [written.statement]);
      return written.statement;
    };
    const firstFemale = await statement(firstLead, gender, genderRelation, female, contextA);
    const firstRedA = await statement(firstLead, hair, hairRelation, red, contextA);
    const firstRedB = await statement(firstLead, hair, hairRelation, red, contextB, false, f.actorB);
    const firstRedC = await statement(firstLead, hair, hairRelation, red, contextC);
    await statement(secondLead, gender, genderRelation, female, contextA);
    await statement(secondLead, hair, hairRelation, red, contextA);
    const ratingInput = { realm: realm.realm, question: 'Joined group quality', actingSubject: f.actorA };
    const ratingContext = await createRatingContext(f.env,
      f.admission(`rating:context:${realm.realm}`, 'rating.context.create',
        ratingContextDigest(ratingInput)), ratingInput);
    if (ratingContext.outcome !== 'succeeded' || !ratingContext.context) {
      throw new Error('rating context not created');
    }
    for (const [selected, actor, principal, value] of [
      [firstWork, f.actorA, f.principalA, 9], [firstWork, f.actorB, f.principalB, 7],
      [secondWork, f.actorA, f.principalA, 8], [ungroupedWork, f.actorA, f.principalA, 10],
    ] as const) {
      const input = { context: ratingContext.context, work: selected.work,
        mainVersion: selected.main, expectedRevisionHead: null, value, actingSubject: actor };
      const admission = { ...f.admission(`rating:observe:${ratingContext.context}`,
        'rating.observation.set', standingRatingDigest(input)),
      actingSubject: actor, principalId: principal };
      expect((await setStandingRating(f.env, admission, input)).outcome).toBe('succeeded');
    }
    const access = new AccessAdmissionRegistry(f.accessPool);
    access.configureBaseline(f.env.fuseki);
    const app = searchRoutes(f.env.fuseki, { environment: f.env,
      access, account: f.account.verifier,
      judgments: new AccessJudgments(f.accessPool), accessPolicy: new AccessPolicyOwner(f.accessPool),
    } as Parameters<typeof searchRoutes>[1]);
    const body = { profile: 'public-grouped-statement-phrase-v1', actingSubject: f.actorA,
      context: { kind: 'realm-local', id: realm.realm }, phrase, language: 'zh',
      relation: { definition: relation.revision, workRole: 'work', participantRole: 'lead' },
      conditions: [
        { predicate: gender, relationDefinition: genderRelation, value: female,
          context: contextA.context, semanticRevision: contextA.semanticRevision, applicability: [] },
        { predicate: hair, relationDefinition: hairRelation, value: red,
          context: contextB.context, semanticRevision: contextB.semanticRevision, applicability: [] },
      ], countGrain: 'work', rating: { context: ratingContext.context, minimumMeanTimes10: 80 } };
    const query = (override: object = {}) => app.handle(new Request('http://main.local/v1/queries', {
      method: 'POST', headers: { authorization: `Bearer ${f.account.tokenA}`,
        'content-type': 'application/json' }, body: JSON.stringify({ ...body, ...override }),
    }));
    const nativeFuseki = f.env.fuseki;
    let coreJoins = 0;
    f.env.fuseki = new Proxy(nativeFuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof nativeFuseki.query>) => {
        if (args[0].includes('text:query') && args[0].includes('?ratingPopulation')
          && args[0].includes('?occurrence')) coreJoins++;
        return target.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof nativeFuseki;
    let initialResponse: Response;
    try { initialResponse = await query(); }
    finally { f.env.fuseki = nativeFuseki; }
    const first = await f.json<{ total: number; ratingPopulation: number;
      results: Array<{ work: string; matchUnit: string; occurrence: string; score: number;
        rating: { count: number; sum: number }; facts: Array<{ predicate: string;
          meaningKey: string; supportingStatements: string[] }> }> }>(initialResponse, 200);
    expect(coreJoins).toBe(1);
    expect(first).toMatchObject({ total: 2, ratingPopulation: 4 });
    expect(first.results).toHaveLength(3);
    expect(new Set(first.results.map(row => row.work)))
      .toEqual(new Set([firstWork.work, secondWork.work]));
    expect(first.results.map(row => row.occurrence).sort())
      .toEqual([firstPath, secondPath, thirdPath].sort());
    expect(first.results.every(row => row.work !== ungroupedWork.work)).toBe(true);
    expect(first.results.filter(row => row.work === firstWork.work)
      .every(row => row.rating.count === 2 && row.rating.sum === 16)).toBe(true);
    expect(first.results.find(row => row.work === secondWork.work)?.rating)
      .toMatchObject({ count: 1, sum: 8 });
    const raw = await queryPublicRealmPhrase(f.env, { context: body.context, phrase, language: 'zh' });
    const rawScores = new Map(raw.results.map(row => [row.matchUnit, row.score]));
    expect(first.results.every(row => row.score === rawScores.get(row.matchUnit))).toBe(true);
    expect(first.results).toEqual([...first.results].sort((left, right) =>
      right.score - left.score || left.work.localeCompare(right.work)
      || left.occurrence.localeCompare(right.occurrence)));
    const unavailableRating = await query({ rating: { context: nativeId(),
      minimumMeanTimes10: 80 } });
    expect(unavailableRating.status).toBe(404);
    expect(await unavailableRating.json()).toMatchObject({ code: 'realm_unavailable' });
    const firstHair = first.results.find(row => row.work === firstWork.work)!.facts
      .find(fact => fact.predicate === hair)!;
    expect(firstHair.supportingStatements).toEqual([firstRedA]);
    expect(firstHair.supportingStatements).not.toContain(firstRedB);
    expect(firstHair.supportingStatements).not.toContain(firstRedC);
    await f.accessPool.query(`INSERT INTO access.judgment_aggregate
      (statement, context_key, spoiler_none) VALUES ($1, 'global', 8)
      ON CONFLICT (statement, context_key) DO UPDATE SET spoiler_none = 8`, [firstRedB]);
    const admitted = await f.json<typeof first>(await query(), 200);
    expect(admitted.total).toBe(2);
    const admittedHair = admitted.results.find(row => row.work === firstWork.work)!.facts
      .find(fact => fact.predicate === hair)!;
    expect(admittedHair.supportingStatements).toEqual([firstRedA, firstRedB].sort());
    expect(admittedHair.meaningKey).toBe(firstHair.meaningKey);
    expect(admitted.results.find(row => row.work === firstWork.work)!.facts
      .find(fact => fact.predicate === gender)?.supportingStatements).toEqual([firstFemale]);
    for (const [grain, count] of [['work', 2], ['participant', 2], ['occurrence', 3],
      ['qualifiedFact', 4], ['supportingStatement', 5]] as const) {
      expect((await f.json<{ total: number }>(await query({ countGrain: grain }), 200)).total)
        .toBe(count);
    }
    await f.grant(`classification:decide:${realm.realm}`, 'statement.decide');
    await f.json(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'statement', statement: firstRedB },
      acceptance: { kind: 'realm', realm: realm.realm }, expectedDecisionHead: null,
      outcome: 'rejected', actingSubject: f.actorA }), 201);
    const locallyNarrowed = await f.json<typeof first>(await query(), 200);
    expect(locallyNarrowed.total).toBe(2);
    expect(locallyNarrowed.results.find(row => row.work === firstWork.work)!.facts
      .find(fact => fact.predicate === hair)?.supportingStatements).toEqual([firstRedA]);
    const separate = await f.json<typeof first>(await query({ conditions: [body.conditions[0],
      { ...body.conditions[1], context: contextC.context,
        semanticRevision: contextC.semanticRevision }] }), 200);
    expect(separate.total).toBe(1);
    expect(separate.results).toHaveLength(2);
    const separateHair = separate.results[0]!.facts.find(fact => fact.predicate === hair)!;
    expect(separateHair.supportingStatements).toEqual([firstRedC]);
    expect(separateHair.meaningKey).not.toBe(admittedHair.meaningKey);
    const unsupportedUnion = await query({ broaderUnion: [contextB.context, contextC.context] });
    expect(unsupportedUnion.status).toBe(422);
  } finally { await f.close(); }
}, 120_000);
