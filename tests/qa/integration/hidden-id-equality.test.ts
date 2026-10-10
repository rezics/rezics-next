import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createRealmSpace, spaceCreationDigest } from '../../../services/main/src/modules/space/create.ts';
import { ensureGlobalClassificationContext } from '../../../services/main/src/modules/classification/global.ts';
import { commitCommand } from '../../../services/main/src/modules/context/command.ts';
import { profileValidations } from '../../../services/main/src/infrastructure/profile.ts';
import { DATE_PUBLISHED_DEFINITION_NOTATION } from '../../../services/main/src/modules/statement/qualification.ts';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
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
  let statements = 0;
  let countSql = true;
  let bytes = 0;
  prototype.query = function (this: unknown, ...args: unknown[]) {
    if (countSql && foregroundCounted()) statements++;
    return originalQuery.apply(this, args);
  };
  try {
    const owner = await stack.member('hidden-owner');
    const outsider = await stack.member('hidden-outsider');
    const hiddenWork = await stack.privateWork(owner.actor, `Hidden work ${randomUUID()}`);
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
    calls.set('GET /v1/exports/{export}', {
      hidden: manifest.manifestId, absent,
      call: (id) => http('GET', `/v1/exports/${id}`, undefined, outsider.token),
    });
    const workIri = hiddenWork.work;
    calls.set('GET /v1/addresses/resolve', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/addresses/resolve?scope=resource&key=${encodeURIComponent(id)}`),
    });
    calls.set('GET /v1/concepts/{id}', {
      hidden: local(conceptId), absent,
      call: (id) => http('GET', `/v1/concepts/${id}`),
    });
    calls.set('GET /v1/public-previews/{resource}', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/public-previews/${id}`),
    });
    calls.set('GET /v1/resources/{resource}', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/resources/${id}`),
    });
    calls.set('GET /v1/statements/{id}', {
      hidden: statementId, absent,
      call: (id) => http('GET', `/v1/statements/${id}`),
    });
    calls.set('GET /v1/works/{id}/history', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/works/${id}/history`),
    });
    calls.set('GET /v1/works/{id}/maintainers', {
      hidden: workId, absent,
      call: (id) => http('GET', `/v1/works/${id}/maintainers`),
    });
    calls.set('POST /v1/resources/summaries', {
      hidden: workIri, absent: `${ID}${absent}`,
      call: (id) => http('POST', '/v1/resources/summaries', {
        profile: 'resource-summary-batch-v1', resources: [id],
      }),
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
      await assertHiddenIdEquality({ operation, hiddenId: spec.hidden, absentId: spec.absent,
        call: spec.call, readCounters });
    }
  } finally {
    prototype.query = originalQuery;
    await stack.stop();
  }
}, 300_000);
