import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { classificationDecisionDigest, classificationDecisionScope, setClassificationDecision }
  from '../../../services/main/src/modules/classification/decision.ts';
import { classificationPropositionDigest, createClassificationProposition }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { activateTextContribution, textContributionDigest }
  from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest }
  from '../../../services/main/src/modules/contribution/publish.ts';
import { definitionStateRequest }
  from '../../../services/main/src/modules/context/definition-state.ts';
import { mainSelectionDigest, selectMainDefault }
  from '../../../services/main/src/modules/work/select-main.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { readMainOutboxEnvelope, readNextMainOutboxBatch }
  from '../../../services/main/src/modules/outbox/relay.ts';
import { contextFixture, nativeId, RV } from './context-fixture.ts';

type ContextWrite = { context: string; semanticRevision: string; replayed: boolean };
type SelectionWrite = { selection: string; selectionRevision: string; replayed: boolean };
type StatementWrite = { statement: string; meaningKey: string; revision: string; replayed: boolean };
type DecisionWrite = { decision: string; slot: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string } };
type Resolution = { result: { state: string; source?: string; decision?: string } };

test('CTX02/CTX09: v1 heads migrate exactly before the Statement decision fence retires the writer', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const work = await f.work('Migrated classification');
    const realm = await f.realm('Migration acceptance');
    const phrase = `migrationbeacon${randomUUID().replaceAll('-', '')}`;
    const draftInput = { work: work.work!, language: 'en', body: `${phrase} appears here`,
      actingSubject: f.actorA };
    const draft = await activateTextContribution(f.env,
      f.admission(`contribution:create:${work.work}`, 'contribution.create',
        textContributionDigest(draftInput)), draftInput);
    const publicationInput = { contribution: draft.contribution!, expectedDraftHead: draft.draftRevision!,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: f.actorA };
    const publication = await publishTextContribution(f.env,
      f.admission(`contribution:publish:${draft.contribution}`, 'contribution.publish',
        textPublicationDigest(publicationInput)), publicationInput);
    const selectionInput = { context: { kind: 'main-version-default' as const, id: work.mainVersion! },
      work: work.work!, contribution: draft.contribution!,
      publicationDecision: publication.publicationDecision!, expectedSelectionHead: null,
      selectionBasis: 'main-maintainer' as const, actingSubject: f.actorA };
    await selectMainDefault(f.env, f.admission(`publication:select:${work.mainVersion}`,
      'publication.select', mainSelectionDigest(selectionInput)), selectionInput);
    const propositionInput = { label: `Migrated ${randomUUID()}`, actingSubject: f.actorA };
    const proposition = await createClassificationProposition(f.env,
      f.admission('classification:define:global', 'classification.proposition.define',
        classificationPropositionDigest(propositionInput)), propositionInput);
    const sense = proposition.definitions!.sense;
    await f.grant('classification:decide:global', 'statement.decide');
    await f.json(await f.call('POST',
      `/v1/concepts/${proposition.definitions!.concept.split('/').at(-1)}/spoiler-hints`, {
        profile: 'concept-spoiler-hint-v1', context: { kind: 'global' },
        hint: 'not-spoiler', expectedGeneration: '0', actingSubject: f.actorA,
      }), 201);
    const decisionInput = { context: { kind: 'global' as const }, work: work.work!,
      mainVersion: work.mainVersion!, sense, expectedDecisionHead: null,
      outcome: 'accepted' as const, actingSubject: f.actorA };
    const old = await setClassificationDecision(f.env,
      f.admission(classificationDecisionScope(decisionInput.context), 'classification.decision.set',
        classificationDecisionDigest(decisionInput)), decisionInput);
    expect(old.outcome).toBe('succeeded');
    const legacyResolution = () => f.call('POST', '/v1/classification-resolutions', {
      profile: 'classification-resolution-v1', context: { kind: 'global' },
      work: work.work, mainVersion: work.mainVersion, sense });
    expect((await f.json<{ decision: string }>(await legacyResolution(), 200)).decision).toBe(old.decision);
    const search = async (body: object): Promise<Response> => {
      let response: Response;
      for (let attempt = 0; attempt < 12; attempt++) {
        response = await f.call('POST', '/v1/queries', body);
        if (response.status !== 503
          || (await response.clone().json() as { code?: string }).code !== 'search_index_unavailable') {
          return response;
        }
        await Bun.sleep(100);
      }
      return response!;
    };
    const classified = (kind: 'main' | 'realm') => search(kind === 'main'
      ? { profile: 'public-main-classified-phrase-v1', phrase, language: 'en', sense }
      : { profile: 'public-realm-classified-phrase-v1', phrase, language: 'en', sense,
        context: { kind: 'realm-local', id: realm.realm } });
    type Search = { results: { classification: { decision: string; application: string | null;
      meaningKey?: string; source: string } }[] };
    expect((await f.json<Search>(await classified('main'), 200)).results[0]?.classification.decision)
      .toBe(old.decision);
    expect((await f.json<Search>(await classified('realm'), 200)).results[0]?.classification.decision)
      .toBe(old.decision);
    const ratingInput = { realm: realm.realm, question: 'Migration quality', actingSubject: f.actorA };
    // The joined Statement reader verifies Access's sealed inventory as well
    // as graph receipts. Synthetic graph-only admissions cannot seed it.
    await f.grant(`rating:context:${realm.realm}`, 'rating.context.create');
    const rating = await f.json<{ context: string }>(await f.call('POST', '/v1/rating-contexts', {
      profile: 'realm-standing-rating-context-v1', ...ratingInput }), 201);
    const standingInput = { context: rating.context!, work: work.work!, mainVersion: work.mainVersion!,
      expectedRevisionHead: null, value: 9, actingSubject: f.actorA };
    await f.grant(`rating:observe:${rating.context}`, 'rating.observation.set');
    await f.json(await f.call('POST', '/v1/rating-observations', {
      profile: 'realm-standing-rating-observation-v1', ...standingInput }), 201);
    const joined = () => search({
      profile: 'public-realm-classified-rated-phrase-v1', phrase, language: 'en', sense,
      context: { kind: 'realm-local', id: realm.realm }, ratingContext: rating.context,
      minimumMeanTimes10: 80 });
    await f.json<Search>(await joined(), 200);
    await f.grant('statement:migrate:root', 'statement.migrate');
    await f.grant('statement:migrate:root', 'statement.cutover');
    const pending = await f.json<{ pending: { application: string; decision: string }[] }>(
      await f.call('GET', '/v1/statement-migrations/v1/pending'), 200);
    expect(pending.pending).toContainEqual({ application: old.application, decision: old.decision });
    const cutoverBody = { profile: 'statement-cutover-v1', actingSubject: f.actorA };
    const premature = await f.call('POST', '/v1/statement-migrations/v1/cutover', cutoverBody);
    if (premature.status !== 409) console.error('premature cutover', premature.status,
      await premature.clone().text());
    expect(premature.status).toBe(409);
    const migrationPath = `/v1/statement-migrations/v1/${old.application!.split('/').at(-1)}`;
    const migrationBody = { profile: 'statement-migration-v1', expectedDecision: old.decision,
      actingSubject: f.actorA };
    const migrationKey = randomUUID();
    f.resetQueries();
    const migrated = await f.json<{ slot: string; decision: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(
      await f.call('POST', migrationPath, migrationBody, migrationKey), 201);
    expect(migrated.replayed).toBe(false);
    expect(f.queries()).toBeLessThanOrEqual(24);
    const migrationBatch = await readNextMainOutboxBatch(f.env.fuseki,
      migrated.sourcePosition.dataEpoch, (BigInt(migrated.sourcePosition.sequence) - 1n).toString());
    expect(await readMainOutboxEnvelope(f.env.fuseki, migrationBatch!, migrationBatch!.eventIds[0]!))
      .toMatchObject({ type: 'com.rezics.statement.migrated.v1',
        data: { receipt: { action: 'statement.migrate', component: migrated.slot,
          revision: migrated.decision } } });
    expect(await f.json<{ decision: string; replayed: boolean }>(
      await f.call('POST', migrationPath, migrationBody, migrationKey), 200))
      .toMatchObject({ decision: migrated.decision, replayed: true });
    expect((await f.json<{ complete: boolean }>(
      await f.call('GET', '/v1/statement-migrations/v1/pending'), 200)).complete).toBe(true);
    const cutover = await f.json<{ revision: string; sourcePosition: { dataEpoch: string;
      sequence: string } }>(await f.call('POST', '/v1/statement-migrations/v1/cutover', cutoverBody), 201);
    const cutoverBatch = await readNextMainOutboxBatch(f.env.fuseki, cutover.sourcePosition.dataEpoch,
      (BigInt(cutover.sourcePosition.sequence) - 1n).toString());
    expect(await readMainOutboxEnvelope(f.env.fuseki, cutoverBatch!, cutoverBatch!.eventIds[0]!))
      .toMatchObject({ type: 'com.rezics.statement.cutover.v1',
        data: { receipt: { action: 'statement.cutover', revision: cutover.revision } } });
    f.resetQueries();
    const migrationReadStarted = performance.now();
    const newMain = await f.json<Search>(await classified('main'), 200);
    const newRealm = await f.json<Search>(await classified('realm'), 200);
    expect(newMain.results).toHaveLength(1);
    expect(newMain.results[0]?.classification).toMatchObject({ decision: migrated.decision,
      application: null, source: 'global' });
    expect(newRealm.results[0]?.classification).toMatchObject({ decision: migrated.decision,
      application: null, source: 'inherited-global' });
    expect(newMain.results[0]?.classification.meaningKey).toMatch(/^urn:rezics:meaning:/);
    expect(await f.json<{ decision: string; application: string | null }>(
      await legacyResolution(), 200)).toMatchObject({ decision: migrated.decision, application: null });
    const newJoined = await f.json<Search>(await joined(), 200);
    expect(newJoined.results[0]?.classification).toMatchObject({ decision: migrated.decision,
      application: null, source: 'inherited-global' });
    const migrationReadQueries = f.queries();
    const migrationReadCost = { graphCalls: migrationReadQueries,
      latencyMs: Math.round((performance.now() - migrationReadStarted) * 100) / 100 };
    await Bun.write(`.temp/search-context-cost-${Bun.env.REZICS_QA_RUN_ID}.json`,
      JSON.stringify(migrationReadCost));
    expect((await f.call('POST', '/v1/classification-decisions',
      { profile: 'classification-direct-decision-v1', ...decisionInput })).status).toBe(410);
    const mapped = await f.env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?statement ?revision WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?statement rv:migratedFrom ${iri(old.application!)} ;
        rv:head ?revision . ${iri(migrated.slot)} rv:decisionHead ${iri(migrated.decision)} . }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(migrated.decision)} rv:convertedFrom ${iri(old.decision!)} ;
        rv:support ?statement . }
    }`);
    expect(mapped.results?.bindings).toHaveLength(1);
    const statement = mapped.results!.bindings[0]!.statement!.value;
    const meaningKey = newMain.results[0]!.classification.meaningKey!;
    const stateBody = (state: 'active' | 'retired', expectedHead: string | null) => ({
      profile: 'context-definition-state-v1', definition: proposition.revision!,
      expectedHead, state, actingSubject: f.actorA });
    await f.grant(definitionStateRequest(stateBody('active', null)).scope, 'context.definition.state');
    const activeDefinition = await f.json<{ revision: string }>(await f.call('POST',
      '/v1/context-definition-states', stateBody('active', null)), 201);
    const retiredDefinition = await f.json<{ revision: string }>(await f.call('POST',
      '/v1/context-definition-states', stateBody('retired', activeDefinition.revision)), 201);
    expect(retiredDefinition.revision).not.toBe(activeDefinition.revision);
    expect(await f.json<{ decision: string; replayed: boolean }>(await f.call('POST',
      migrationPath, migrationBody, migrationKey), 200))
      .toMatchObject({ decision: migrated.decision, replayed: true });
    const retained = await f.json<{ meaningKey: string; export: Record<string, unknown> }>(await f.call('GET',
      `/v1/statements/${statement.split('/').at(-1)}`), 200);
    expect(retained.meaningKey).toBe(meaningKey);
    expect(retained.export[`${RV}interpretationDefinition`]).toEqual([{ '@id': proposition.revision }]);
    expect((await f.env.fuseki.query(`PREFIX rv: <${RV}> ASK {
      GRAPH ${iri(GRAPHS.current)} { ${iri(sense)} a rv:ClassificationSense ; rv:senseState rv:Active ;
        rv:head ${iri(proposition.revision!)} . }
    }`)).boolean).toBe(true);
    const resolved = await f.json<Resolution>(await f.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'qualified-fact',
        meaningKey }, acceptance: { kind: 'global' } }), 200);
    expect(resolved.result).toMatchObject({ state: 'accepted', decision: migrated.decision });
    await f.grant('classification:decide:global', 'statement.decide');
    const revised = await f.json<{ decision: string }>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target: { kind: 'qualified-fact', meaningKey,
        support: [statement] }, acceptance: { kind: 'global' },
      expectedDecisionHead: migrated.decision, outcome: 'rejected', actingSubject: f.actorA }), 201);
    expect(revised.decision).not.toBe(migrated.decision);
    expect((await f.json<Search>(await classified('main'), 200)).results).toHaveLength(0);
    expect((await f.json<Search>(await classified('realm'), 200)).results).toHaveLength(0);
    expect((await f.json<Search>(await joined(), 200)).results).toHaveLength(0);
    expect(await f.json<{ decision: string; state: string }>(await legacyResolution(), 200))
      .toMatchObject({ decision: revised.decision, state: 'rejected' });
    await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw');
    await f.json(await f.call('POST', `/v1/statements/${statement.split('/').at(-1)}/withdrawals`, {
      profile: 'statement-v1', speaker: { kind: 'personal' },
      expectedHead: mapped.results!.bindings[0]!.revision!.value, actingSubject: f.actorA }), 201);
    expect((await f.json<{ state: string }>(await f.call('GET',
      `/v1/statements/${statement.split('/').at(-1)}`), 200)).state).toBe('withdrawn');
    expect((await f.json<Resolution>(await f.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'qualified-fact', meaningKey },
      acceptance: { kind: 'global' } }), 200)).result.state).toBe('unavailable');
    // Keep the existing cost assertion, after exercising all migration outcomes.
    expect(migrationReadQueries).toBeLessThanOrEqual(36);
  } finally { await f.close(); }
}, 120_000);

test('CTX01/MODEL13: shared Context selection preserves distinct Realm and personal Statement meanings', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const definitionA = nativeId();
    const definitionB = nativeId();
    const relation = `${RV}classifiedAs`;
    const entry = (definition: string) => ({ target: object, relation,
      state: 'defined', definition, applicability: [] });
    await f.grant('context:create:root', 'context.create');
    const create = (definition: string) => f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [entry(definition)], actingSubject: f.actorA });
    const createdA = await create(definitionA);
    if (createdA.status !== 201) console.error('shared Context A', createdA.status, await createdA.clone().text());
    const sharedA = await f.json<ContextWrite>(createdA, 201);
    const createdB = await create(definitionB);
    if (createdB.status !== 201) console.error('shared Context B', createdB.status, await createdB.clone().text());
    const sharedB = await f.json<ContextWrite>(createdB, 201);
    const realmA = await f.realm('Context A');
    const realmB = await f.realm('Context B');
    const selectionBody = (context: ContextWrite, expectedHead: string | null) => ({
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: context.context, semanticRevision: context.semanticRevision },
      expectedHead, actingSubject: f.actorA });
    const realmBPath = `/v1/realms/${realmB.realm.split('/').at(-1)}/context-selections`;
    await f.revoke(await f.grant(`context:select:${realmB.realm}`, 'context.select'));
    expect((await f.call('POST', realmBPath, selectionBody(sharedA, null))).status).toBe(403);
    await f.grant(`context:select:${realmA.realm}`, 'context.select');
    const realmBGrant = await f.grant(`context:select:${realmB.realm}`, 'context.select');
    const select = async (realm: string, context: ContextWrite) => {
      const path = `/v1/realms/${realm.split('/').at(-1)}/context-selections`;
      const body = selectionBody(context, null);
      const key = randomUUID();
      const response = await f.call('POST', path, body, key);
      if (response.status !== 201) console.error('realm selection', response.status, await response.clone().text());
      const result = await f.json<SelectionWrite>(response, 201);
      expect(await f.json<SelectionWrite>(await f.call('POST', path, body, key), 200))
        .toMatchObject({ selection: result.selection, selectionRevision: result.selectionRevision,
          replayed: true });
      return result;
    };
    const adoptionA = await select(realmA.realm, sharedA);
    const adoptionB = await select(realmB.realm, sharedA);
    expect(adoptionA.selection).not.toBe(adoptionB.selection);
    expect(adoptionA.selectionRevision).not.toBe(adoptionB.selectionRevision);
    const changedB = await f.json<SelectionWrite>(await f.call('POST',
      `/v1/realms/${realmB.realm.split('/').at(-1)}/context-selections`, {
        profile: 'context-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedHead: adoptionB.selectionRevision, actingSubject: f.actorA }), 201);
    expect(changedB.selection).toBe(adoptionB.selection);
    const race = await Promise.all([f.call('POST', realmBPath,
      selectionBody(sharedA, changedB.selectionRevision)), f.call('POST', realmBPath,
      { ...selectionBody(sharedA, changedB.selectionRevision), selection: null })]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    await f.revoke(realmBGrant);
    expect((await f.call('POST', realmBPath,
      selectionBody(sharedB, changedB.selectionRevision))).status).toBe(403);

    const privateFirst = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: sharedA.context, semanticRevision: sharedA.semanticRevision },
      expectedRevision: null }), 201);
    const privateSelectionResponse = await f.call('PUT', '/v1/me/context-selections', {
        profile: 'context-private-selection-v1', scope: { kind: 'object', object },
        selection: { context: sharedB.context, semanticRevision: sharedB.semanticRevision },
        expectedRevision: privateFirst.revision });
    if (privateSelectionResponse.status !== 201) console.error('personal selection', privateSelectionResponse.status,
      await privateSelectionResponse.clone().text());
    const privateSelection = await f.json<{ context: string; semanticRevision: string; state: string }>(
      privateSelectionResponse, 201);
    expect(privateSelection).toMatchObject({ context: sharedB.context,
      semanticRevision: sharedB.semanticRevision, state: 'selected' });
    expect((await f.call('GET', `/v1/me/context-selections?kind=object&object=${encodeURIComponent(object)}`,
      undefined, randomUUID(), f.account.tokenB)).status).toBe(404);
    const work = await f.work('Statement subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    const subject = work.mainVersion;
    const relationDefinition = nativeId();
    const statementBody = (speaker: { kind: 'personal' } | { kind: 'realm'; realm: string }) => ({
      profile: 'statement-v1', speaker, subject, predicate: relation,
      relationDefinition, value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    await f.grant(`statement:speak:${realmA.realm}`, 'statement.record');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const realmStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'realm', realm: realmA.realm })), 201);
    const personalStatement = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody({ kind: 'personal' })), 201);
    const realmRead = await f.json<{ speaker: string; meaningBasis: { state: string;
      interpretationDefinitions?: string[] }; export: Record<string, unknown> }>(await f.call('GET',
      `/v1/statements/${realmStatement.statement.split('/').at(-1)}`), 200);
    const personalRead = await f.json<typeof realmRead>(await f.call('GET',
      `/v1/statements/${personalStatement.statement.split('/').at(-1)}`), 200);
    expect(realmRead).toMatchObject({ speaker: realmA.realm,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionA] } });
    expect(personalRead).toMatchObject({ speaker: f.actorA,
      meaningBasis: { state: 'readable', interpretationDefinitions: [definitionB] } });
    expect(realmStatement.meaningKey).not.toBe(personalStatement.meaningKey);
    expect(realmRead.export[`${RV}interpretationDefinition`]).toEqual([{ '@id': definitionA }]);
    // Identified rdf:Statement reification must not assert the unqualified base fact.
    const baseTriple = await f.env.fuseki.query(`ASK { GRAPH ${iri(GRAPHS.current)} {
      ${iri(subject)} <${relation}> ${iri(object)} } }`);
    expect(baseTriple.boolean).toBe(false);
  } finally { await f.close(); }
}, 120_000);

test('CTX03: hidden Context basis and explicit unresolved selection never fall back', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    const object = nativeId();
    const relation = `${RV}classifiedAs`;
    const privateDefinition = nativeId();
    await f.grant('context:create:root', 'context.create');
    const hidden = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: privateDefinition, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const hiddenPath = `/v1/contexts/${hidden.context.split('/').at(-1)}`;
    expect((await f.call('GET', hiddenPath, undefined, randomUUID(), null)).status).toBe(404);
    const readGrant = await f.grant(`context:read:${hidden.context}`, 'context.read');
    expect((await f.call('GET', `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}`)).status).toBe(200);
    const initialSelection = await f.json<{ revision: string }>(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: hidden.context, semanticRevision: hidden.semanticRevision },
      expectedRevision: null, actingSubject: f.actorA }), 201);
    const work = await f.work('Private meaning subject');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA }), 201);
    const statementPath = `/v1/statements/${recorded.statement.split('/').at(-1)}`;
    const anonymous = await f.json<{ meaningBasis: { state: string }; export: Record<string, unknown> }>(
      await f.call('GET', statementPath, undefined, randomUUID(), null), 200);
    expect(anonymous.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(anonymous)).not.toContain(privateDefinition);
    expect(JSON.stringify(anonymous)).not.toContain(hidden.semanticRevision);
    const authorized = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(authorized.meaningBasis).toMatchObject({ state: 'readable',
      interpretationDefinitions: [privateDefinition] });
    f.faultNextStatementRead('missing-pin-context');
    const missingPin = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(missingPin.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(missingPin)).not.toContain(privateDefinition);
    f.faultNextStatementRead('missing-head');
    expect((await f.call('GET', `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`)).status)
      .toBe(503);
    await f.grant(`context:change:${hidden.context}`, 'context.change');
    const successorDefinition = nativeId();
    const successor = await f.json<ContextWrite>(await f.call('POST',
      `${hiddenPath}/semantic-revisions`, { profile: 'context-v1',
        expectedSemanticHead: hidden.semanticRevision, base: null,
        entries: [{ target: object, relation, state: 'defined', definition: successorDefinition,
          applicability: [] }], actingSubject: f.actorA }), 201);
    const oldRevision = await f.json<{ revision: string; semanticHead: string;
      entries: Array<{ definition: string }> }>(await f.call('GET',
        `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}&revision=${encodeURIComponent(hidden.semanticRevision)}`),
    200);
    expect(oldRevision).toMatchObject({ revision: hidden.semanticRevision,
      semanticHead: successor.semanticRevision,
      entries: [{ definition: privateDefinition }] });
    expect((await f.json<typeof oldRevision>(await f.call('GET',
      `${hiddenPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200)).entries)
      .toMatchObject([{ definition: successorDefinition }]);
    expect((await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200)).meaningBasis)
      .toMatchObject({ state: 'readable', interpretationDefinitions: [privateDefinition] });
    await f.revoke(readGrant);
    const revoked = await f.json<typeof anonymous>(await f.call('GET',
      `${statementPath}?actingSubject=${encodeURIComponent(f.actorA)}`), 200);
    expect(revoked.meaningBasis).toEqual({ state: 'unavailable' });
    expect(JSON.stringify(revoked.export)).not.toContain(privateDefinition);
    expect(JSON.stringify(revoked.export)).not.toContain(hidden.semanticRevision);

    const hiddenChild = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'private', base: hidden.semanticRevision,
      entries: [], actingSubject: f.actorA }), 201);
    const childReadGrant = await f.grant(`context:read:${hiddenChild.context}`, 'context.read');
    const childPath = `/v1/contexts/${hiddenChild.context.split('/').at(-1)}`;
    expect((await f.call('GET', childPath, undefined, randomUUID(), null)).status).toBe(404);
    await f.json(await f.call('PUT', '/v1/me/context-selections', {
      profile: 'context-private-selection-v1', scope: { kind: 'object', object },
      selection: { context: hiddenChild.context, semanticRevision: hiddenChild.semanticRevision },
      expectedRevision: initialSelection.revision, actingSubject: f.actorA }), 201);
    const hiddenBasePreview = await f.json<{ state: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(hiddenBasePreview).toMatchObject({ state: 'unavailable' });
    expect(JSON.stringify(hiddenBasePreview)).not.toContain(privateDefinition);
    const restoredBaseGrant = await f.grant(`context:read:${hidden.context}`, 'context.read');
    const readableBase = await f.json<{ state: string; definition: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(readableBase).toMatchObject({ state: 'resolved', definition: privateDefinition });
    f.faultNextContextChainRead(hidden.semanticRevision);
    const missingBase = await f.json<{ state: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'personal' }, object, relation, explicit: null,
        actingSubject: f.actorA }), 200);
    expect(missingBase).toMatchObject({ state: 'unavailable' });
    expect(JSON.stringify(missingBase)).not.toContain(privateDefinition);
    await f.revoke(restoredBaseGrant);
    await f.revoke(childReadGrant);

    await f.grant('context:create:global', 'context.create');
    const global = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'global', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'defined', definition: nativeId(), applicability: [] }],
      actingSubject: f.actorA }), 201);
    expect(global.context).toBe('urn:rezics:semantic-context:global');
    const unresolved = await f.json<ContextWrite>(await f.call('POST', '/v1/contexts', {
      profile: 'context-v1', role: 'shared', disclosure: 'public', base: null,
      entries: [{ target: object, relation, state: 'unresolved', definition: null, applicability: [] }],
      actingSubject: f.actorA }), 201);
    const realm = await f.realm('Unresolved selection');
    await f.grant(`context:select:${realm.realm}`, 'context.select');
    await f.json(await f.call('POST', `/v1/realms/${realm.realm.split('/').at(-1)}/context-selections`, {
      profile: 'context-selection-v1', scope: { kind: 'object', object },
      selection: { context: unresolved.context, semanticRevision: unresolved.semanticRevision },
      expectedHead: null, actingSubject: f.actorA }), 201);
    const preview = await f.json<{ state: string; context: string }>(await f.call('POST',
      '/v1/context-interpretations', { profile: 'context-interpretation-v1',
        speaker: { kind: 'realm', realm: realm.realm }, object, relation,
        explicit: null, actingSubject: f.actorA }), 200);
    expect(preview).toMatchObject({ state: 'unresolved', context: unresolved.context });
    await f.grant(`statement:speak:${realm.realm}`, 'statement.record');
    const blocked = await f.call('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'realm', realm: realm.realm }, subject: work.mainVersion,
      predicate: relation, relationDefinition: nativeId(), value: { kind: 'resource', iri: object },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ code: 'interpretation_unresolved',
      interpretation: { state: 'unresolved', context: unresolved.context } });
  } finally { await f.close(); }
}, 120_000);

