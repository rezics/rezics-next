import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { commitCommand } from '../../../services/main/src/modules/context/command.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { DATE_PUBLISHED_DEFINITION_NOTATION } from '../../../services/main/src/modules/statement/qualification.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { AccessRealmManagement } from '../../../services/main/src/modules/access/realm-management.ts';
import { grantFixtureAuthority } from '../../../services/main/src/modules/access/fixture-authority.ts';
import { RealmAboutThreadStore } from '../../../services/main/src/modules/realm-reply/about-store.ts';
import { readReplyGraphReceipt } from '../../../services/main/src/modules/realm-reply/graph.ts';
import { realmReplyDigest } from '../../../services/main/src/modules/realm-reply/store.ts';
import { resolveTargets, targetRead } from '../../../services/main/src/modules/target/resolve.ts';
import { registeredHiddenIdReads } from '../../../scripts/qa/hidden-id-equality.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { assertHiddenIdEquality, comparableBody, type HiddenIdCounters } from '../support/hidden-id-equality.ts';
import { foregroundCounted } from './support/query-cost-meter.ts';
import { startMediaStack } from './media-support.ts';

const ID = 'https://rezics.com/id/';
const local = (iri: string) => iri.slice(ID.length);

test('a hidden id and an absent id get the same answer on the registered reads', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const stack = await startMediaStack('hidden-id-equality');
  const prototype = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const originalQuery = prototype.query;
  const poolPrototype = pg.Pool.prototype as unknown as { connect: (...args: unknown[]) => unknown };
  const originalConnect = poolPrototype.connect;
  poolPrototype.connect = function (this: unknown, ...args: unknown[]) {
    const callback = args[0];
    if (typeof callback !== 'function') return originalConnect.apply(this, args);
    // An idle client can be lent from a background worker's release callback.
    // Attribute the driver's SQL to the caller that requested the checkout.
    const resume = AsyncLocalStorage.snapshot();
    return originalConnect.call(this, (...values: unknown[]) => resume(callback, ...values));
  };
  let statements = 0;
  let countSql = true;
  let bytes = 0;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    if (countSql && foregroundCounted()) statements++;
    return originalQuery.apply(this, args);
  };
  try {
    const owner = await stack.member('hidden-owner', { verified: true });
    const outsider = await stack.member('hidden-outsider');
    const hiddenWork = await stack.privateWork(owner.actor, `Hidden work ${randomUUID()}`);
    await owner.grant('work:create:root', 'work.create');
    const recipeWorkResponse = await owner.send('POST', '/v1/works', {
      profile: 'metadata-only-v1', authoring: 'own-work', language: 'en',
      title: `Hidden recipe ${randomUUID()}`, semanticTypes: ['https://schema.org/Recipe'],
      actingSubject: owner.actor,
    });
    const recipeWorkText = await recipeWorkResponse.text();
    if (recipeWorkResponse.status !== 201) {
      throw new Error(`recipe Work ${recipeWorkResponse.status}: ${recipeWorkText}`);
    }
    const recipeWork = JSON.parse(recipeWorkText) as { work: string; mainVersion: string };
    await owner.grant(`work:edit:${recipeWork.work}`, 'recipe.edit');
    await owner.grant(`work:read:${recipeWork.work}`, 'work.read');
    const hiddenRecipeResponse = await owner.send('POST', '/v1/compositions', {
      profile: 'recipe-composition', work: recipeWork.work, mainVersion: recipeWork.mainVersion,
      actingSubject: owner.actor,
    });
    const hiddenRecipeText = await hiddenRecipeResponse.text();
    if (hiddenRecipeResponse.status !== 201) {
      throw new Error(`recipe structure ${hiddenRecipeResponse.status}: ${hiddenRecipeText}`);
    }
    const hiddenRecipe = JSON.parse(hiddenRecipeText) as { structure: string; revision: string };
    await owner.grant(`work:edit:${hiddenWork.work}`, 'recipe.edit');
    await owner.grant(`work:read:${hiddenWork.work}`, 'work.read');
    const absent = randomUUID();
    const realmInput = { name: `Hidden realm ${randomUUID()}`, actingSubject: owner.actor };
    const realm = await createRealmSpace(stack.env, stack.admission(owner.actor, 'space:create:root', 'space.create',
      spaceCreationDigest(realmInput)), realmInput);
    if (!realm.realm) throw new Error('Realm was not created');
    await owner.grant('semantic:create:root', 'semantic.change');
    const valued = await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'resource', types: ['https://schema.org/Thing'], properties: [] },
    });
    const valuedText = await valued.text();
    if (valued.status !== 201) throw new Error(`semantic resource ${valued.status}: ${valuedText}`);
    const concept = JSON.parse(valuedText) as { component: string; revision: string;
      sourcePosition: { dataEpoch: string; sequence: string } };
    await owner.grant(`semantic:read:${concept.component}`, 'semantic.read');
    await grantRecordedPlatformUse(stack.accessPool, owner.principalId, ['dataset-dumps']);
    await owner.grant(`export:${concept.revision}`, 'export.create');
    const exported = await owner.send('POST', '/v1/exports', {
      profile: 'export-create-v1', actingSubject: owner.actor, useScope: 'evaluation',
      selection: { kind: 'semantic-revision', resource: concept.component, reference: concept.revision,
        expectedPosition: { dataEpoch: concept.sourcePosition.dataEpoch, sequence: concept.sourcePosition.sequence } },
    });
    const exportedText = await exported.text();
    if (exported.status !== 201 && exported.status !== 200) throw new Error(`export ${exported.status}: ${exportedText}`);
    const manifest = JSON.parse(exportedText) as { manifestId?: string };
    if (!manifest.manifestId) throw new Error(`export ${exported.status}: ${exportedText}`);
    await owner.grant(`content:draft:${hiddenWork.work}`, 'content.draft');
    const drafted = await owner.send('POST', '/v1/content-drafts', {
      profile: 'content-text-v1', resourceId: hiddenWork.work, variantId: `urn:rezics:variant:${randomUUID()}`,
      language: { kind: 'tag', tag: 'en', originalTag: 'en' }, direction: 'ltr',
      expectedHead: null, body: 'Hidden revision body', actingSubject: owner.actor,
    });
    const draftedText = await drafted.text();
    if (drafted.status !== 201) throw new Error(`content draft ${drafted.status}: ${draftedText}`);
    const revisionId = (JSON.parse(draftedText) as { revisionId: string }).revisionId;
    const privateRealmInput = { name: `Hidden concept realm ${randomUUID()}`, actingSubject: owner.actor,
      initialSettings: { visibility: 'private' as const, reviewRequired: true, reviewMode: 'mandatory' as const,
        whoMaySubmit: 'granted' as const, selfJoin: false, rules: [] } };
    const privateRealm = await createRealmSpace(stack.env, stack.admission(owner.actor, 'space:create:root', 'space.create',
      spaceCreationDigest(privateRealmInput)), privateRealmInput);
    if (!privateRealm.realm) throw new Error('Private realm was not created');
    const conceptId = `${ID}${randomUUID()}`;
    const schemeId = `${ID}${randomUUID()}`;
    const conceptHead = `${ID}${randomUUID()}`;
    const schemeHead = `${ID}${randomUUID()}`;
    const SKOS = 'http://www.w3.org/2004/02/skos/core#';
    const vocabulary = 'https://rezics.com/definition/classification-proposition-v2';
    const graphAdmission = stack.admission(owner.actor, 'statement:speak:hidden-id', 'statement.record',
      createHash('sha256').update(conceptId).digest('hex'));
    const pathId = `${ID}${randomUUID()}`;
    const expressionId = `${ID}${randomUUID()}`;
    const senseId = `${ID}${randomUUID()}`;
    const senseHead = `${ID}${randomUUID()}`;
    const conceptValidations = await profileValidations(stack.env.fuseki, 'classification-proposition-v2', [
      ['scheme', schemeId], ['concept', conceptId], ['path', pathId],
      ['expression', expressionId], ['sense', senseId],
    ].map(([role, focus]) => ({
      shape: `${vocabulary}/${role}-shape`, focus: [focus!], graphs: [GRAPHS.current],
    })), { scheme: schemeId, concept: conceptId, path: pathId, expression: expressionId, sense: senseId });
    const recorded = await commitCommand(stack.env, graphAdmission, {
      family: 'statement-record-v1', digest: graphAdmission.requestDigest, validations: conceptValidations,
      operation: `${ID}${randomUUID()}`, component: conceptId, revision: conceptHead,
      expectedHead: null, where: `GRAPH ${iri(GRAPHS.current)} { ${iri(privateRealm.realm)} a rv:Realm . }`,
      insert: `GRAPH ${iri(GRAPHS.current)} {
          ${iri(schemeId)} a <${SKOS}ConceptScheme>, rv:VocabularyDefinition ; rv:definitionProfile ${iri(vocabulary)} ;
            rv:schemeState rv:Active ; rv:schemeRevisionHead ${iri(schemeHead)} .
          ${iri(conceptId)} a <${SKOS}Concept>, rv:VocabularyDefinition ; rv:definitionProfile ${iri(vocabulary)} ;
            <${SKOS}inScheme> ${iri(schemeId)} ; <${SKOS}prefLabel> "Hidden concept"@en ;
            rv:conceptState rv:Active ; rv:head ${iri(conceptHead)} ;
            rv:conceptRealm ${iri(privateRealm.realm)} .
          ${iri(pathId)} a rv:ConceptPath, rv:VocabularyDefinition ; rv:definitionProfile ${iri(vocabulary)} ;
            rv:pathKind rv:SingleConcept ; rv:pathLength 1 ; rv:terminalConcept ${iri(conceptId)} ;
            rv:pathState rv:Active .
          ${iri(expressionId)} a rv:ClassificationExpression, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(vocabulary)} ; rv:path ${iri(pathId)} ;
            rv:propositionKind rv:ConceptAssertion ; rv:assertedConcept ${iri(conceptId)} ;
            rv:expressionState rv:Active .
          ${iri(senseId)} a rv:ClassificationSense, rv:VocabularyDefinition ;
            rv:definitionProfile ${iri(vocabulary)} ; rv:path ${iri(pathId)} ;
            rv:expression ${iri(expressionId)} ; rv:interpretationScope <urn:rezics:classification-context:global> ;
            rv:senseState rv:Active ; rv:head ${iri(senseHead)} .
        }`,
    });
    if (!recorded) throw new Error('Hidden concept was not recorded');
    await ensureGlobalClassificationContext(stack.env);
    await owner.grant(`statement:speak:${owner.actor}`, 'statement.record');
    const defined = await owner.send('POST', '/v1/semantic/changes', {
      profile: 'semantic-change-v1', expectedHead: null, actingSubject: owner.actor,
      state: { component: 'definition', kind: 'property', lifecycle: 'active', successor: null, roles: [],
        notation: DATE_PUBLISHED_DEFINITION_NOTATION },
    });
    const definedText = await defined.text();
    if (defined.status !== 201 && defined.status !== 200) throw new Error(`definition ${defined.status}: ${definedText}`);
    const property = JSON.parse(definedText) as { component: string; revision: string };
    await owner.grant(`semantic:read:${property.component}`, 'semantic.read');
    const written = await owner.send('POST', '/v1/statements', {
      profile: 'statement-v1', speaker: { kind: 'personal' }, subject: hiddenWork.work,
      predicate: property.component, relationDefinition: property.revision,
      value: { kind: 'literal', lexical: '1980-01-01', datatype: 'http://www.w3.org/2001/XMLSchema#date', language: null },
      applicability: [], interpretation: { kind: 'selected' }, evidence: [], actingSubject: owner.actor,
    });
    const writtenText = await written.text();
    if (written.status !== 201) throw new Error(`statement ${written.status}: ${writtenText}`);
    const statementId = local((JSON.parse(writtenText) as { statement: string }).statement);
    await owner.grant('verification:claim:global', 'verification.claim-create');
    await grantRecordedPlatformUse(stack.accessPool, owner.principalId, ['wiki-agents']);
    await grantRecordedPlatformUse(stack.accessPool, outsider.principalId, ['wiki-agents']);
    const claimed = await owner.send('POST', '/v1/claims', {
      profile: 'claim-create-v1', referent: hiddenWork.work,
      interpretationContext: 'urn:rezics:context:hidden-id',
      propositionPredicate: 'https://schema.org/datePublished',
      value: { kind: 'literal', lexical: '1980-01-01', datatype: 'date' },
      valuePrecision: 'exact', valueQualifiers: [], validFrom: null, validUntil: null,
      editionScope: null, actingSubject: owner.actor,
    });
    const claimedText = await claimed.text();
    if (claimed.status !== 201) throw new Error(`claim ${claimed.status}: ${claimedText}`);
    const claimId = local((JSON.parse(claimedText) as { claim: { claim: string } }).claim.claim);
    await owner.grant(`work:read:${hiddenWork.work}`, 'work.read');

    // Compare thread disclosure only: both about targets and the Realm remain public.
    const threadAbout = await stack.publicWork(owner.actor, ['en'], 'A public discussion target');
    const noThreadAbout = await stack.publicWork(owner.actor, ['en'], 'Another public discussion target');
    const createdJson = async <T>(response: Response, expected = 201): Promise<T> => {
      const body = await response.text();
      expect(response.status, body).toBe(expected);
      return JSON.parse(body) as T;
    };
    // Reply authors need a controlled, provisioned Person; draft grants cannot replace that proof.
    const { agent: threadActor } = await createdJson<{ agent: string }>(await owner.send('POST', '/v1/agents', {
      profile: 'agent-provision-v1', kind: 'person', displayName: 'Thread equality author',
    }));
    await owner.grant('space:create:root', 'space.create');
    const threadRealm = await createdJson<{ realm: string }>(await owner.send('POST', '/v1/spaces', {
      profile: 'space-realm-v2', name: `Thread equality ${randomUUID()}`, capabilities: ['realm'],
      actingSubject: owner.actor,
    }));
    await new AccessRealmManagement(stack.accessPool).initialize(
      { ...owner.principal, emailVerified: true }, threadRealm.realm, owner.actor, stack.env);
    await owner.grant(`governance:realm:${threadRealm.realm}`, 'realm.settings.manage');
    await owner.grant(`governance:realm:${threadRealm.realm}`, 'governance.rule.publish');
    const settingsPath = `/v1/realms/${local(threadRealm.realm)}/settings`;
    const settings = await createdJson<{ generation: string; ruleBasis: { revision: string | null } }>(
      await owner.read(settingsPath), 200);
    await createdJson(await owner.send('PUT', settingsPath, { actingSubject: owner.actor,
      expectedGeneration: settings.generation, expectedRulesRevision: settings.ruleBasis.revision,
      reason: 'Set public discussion admission', settings: { visibility: 'public', reviewMode: 'open',
        reviewRequired: false, whoMaySubmit: 'granted', rules: [] },
    }));
    await owner.grant(`classification:context:${threadRealm.realm}`, 'classification.context.configure');
    const vocabularyContext = await createdJson<{ context: string; contextRevision: string }>(
      await owner.send('POST', '/v1/classification-contexts', {
        profile: 'classification-context-v1', realm: threadRealm.realm, actingSubject: owner.actor,
      }));
    const vocabularyPath = (context: string) => `/v1/classification-vocabulary?${new URLSearchParams({ context, limit: '1' })}`;
    expect((await stack.call('GET', vocabularyPath(vocabularyContext.context))).status).toBe(200);
    const [threadTarget] = await targetRead(stack.env, { access: stack.access },
      session => resolveTargets(session, [threadAbout.work], 'discussion'));
    const aboutThreads = new RealmAboutThreadStore(stack.contentPool);
    const selected = await aboutThreads.reserve({ realm: threadRealm.realm, about: threadAbout.work,
      actor: threadActor, intentKey: randomUUID(), intentDigest: createHash('sha256').update(threadAbout.work).digest('hex'),
      rootRevision: threadTarget!.revision });
    await grantFixtureAuthority(stack.accessPool, { scope: `reply:place:${threadRealm.realm}`, requireDispatch: true,
      representations: [{ principalId: owner.principalId, actor: threadActor, action: 'reply.place', lifetime: '1 hour' }],
      grant: { actor: threadActor, action: 'reply.place', lifetime: '1 hour' },
    });
    const replyDraft = await createdJson<{ revisionId: string; revisionDigest: string }>(
      await owner.send('POST', '/v1/member-reply-drafts', { profile: 'member-reply-draft-v1',
        reply: selected.reply, variantId: selected.variantId, rootTarget: threadAbout.work,
        rootRevision: selected.rootRevision, originRealm: threadRealm.realm, expectedHead: null,
        language: 'en', direction: 'ltr', body: 'The accepted opener later withheld from disclosure.',
        actingSubject: threadActor }));
    await aboutThreads.recordDraftRevision(selected.id, replyDraft.revisionId);
    const identity = {
      reply: selected.reply, variantId: selected.variantId, revisionId: replyDraft.revisionId,
      author: threadActor, rootTarget: threadAbout.work, rootRevision: selected.rootRevision,
      originRealm: threadRealm.realm, parentReply: null, parentRevision: null, contextRevision: null };
    // The canonical identity has server-only origin coordinates; the standalone
    // identity HTTP contract cannot carry them. Use the same owner as the command.
    const principal = await stack.composition.dependencies.account.verify(new Request('http://main.local', {
      headers: { authorization: `Bearer ${owner.token}` },
    }), ['work:edit']);
    await stack.composition.dependencies.realmReplies!.create(principal, identity, randomUUID(), realmReplyDigest(identity));
    await createdJson(await owner.send('POST', '/v1/realm-reply-placements', { profile: 'realm-reply-placement-v1',
      realm: threadRealm.realm, reply: selected.reply, revisionId: replyDraft.revisionId,
      revisionDigest: replyDraft.revisionDigest, reviewDecisionId: null, expectedHead: null, actingSubject: threadActor }));
    const preparation = await stack.contentPool.query<{ operation_id: string }>(
      'SELECT operation_id FROM content.realm_placement_preparation WHERE realm=$1 AND variant_id=$2 AND revision_id=$3',
      [threadRealm.realm, selected.variantId, replyDraft.revisionId]);
    expect(preparation.rows).toHaveLength(1);
    const placement = await readReplyGraphReceipt(stack.env,
      { id: preparation.rows[0]!.operation_id, action: 'reply.place' });
    expect(placement?.outcome).toBe('succeeded');
    await aboutThreads.recordPosted(selected.id, preparation.rows[0]!.operation_id, placement!.receipt);
    const aboutPath = (about: string) => `/v1/realms/${local(threadRealm.realm!)}/about-thread?${new URLSearchParams({ about })}`;
    const visibleThread = await stack.call('GET', aboutPath(threadAbout.work));
    expect(visibleThread.status).toBe(200);
    expect(await visibleThread.json()).toMatchObject({ thread: { reply: selected.reply, rootRevision: selected.rootRevision } });

    // Committed owner disclosure fixture, with real case/decision/target references.
    // Admission of moderation decisions is covered by the governance suites.
    await owner.grant('governance:platform', 'governance.moderate');
    const caseId = randomUUID(), decisionId = randomUUID(), fenceId = randomUUID();
    const disclosureClient = await stack.accessPool.connect();
    try {
      await disclosureClient.query('BEGIN');
      await disclosureClient.query(`INSERT INTO access.governance_case
        (id,kind,authority_kind,authority_scope_id,context,target_owner,target_resource,target_component,disclosure)
        VALUES ($1,'content_report','platform','governance:platform','urn:rezics:context:global','content',$2,'body','private')`,
      [caseId, selected.reply]);
      await disclosureClient.query(`INSERT INTO access.moderation_decision
        (id,kind,outcome,context,case_id,case_sequence,principal_id,acting_subject,authority_kind,authority_scope_id,
        authority_epoch,authority_proof_digest,idempotency_key,request_digest,rule_ref,rule_revision,rule_digest,evidence_digest,disclosure,statement_of_reasons)
        VALUES ($1::uuid,'content_moderation','restrict','urn:rezics:context:global',$2,1,$3,$4,'platform','governance:platform',
        0,$5,$1::text,$5,'urn:rezics:rule:hidden-about-thread','1',$5,$5,'private',$6::jsonb)`,
      [decisionId, caseId, owner.principalId, owner.actor, 'a'.repeat(64), {
        facts: 'The accepted discussion opener is withheld from public disclosure.', scope: 'This exact reply body revision.',
        duration: 'Until an attributable restoration.', automation: false,
        appealRoute: '/v1/public-reports/{caseId}/correspondence', contentLanguage: 'en',
        rule: { ref: 'urn:rezics:rule:hidden-about-thread', revision: '1', digest: 'a'.repeat(64) },
      }]);
      await disclosureClient.query(`INSERT INTO access.moderation_decision_target
        (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
        VALUES ($1,1,'content',$2,'body','exact_revision',$3,$3,'disclosure')`,
      [decisionId, selected.reply, replyDraft.revisionId]);
      await disclosureClient.query(`INSERT INTO access.governance_enforcement
        (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
        VALUES ($1,'governance:platform','urn:rezics:context:global','content',$2,'body',$3,'disclosure',$4,1,'restricted',1)`,
      [fenceId, selected.reply, replyDraft.revisionId, decisionId]);
      await disclosureClient.query(`INSERT INTO access.moderation_decision_target
        (decision_id,ordinal,owner,resource,component,scope_kind,revision,expected_head,effect)
        VALUES ($1,2,'graph',$2,'record','exact_revision',$3,$3,'disclosure')`,
      [decisionId, vocabularyContext.context, vocabularyContext.contextRevision]);
      await disclosureClient.query(`INSERT INTO access.governance_enforcement
        (id,authority_scope_id,context,owner,resource,component,revision,effect,decision_id,decision_ordinal,state,fence_epoch)
        VALUES ($1,'governance:platform','urn:rezics:context:global','graph',$2,'record',$3,'disclosure',$4,2,'restricted',1)`,
      [randomUUID(), vocabularyContext.context, vocabularyContext.contextRevision, decisionId]);
      await disclosureClient.query('UPDATE access.governance_case SET decision_head=$2,generation=1 WHERE id=$1', [caseId, decisionId]);
      await disclosureClient.query('COMMIT');
    } catch (error) {
      await disclosureClient.query('ROLLBACK');
      throw error;
    } finally { disclosureClient.release(); }
    const hiddenThread = await stack.call('GET', aboutPath(threadAbout.work));
    expect(hiddenThread.status).toBe(200);
    expect(await hiddenThread.json()).toEqual({ realm: threadRealm.realm, about: threadAbout.work, thread: null });
    expect(await aboutThreads.readThread(threadRealm.realm, noThreadAbout.work)).toBeNull();
    const hiddenVocabulary = await stack.call('GET', vocabularyPath(vocabularyContext.context));
    expect(hiddenVocabulary.status).toBe(200);
    expect(await hiddenVocabulary.json()).toMatchObject({ context: vocabularyContext.context,
      items: [], hasMore: false, nextCursor: null, count: { value: 0, kind: 'exact-page', total: null } });

    const http = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await stack.call(method, path, { token, body, ...(body ? { key: randomUUID() } : {}) });
      bytes += (await response.clone().arrayBuffer()).byteLength;
      return response;
    };
    const readCounters = async (): Promise<HiddenIdCounters> => {
      countSql = false;
      try {
        const media = await stack.contentPool.query<{ n: number }>('SELECT count(*)::int AS n FROM media.transform_job');
        const rate = await stack.accessPool.query<{ n: string }>('SELECT coalesce(sum(count), 0)::int AS n FROM access.rate_limit_v1');
        return {
          graphCalls: stack.fuseki.queries,
          sqlStatements: statements,
          bytes,
          mediaGenerations: media.rows[0]!.n,
          rateLimitCharges: Number(rate.rows[0]!.n),
        };
      } finally { countSql = true; }
    };
    const outsiderQuery = (path: string) => {
      const url = new URL(path, 'http://main.local');
      url.searchParams.set('actingSubject', outsider.actor);
      return `${url.pathname}${url.search}`;
    };
    const workId = local(hiddenWork.work);
    const realmId = local(realm.realm);
    const calls = new Map<string, { hidden: string; absent: string; call: (id: string) => Promise<Response> }>();
    calls.set('GET /v1/classification-vocabulary', {
      hidden: vocabularyContext.context, absent: `${ID}${absent}`,
      call: (context) => http('GET', vocabularyPath(context)),
    });
    for (const operation of registeredHiddenIdReads) {
      if (operation.startsWith('GET /v1/works/')) {
        const path = operation.slice('GET '.length);
        calls.set(operation, {
          hidden: workId, absent,
          call: (id) => http('GET', path.replace('{id}', id)),
        });
      }
    }
    calls.set('GET /v1/realms/{realm}/members', {
      hidden: realmId, absent,
      call: (id) => http('GET', outsiderQuery(`/v1/realms/${id}/members`), undefined, outsider.token),
    });
    calls.set('GET /v1/realms/{realm}/roles', {
      hidden: realmId, absent,
      call: (id) => http('GET', outsiderQuery(`/v1/realms/${id}/roles`), undefined, outsider.token),
    });
    calls.set('GET /v1/realms/{realm}/about-thread', {
      hidden: threadAbout.work, absent: noThreadAbout.work,
      call: (about) => http('GET', aboutPath(about)),
    });
    calls.set('GET /v1/exports/{export}', {
      hidden: manifest.manifestId, absent,
      call: (id) => http('GET', `/v1/exports/${id}`, undefined, outsider.token),
    });
    calls.set('GET /v1/concepts/{id}', {
      hidden: local(conceptId), absent,
      call: (id) => http('GET', `/v1/concepts/${id}`),
    });
    calls.set('GET /v1/statements/{id}', {
      hidden: statementId, absent,
      call: (id) => http('GET', `/v1/statements/${id}`),
    });
    calls.set('GET /v1/works/{id}/maintainers', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/works/${id}/maintainers`),
    });
    calls.set('POST /v1/recipes/{id}/file-imports', {
      hidden: local(hiddenRecipe.structure), absent,
      call: (id) => http('POST', outsiderQuery(`/v1/recipes/${id}/file-imports?expectedHead=${encodeURIComponent(
        hiddenRecipe.revision)}`), { '@type': 'Recipe' }, outsider.token),
    });
    const ownedClaim = await http('GET',
      `/v1/claims/${claimId}?actingSubject=${encodeURIComponent(owner.actor)}`, undefined, owner.token);
    expect(ownedClaim.status).toBe(200);
    expect((await ownedClaim.json() as { claim: { claim: string } }).claim.claim).toBe(`${ID}${claimId}`);
    const withheldClaim = await http('GET',
      `/v1/claims/${claimId}?actingSubject=${encodeURIComponent(outsider.actor)}`, undefined, outsider.token);
    const missingClaim = await http('GET',
      `/v1/claims/${absent}?actingSubject=${encodeURIComponent(outsider.actor)}`, undefined, outsider.token);
    expect(withheldClaim.status).toBe(missingClaim.status);
    expect(comparableBody(await withheldClaim.text(), claimId)).toBe(comparableBody(await missingClaim.text(), absent));
    const statementsBefore = statements;
    const absentComments = await http('GET', outsiderQuery(`/v1/content-revisions/${absent}/comments`),
      undefined, outsider.token);
    expect(absentComments.status).toBe(404);
    // One content lookup. The absent revision does not take Work admission.
    expect(statements - statementsBefore).toBe(1);
    expect((await http('GET', outsiderQuery(`/v1/content-revisions/${revisionId}/comments`),
      undefined, outsider.token)).status).toBe(404);
    expect([...calls.keys()].sort()).toEqual([...registeredHiddenIdReads]);
    for (const operation of registeredHiddenIdReads) {
      const spec = calls.get(operation)!;
      if (operation === 'POST /v1/recipes/{id}/file-imports') {
        const hidden = await spec.call(spec.hidden);
        const absent = await spec.call(spec.absent);
        expect(hidden.status).toBe(404);
        expect(absent.status).toBe(404);
        expect(await hidden.text()).toBe(await absent.text());
        continue;
      }
      await assertHiddenIdEquality({ operation, hiddenId: spec.hidden, absentId: spec.absent,
        call: spec.call, readCounters });
    }
  } finally {
    prototype.query = originalQuery;
    poolPrototype.connect = originalConnect;
    await stack.stop();
  }
}, 300_000);
