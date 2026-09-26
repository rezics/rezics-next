import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { RegisteredAdmission } from '../../../services/main/src/modules/access/admission.ts';
import { createClassificationContext, classificationContextDigest }
  from '../../../services/main/src/modules/classification/context.ts';
import { createClassificationProposition, classificationPropositionDigest }
  from '../../../services/main/src/modules/classification/proposition.ts';
import { createContext, createContextRequest } from '../../../services/main/src/modules/context/graph.ts';
import type { RelationGraphContinuation } from '../../../services/main/src/modules/graph-query/schema.ts';
import { recordStatement, recordStatementRequest, setStatementDecision, statementDecisionRequest }
  from '../../../services/main/src/modules/statement/graph.ts';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { activateMetadataWork, metadataWorkRequestDigest } from '../../../services/main/src/modules/work/activate.ts';
import { activateTextContribution, textContributionDigest } from '../../../services/main/src/modules/contribution/draft.ts';
import { publishTextContribution, textPublicationDigest } from '../../../services/main/src/modules/contribution/publish.ts';
import { selectMainDefault, mainSelectionDigest } from '../../../services/main/src/modules/work/select-main.ts';
import { authorCreditFixture } from '../fixtures/author-credit.ts';

type Changed = { component: string; revision: string };
type RelationWrite = { occurrence: string; revision: string };
type GraphEdge = { occurrence: string; from: string; to: string;
  matchReason: { kind: string; matchUnit?: string | null; score?: number | null } };