test('CTX02/CTX03: exact Statement decisions inherit Global, suppress on local reject and fail closed', async () => {
  const f = await contextFixture(Bun.env as Record<string, string>);
  try {
    await f.globalAcceptance();
    const realmA = await f.realm('Decision A');
    const realmB = await f.realm('Decision B');
    const work = await f.work('Decision subject');
    if (!work.mainVersion) throw new Error('Work fixture failed');
    await f.grant(`statement:speak:${f.actorA}`, 'statement.record');
    const relationDefinition = nativeId();
    const value = nativeId();
    const statementBody = (definition: string) => ({
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: work.mainVersion,
      predicate: `${RV}classifiedAs`, relationDefinition: definition,
      value: { kind: 'resource', iri: value }, applicability: [],
      interpretation: { kind: 'selected' }, evidence: [], actingSubject: f.actorA });
    const recorded = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(relationDefinition)), 201);
    const changedCriterion = await f.json<StatementWrite>(await f.call('POST', '/v1/statements',
      statementBody(nativeId())), 201);
    expect(changedCriterion.meaningKey).not.toBe(recorded.meaningKey);
    const target = { kind: 'statement', statement: recorded.statement };
    const acceptance = (realm?: string) => realm ? { kind: 'realm', realm } : { kind: 'global' };
    const resolve = async (realm?: string) => f.json<Resolution>(await f.call('POST',
      '/v1/statement-resolutions', { profile: 'statement-resolution-v1', target,
        acceptance: acceptance(realm) }), 200);
    const denied = await f.grant('classification:decide:global', 'statement.decide');
    await f.revoke(denied);
    const globalDecision = { profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA };
    expect((await f.call('POST', '/v1/statement-decisions', globalDecision)).status).toBe(403);
    await f.grant('classification:decide:global', 'statement.decide');
    const globalKey = randomUUID();
    const accepted = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, globalKey), 201);
    expect(await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions',
      globalDecision, globalKey), 200)).toMatchObject({ decision: accepted.decision, replayed: true });
    const acceptedBatch = await readNextMainOutboxBatch(f.env.fuseki, accepted.sourcePosition.dataEpoch,
      (BigInt(accepted.sourcePosition.sequence) - 1n).toString());
    expect(acceptedBatch?.sequence).toBe(accepted.sourcePosition.sequence);
    const acceptedEvent = await readMainOutboxEnvelope(f.env.fuseki, acceptedBatch!, acceptedBatch!.eventIds[0]!);
    expect(acceptedEvent).toMatchObject({ type: 'com.rezics.statement.decision-changed.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'succeeded', component: accepted.slot,
        revision: accepted.decision } } });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global',
      decision: accepted.decision });
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    await f.grant(`classification:decide:${realmA.realm}`, 'statement.decide');
    const rejected = await f.json<DecisionWrite>(await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'rejected', actingSubject: f.actorA }), 201);
    expect((await resolve(realmA.realm)).result).toMatchObject({ state: 'rejected', source: 'local',
      decision: rejected.decision });
    expect((await resolve(realmB.realm)).result).toMatchObject({ state: 'accepted',
      source: 'inherited-global', decision: accepted.decision });
    expect((await f.json<Resolution>(await f.call('POST', '/v1/statement-resolutions', {
      profile: 'statement-resolution-v1', target: { kind: 'statement', statement: changedCriterion.statement },
      acceptance: acceptance(realmB.realm) }), 200)).result).toEqual({ state: 'absent', source: 'none' });
    expect((await resolve()).result).toMatchObject({ state: 'accepted', source: 'global' });
    for (const fault of ['missing-outcome', 'failed-read'] as const) {
      f.faultNextLocalDecisionRead(fault);
      const response = await f.call('POST', '/v1/statement-resolutions', {
        profile: 'statement-resolution-v1', target, acceptance: acceptance(realmA.realm) });
      expect(response.status).toBe(fault === 'missing-outcome' ? 200 : 503);
      const body = JSON.stringify(await response.json());
      if (fault === 'missing-outcome') expect(JSON.parse(body).result).toEqual({ state: 'unavailable' });
      expect(body).not.toContain(rejected.decision);
      expect(body).not.toContain(accepted.decision);
    }
    const stale = await f.call('POST', '/v1/statement-decisions', {
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: null, outcome: 'accepted', actingSubject: f.actorA }, randomUUID());
    expect(stale.status).toBe(409);
    const staleBatch = await readNextMainOutboxBatch(f.env.fuseki, rejected.sourcePosition.dataEpoch,
      rejected.sourcePosition.sequence);
    const staleEvent = await readMainOutboxEnvelope(f.env.fuseki, staleBatch!, staleBatch!.eventIds[0]!);
    expect(staleEvent).toMatchObject({ type: 'com.rezics.statement.decision-stale.v1',
      data: { receipt: { action: 'statement.decide', outcome: 'cancelled', reason: 'stale-head' } } });
    const raceBody = (outcome: 'accepted' | 'withdrawn') => ({
      profile: 'statement-decision-v1', target, acceptance: acceptance(realmA.realm),
      expectedDecisionHead: rejected.decision, outcome, actingSubject: f.actorA });
    const race = await Promise.all([f.call('POST', '/v1/statement-decisions', raceBody('accepted')),
      f.call('POST', '/v1/statement-decisions', raceBody('withdrawn'))]);
    expect(race.map(response => response.status).sort()).toEqual([201, 409]);
    const withdrawal = { profile: 'statement-v1', speaker: { kind: 'personal' },
      expectedHead: recorded.revision, actingSubject: f.actorA };
    const withdrawalPath = `/v1/statements/${recorded.statement.split('/').at(-1)}/withdrawals`;
    await f.revoke(await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw'));
    expect((await f.call('POST', withdrawalPath, withdrawal)).status).toBe(403);
    await f.grant(`statement:speak:${f.actorA}`, 'statement.withdraw');
    const withdrawalKey = randomUUID();
    const withdrawn = await f.json<{ revision: string; replayed: boolean;
      sourcePosition: { dataEpoch: string; sequence: string } }>(await f.call('POST',
      withdrawalPath, withdrawal, withdrawalKey), 201);
    expect(await f.json<typeof withdrawn>(await f.call('POST', withdrawalPath, withdrawal,
      withdrawalKey), 200)).toMatchObject({ revision: withdrawn.revision, replayed: true });
    expect((await f.json<{ state: string; revision: string }>(await f.call('GET',
      `/v1/statements/${recorded.statement.split('/').at(-1)}`), 200)))
      .toMatchObject({ state: 'withdrawn', revision: withdrawn.revision });
    expect((await resolve()).result).toEqual({ state: 'unavailable' });
    expect((await resolve(realmB.realm)).result).toEqual({ state: 'unavailable' });
    const withdrawalBatch = await readNextMainOutboxBatch(f.env.fuseki,
      withdrawn.sourcePosition.dataEpoch, (BigInt(withdrawn.sourcePosition.sequence) - 1n).toString());
    const withdrawalEvent = await readMainOutboxEnvelope(f.env.fuseki, withdrawalBatch!,
      withdrawalBatch!.eventIds[0]!);
    expect(withdrawalEvent).toMatchObject({ type: 'com.rezics.statement.withdrawn.v1',
      data: { receipt: { action: 'statement.withdraw', outcome: 'succeeded',
        component: recorded.statement, revision: withdrawn.revision } } });
    expect((await f.call('POST', withdrawalPath, withdrawal)).status).toBe(409);
  } finally { await f.close(); }
}, 120_000);