test('GRAPH01/GRAPH02/GRAPH03/GRAPH04/GRAPH05: occurrence roles, explicit canons, bounded frontier, disclosure and same-request text traversal', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>, resolve('.temp', `graph-query-${randomUUID()}`));
  const admission = (scope: string, action: string, requestDigest: string): RegisteredAdmission => {
    const id = randomUUID();
    return { id, principalId: f.principalId, actingSubject: f.actor, scope, action,
      idempotencyKey: `graph-${id}`, requestDigest, authorityEpoch: '0',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      state: 'claimed', dispatchEligible: true, replayed: false };
  };
  const semantic = (state: object, key = randomUUID()) => f.call('POST', '/v1/semantic/changes', {
    profile: 'semantic-change-v1', actingSubject: f.actor, expectedHead: null, state,
  }, key);
  const createdSemantic = async (stage: string, state: object) => {
    const key = randomUUID();
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await semantic(state, key);
      if (response.status === 202) {
        await new Promise(resolveRetry => setTimeout(resolveRetry, 1000));
        continue;
      }
      if (response.status !== 201) {
        throw new Error(`${stage}: ${response.status} ${await response.clone().text()}`);
      }
      return f.json<Changed>(response, 201);
    }
    throw new Error(`${stage}: semantic receipt remained reconciling after four idempotent attempts`);
  };
  const createResource = async () => {
    const created = await createdSemantic('resource', { component: 'resource',
      types: ['https://schema.org/Person'], properties: [] });
    await f.grant(`semantic:read:${created.component}`, 'semantic.read');
    return created.component;
  };
  const query = async (body: object, token = f.account.tokenA) => f.call('POST', '/v1/graph/queries', body,
    randomUUID(), token);
  const measuredQuery = async (operation: () => Promise<Response>) => {
    const fuseki = f.env.fuseki;
    let graphQueries = 0;
    f.env.fuseki = new Proxy(fuseki, { get(target, property) {
      if (property === 'query') return async (...args: Parameters<typeof fuseki.query>) => {
        graphQueries++;
        return fuseki.query(...args);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as typeof fuseki;
    try { return { response: await operation(), graphQueries }; }
    finally { f.env.fuseki = fuseki; }
  };
  const checkResponse = async (stage: string, response: Response, expected: number) => {
    if (response.status !== expected) throw new Error(`${stage}: ${response.status} ${await response.clone().text()}`);
    return response;
  };
  const createRelation = async (definition: string,
    participants: Array<{ role: string; participant: object }>) => {
      const response = await checkResponse('relation write', await f.call('POST',
        '/v1/relations/changes', { profile: 'relation-change-v1', actingSubject: f.actor,
          expectedHead: null, definition, participations: participants }), 201);
      return f.json<RelationWrite>(response, 201);
    };
  try {
    await f.grant('semantic:create:root', 'semantic.change');
    await f.grant('relation:create:root', 'relation.change');
    const relationDefinition = await createdSemantic('relation definition', { component: 'definition', kind: 'relation',
      lifecycle: 'active', successor: null, roles: [
        { key: 'performer', minParticipants: 1, maxParticipants: 1, ordered: false },
        { key: 'character', minParticipants: 1, maxParticipants: 63, ordered: false },
      ] });
    const performer = await createResource();
    const otherPerformer = await createResource();
    const characters = await Promise.all(Array.from({ length: 3 }, createResource));

    // GRAPH01: both role constraints must bind through one exact occurrence revision.
    const sameOccurrence = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: performer } },
      { role: 'character', participant: { kind: 'resource', ref: characters[0]! } },
    ]);
    const splitPerformer = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: otherPerformer } },
      { role: 'character', participant: { kind: 'resource', ref: characters[1]! } },
    ]);
    await f.grant(`semantic:read:${sameOccurrence.occurrence}`, 'semantic.read');
    await f.grant(`semantic:read:${splitPerformer.occurrence}`, 'semantic.read');
    const roleQuery = { profile: 'relation-graph-v1', actingSubject: f.actor,
      anchor: { kind: 'resource', id: performer }, definition: relationDefinition.revision,
      fromRole: 'performer', toRole: 'character', direction: 'outgoing',
      roleBindings: [{ role: 'performer', participant: performer },
        { role: 'character', participant: characters[0]! }] };
    const matching = await f.json<{ edges: GraphEdge[] }>(await query(roleQuery), 200);
    expect(matching.edges.map(edge => edge.occurrence)).toEqual([sameOccurrence.occurrence]);
    const splitQuery = await f.json<{ edges: GraphEdge[] }>(await query({ ...roleQuery,
      roleBindings: [{ role: 'performer', participant: performer },
        { role: 'character', participant: characters[1]! }] }), 200);
    expect(splitQuery.edges).toEqual([]);
    expect((await query(roleQuery, f.account.tokenB)).status).toBe(404);
    expect((await query({ ...roleQuery, anchor: undefined })).status).toBe(400);
    const currentEpoch = f.env.lineage.dataEpoch;
    try {
      f.env.lineage.dataEpoch = randomUUID();
      const stale = await query(roleQuery);
      expect(stale.status).toBe(503);
      expect(await stale.json()).toMatchObject({ code: 'recovery_hold' });
    } finally { f.env.lineage.dataEpoch = currentEpoch; }
    const recovered = await f.json<{ edges: GraphEdge[] }>(await query(roleQuery), 200);
    expect(recovered.edges).toEqual(matching.edges);

    // GRAPH03: 65 result bindings are cut at the 64-edge page and report a frontier.
    const external = (key: string) => ({ kind: 'external', provider: 'graph-test', namespace: 'character', key });
    const denseResources = [...characters, ...await Promise.all(Array.from({ length: 28 }, createResource))];
    const largeOccurrence = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: performer } },
      ...denseResources.map(resource => ({ role: 'character', participant: { kind: 'resource', ref: resource } })),
      ...Array.from({ length: 32 }, (_, index) => ({ role: 'character', participant: external(`dense-${index}`) })),
    ]);
    const secondDenseOccurrence = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: performer } },
      { role: 'character', participant: external('dense-extra-a') },
      { role: 'character', participant: external('dense-extra-b') },
    ]);
    await f.grant(`semantic:read:${largeOccurrence.occurrence}`, 'semantic.read');
    await f.grant(`semantic:read:${secondDenseOccurrence.occurrence}`, 'semantic.read');
    const measuredDense = await measuredQuery(() => query({ ...roleQuery,
      roleBindings: [{ role: 'performer', participant: performer }] }));
    const denseQuery = { ...roleQuery, roleBindings: [{ role: 'performer', participant: performer }] };
    const dense = await f.json<{ total: number; complete: boolean; frontier: string;
      continuation: RelationGraphContinuation | null; edges: GraphEdge[] }>(
      measuredDense.response, 200);
    expect(measuredDense.graphQueries).toBe(3);
    expect(dense.total).toBe(64);
    expect(dense.edges).toHaveLength(64);
    expect(dense.complete).toBe(false);
    expect(dense.frontier).toBe('more');
    if (!dense.continuation) throw new Error('dense visible page has no continuation');
    const denseNext = await f.json<{ total: number; complete: boolean; frontier: string;
      continuation: unknown; edges: GraphEdge[] }>(await query({ ...denseQuery, continuation: dense.continuation }), 200);
    expect(denseNext).toMatchObject({ total: 2, complete: true, frontier: 'complete', continuation: null });
    const allPagedEdges = [...dense.edges, ...denseNext.edges];
    expect(allPagedEdges).toHaveLength(66);
    expect(new Set(allPagedEdges.map(edge => `${edge.occurrence}|${edge.to}`)).size).toBe(66);
    await createResource();
    const stalePage = await query({ ...denseQuery, continuation: dense.continuation });
    expect(stalePage.status).toBe(409);
    expect(await stalePage.json()).toMatchObject({ code: 'graph_continuation_restart' });

    // GRAPH04: inaccessible native intermediates are indistinguishable from no edge.
    const privateAnchor = await createResource();
    const privateTargetResult = await createdSemantic('private target resource', { component: 'resource',
      types: ['https://schema.org/Person'], properties: [] });
    const privateTarget = privateTargetResult.component;
    const targetGrant = await f.grant(`semantic:read:${privateTarget}`, 'semantic.read');
    const hiddenRelation = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: privateAnchor } },
      { role: 'character', participant: { kind: 'resource', ref: privateTarget } },
    ]);
    await f.grant(`semantic:read:${hiddenRelation.occurrence}`, 'semantic.read');
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1', [targetGrant]);
    const hidden = await f.json<{ complete: boolean; frontier: string; total: number; edges: GraphEdge[] }>(
      await query({ ...roleQuery, anchor: { kind: 'resource', id: privateAnchor }, roleBindings: [] }), 200);
    const absent = await f.json<{ complete: boolean; frontier: string; total: number; edges: GraphEdge[] }>(
      await query({ ...roleQuery, anchor: { kind: 'resource', id: denseResources[0]! }, roleBindings: [] }), 200);
    expect({ complete: hidden.complete, frontier: hidden.frontier, total: hidden.total, edges: hidden.edges })
      .toEqual({ complete: absent.complete, frontier: absent.frontier, total: absent.total, edges: absent.edges });
    expect(JSON.stringify(hidden)).not.toContain(privateTarget);

    // GRAPH02: claims from personal and Realm canons retain the speaker, exact meaning and evidence.
    const predicate = 'https://rezics.com/vocab/graphQueryLink';
    const personalDefinition = 'https://rezics.com/definition/personal-link-v1';
    const realmDefinition = 'https://rezics.com/definition/realm-link-v1';
    const makeContext = async (definition: string, disclosure: 'public' | 'private' = 'public') => {
      const input = { role: 'shared' as const, disclosure, base: null,
        entries: [{ target: characters[0]!, relation: predicate, state: 'defined' as const,
          definition, applicability: [] }], actingSubject: f.actor };
      const intent = createContextRequest(input);
      return createContext(f.env, admission(intent.scope, intent.action, intent.digest), input);
    };
    const personalContext = await makeContext(personalDefinition);
    const realmContext = await makeContext(realmDefinition);
    const privateContext = await makeContext('https://rezics.com/definition/private-link-v1', 'private');
    const realmInput = { name: `Graph query Realm ${randomUUID()}`, actingSubject: f.actor };
    const realm = await createRealmSpace(f.env,
      admission('space:create:root', 'space.create', spaceCreationDigest(realmInput)), realmInput);
    if (!realm.realm) throw new Error('Realm fixture creation failed');
    const classificationInput = { realm: realm.realm, actingSubject: f.actor };
    const classificationContext = await createClassificationContext(f.env,
      admission(`classification:context:${realm.realm}`, 'classification.context.configure',
        classificationContextDigest(classificationInput)), classificationInput);
    if (!classificationContext.context) throw new Error('Realm decision scope fixture creation failed');
    const globalInput = { label: `Graph query global ${randomUUID()}`, actingSubject: f.actor };
    await createClassificationProposition(f.env, admission('classification:define:global',
      'classification.proposition.define', classificationPropositionDigest(globalInput)), globalInput);
    const createStatement = async (speaker: { kind: 'personal' } | { kind: 'realm'; realm: string },
      context: { component: string; revision: string }, definition: string, evidence: string,
      canReadPrivate?: (context: string) => Promise<boolean>) => {
      const input = { speaker, subject: performer, predicate, relationDefinition: definition,
        value: { kind: 'resource' as const, iri: characters[0]! }, applicability: [],
        interpretation: { kind: 'explicit' as const, context: context.component,
          semanticRevision: context.revision }, evidence: [evidence], actingSubject: f.actor };
      const intent = recordStatementRequest(input);
      const receipt = await recordStatement(f.env, admission(intent.scope, intent.action, intent.digest), input,
        speaker.kind === 'realm' ? { kind: 'realm', realm: speaker.realm }
          : { kind: 'personal', ...(canReadPrivate ? { canReadPrivate } : {}) });
      const decisionInput = { target: { kind: 'statement' as const, statement: receipt.component },
        acceptance: speaker.kind === 'realm' ? { kind: 'realm' as const, realm: speaker.realm }
          : { kind: 'global' as const }, expectedDecisionHead: null,
        outcome: speaker.kind === 'realm' ? 'rejected' as const : 'accepted' as const, actingSubject: f.actor };
      const decisionIntent = statementDecisionRequest(decisionInput);
      await setStatementDecision(f.env, admission(decisionIntent.scope, decisionIntent.action,
        decisionIntent.digest), decisionInput);
      return { statement: receipt.component, context: context.component,
        meaning: definition, evidence, speaker: speaker.kind === 'realm' ? speaker.realm : f.actor,
        decisionScope: speaker.kind === 'realm' ? classificationContext.context! : 'urn:rezics:classification-context:global' };
    };
    const personalClaim = await createStatement({ kind: 'personal' }, personalContext,
      personalDefinition, 'https://evidence.example/personal-canon');
    const realmClaim = await createStatement({ kind: 'realm', realm: realm.realm }, realmContext,
      realmDefinition, 'https://evidence.example/realm-canon');
    const privateContextGrant = await f.grant(`context:read:${privateContext.component}`, 'context.read');
    const canReadPrivate = async (context: string) => context === privateContext.component
      && (await f.accessPool.query(`SELECT 1 FROM access.permission_grant WHERE id = $1
        AND issuer_subject = $2 AND recipient_subject = $2 AND scope_id = $3 AND action = $4
        AND active = true AND valid_until > now()`, [privateContextGrant, f.actor,
        `context:read:${privateContext.component}`, 'context.read'])).rowCount === 1;
    const privateClaim = await createStatement({ kind: 'personal' }, privateContext,
      'https://rezics.com/definition/graph-link-v1', 'https://evidence.example/private-canon', canReadPrivate);
    const statementQuery = { profile: 'statement-graph-v1' as const, actingSubject: f.actor,
      anchor: performer, direction: 'outgoing' as const };
    const measuredClaims = await measuredQuery(() => query(statementQuery));
    const claims = await f.json<{ claims: Array<{ statement: string; speaker: string; evidence: string[];
      meaningBasis: { state: string; context?: string; interpretationDefinitions?: string[] };
      decisions: Array<{ acceptanceContext: string; outcome: string }> }> }>(measuredClaims.response, 200);
    expect(measuredClaims.graphQueries).toBe(2);
    const personalResult = claims.claims.find(claim => claim.statement === personalClaim.statement)!;
    const realmResult = claims.claims.find(claim => claim.statement === realmClaim.statement)!;
    expect(personalResult).toMatchObject({ speaker: personalClaim.speaker, evidence: [personalClaim.evidence],
      meaningBasis: { state: 'readable', context: personalClaim.context,
        interpretationDefinitions: [personalDefinition] },
      decisions: [{ acceptanceContext: personalClaim.decisionScope, outcome: 'Accepted' }] });
    expect(realmResult).toMatchObject({ speaker: realmClaim.speaker, evidence: [realmClaim.evidence],
      meaningBasis: { state: 'readable', context: realmClaim.context,
        interpretationDefinitions: [realmDefinition] },
      decisions: [{ acceptanceContext: realmClaim.decisionScope, outcome: 'Rejected' }] });
    const privateResult = claims.claims.find(claim => claim.statement === privateClaim.statement)!;
    expect(privateResult).toMatchObject({ meaningBasis: { state: 'unavailable' } });
    for (const hiddenReference of [privateContext.component, privateContext.revision,
      'https://rezics.com/definition/private-link-v1']) {
      expect(JSON.stringify(privateResult)).not.toContain(hiddenReference);
    }
    expect(personalResult.meaningBasis.context).not.toBe(realmResult.meaningBasis.context);
    const [concurrentA, concurrentB] = await Promise.all([query(statementQuery), query(statementQuery)]);
    expect(concurrentA.status).toBe(200);
    expect(concurrentB.status).toBe(200);
    const readBody = (response: Response) => response.json() as Promise<{
      claims: Array<{ statement: string }>;
      sourcePosition: { dataEpoch: string; sequence: string };
    }>;
    const [concurrentBodyA, concurrentBodyB] = await Promise.all([readBody(concurrentA), readBody(concurrentB)]);
    expect(concurrentBodyA).toEqual(concurrentBodyB);
    const beforePosition = claims.claims.length;
    expect(beforePosition).toBeGreaterThanOrEqual(2);

    // GRAPH05: one ARQ request starts with public phrase hits and binds the same Work into relation roles.
    const title = `Graph phrase ${randomUUID()}`;
    const work = await activateMetadataWork(f.env, { title,
      admission: admission('work:create:root', 'work.create', metadataWorkRequestDigest(title)) });
    await f.grant(`work:read:${work.work}`, 'work.read');
    const phrase = `needle${randomUUID().replaceAll('-', '')}`;
    const draftInput = { work: work.work, language: 'en', body: `A ${phrase} enters the graph.`, actingSubject: f.actor };
    const draft = await activateTextContribution(f.env,
      admission(`contribution:create:${draftInput.work}`, 'contribution.create', textContributionDigest(draftInput)), draftInput);
    if (draft.outcome !== 'succeeded' || !draft.contribution || !draft.draftRevision) {
      throw new Error('phrase fixture draft failed');
    }
    const publishInput = { contribution: draft.contribution, expectedDraftHead: draft.draftRevision,
      expectedPublicationHead: null, rightsBasis: 'original-contribution' as const,
      disclosure: 'public' as const, actingSubject: f.actor };
    const published = await publishTextContribution(f.env,
      admission(`contribution:publish:${draft.contribution}`, 'contribution.publish', textPublicationDigest(publishInput)),
      publishInput);
    if (published.outcome !== 'succeeded' || !published.publicationDecision) {
      throw new Error('phrase fixture publication failed');
    }
    const selectionInput = { context: { kind: 'main-version-default' as const, id: work.mainVersion },
      work: work.work, contribution: draft.contribution, publicationDecision: published.publicationDecision,
      expectedSelectionHead: null, selectionBasis: 'main-maintainer' as const, actingSubject: f.actor };
    const selected = await selectMainDefault(f.env,
      admission(`publication:select:${work.mainVersion}`, 'publication.select', mainSelectionDigest(selectionInput)),
      selectionInput);
    if (selected.outcome !== 'succeeded' || !selected.matchUnit) throw new Error('phrase fixture selection failed');
    const phraseRelation = await createRelation(relationDefinition.revision, [
      { role: 'performer', participant: { kind: 'resource', ref: work.work } },
      { role: 'character', participant: { kind: 'resource', ref: characters[2]! } },
    ]);
    await f.grant(`semantic:read:${phraseRelation.occurrence}`, 'semantic.read');
    const phraseResult = await f.json<{ edges: GraphEdge[] }>(await query({ ...roleQuery,
      anchor: { kind: 'phrase', phrase, language: 'en' },
      roleBindings: [{ role: 'performer', participant: work.work }] }), 200);
    expect(phraseResult.edges).toHaveLength(1);
    expect(phraseResult.edges[0]).toMatchObject({ occurrence: phraseRelation.occurrence,
      from: work.work, to: characters[2], matchReason: { kind: 'phrase', matchUnit: selected.matchUnit } });
    const directWorkResult = await f.json<{ edges: GraphEdge[] }>(await query({ ...roleQuery,
      anchor: { kind: 'resource', id: work.work },
      roleBindings: [{ role: 'performer', participant: work.work }] }), 200);
    expect(directWorkResult.edges.map(edge => [edge.occurrence, edge.to]))
      .toEqual(phraseResult.edges.map(edge => [edge.occurrence, edge.to]));
  } finally { await f.close(); }
}, 600_000);
