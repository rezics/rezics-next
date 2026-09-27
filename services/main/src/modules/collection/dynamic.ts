import { readWorkComponentState } from '../work/history.ts';
import { queryPublicMainPhrase, queryPublicRealmPhrase } from '../work/search-public.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { compositionReceiptIri, readCompositionReceipt, sealStructureAdmissionCancellation,
  terminalResult } from '../structure/change.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';

export const COLLECTION_PROFILE = 'https://rezics.com/definition/collection-curation-v1';
export const DYNAMIC_QUERY_COST = { definitionGraphReads: 1, definitionObjectReads: 2,
  fullTextCandidateProbe: 512, maxSnapshotMembers: 16, memberWritesPerCapture: 16 } as const;

export class DynamicCollectionUnavailable extends Error {}
export class InvalidDynamicCollection extends Error {}
export class DynamicCollectionStale extends Error {}

export interface DynamicQuery {
  phrase: string;
  language: string | null;
  context?: { kind: 'realm-local'; id: string };
}

export function checkDynamicQuery(query: DynamicQuery, resultBudget: number): void {
  if (typeof query.phrase !== 'string' || query.phrase.length < 2 || query.phrase.length > 80
    || /[\u0000-\u001f\u007f]/u.test(query.phrase)
    || query.language !== null && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(query.language)
    || query.context && (query.context.kind !== 'realm-local'
      || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(query.context.id))
    || !Number.isInteger(resultBudget) || resultBudget < 1
    || resultBudget > DYNAMIC_QUERY_COST.maxSnapshotMembers) {
    throw new InvalidDynamicCollection('Dynamic Collection query is invalid');
  }
}

/** One exact saved definition revision; no result cache or membership is read here. */
export async function readDynamicDefinition(env: WorkActivationEnvironment, definition: string,
  revision?: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?head ?revision ?manifest
    ?budget ?profile ?disclosure ?name WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(definition)} a rv:DynamicCollection ;
        rv:collectionState rv:Active ; rv:definitionHead ?head ; rv:disclosure ?disclosure ;
        <https://schema.org/name> ?name . }
      ${revision ? `BIND(${iri(revision)} AS ?revision)` : 'BIND(?head AS ?revision)'}
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:DynamicCollectionRevision ;
        rv:component ${iri(definition)} ; rv:manifest ?manifest ; rv:resultBudget ?budget ;
        rv:queryProfile ?profile . }
    } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.head || !rows[0]?.revision || !rows[0]?.manifest
    || !rows[0]?.budget || !rows[0]?.profile || !rows[0]?.disclosure || !rows[0]?.name) {
    throw new DynamicCollectionUnavailable('Dynamic Collection is unavailable');
  }
  const row = rows[0]!;
  const state = await readWorkComponentState(env, row.manifest!.value, definition, COLLECTION_PROFILE);
  const query = state.query as DynamicQuery | undefined;
  const resultBudget = Number(row.budget!.value);
  if (!query || state.resultBudget !== resultBudget) {
    throw new DynamicCollectionUnavailable('Dynamic Collection definition is incomplete');
  }
  checkDynamicQuery(query, resultBudget);
  if (row.profile!.value !== (query.context
    ? 'https://rezics.com/definition/public-realm-phrase-v1'
    : 'https://rezics.com/definition/public-main-phrase-v1')) {
    throw new DynamicCollectionUnavailable('Dynamic Collection query profile differs');
  }
  return { definition, revision: row.revision!.value, head: row.head!.value,
    name: row.name!.value, disclosure: row.disclosure!.value === `${RV}Public` ? 'public' as const : 'private' as const,
    query, resultBudget, cost: { graphReads: 1, objectReads: 2 } };
}

/** Public search returns a complete relation or fails closed; only this bounded prefix is captured. */
export async function executeDynamicDefinition(env: WorkActivationEnvironment,
  saved: Awaited<ReturnType<typeof readDynamicDefinition>>) {
  const relation = saved.query.context
    ? await queryPublicRealmPhrase(env, { phrase: saved.query.phrase,
      language: saved.query.language, context: saved.query.context })
    : await queryPublicMainPhrase(env, { phrase: saved.query.phrase,
      language: saved.query.language });
  const selected = relation.results.slice(0, saved.resultBudget);
  return { definition: saved.definition, revision: saved.revision,
    total: relation.total, coverage: relation.total <= saved.resultBudget ? 'complete' as const : 'partial' as const,
    members: selected.map(item => ({ work: item.work, selection: item.selection })),
    sourcePosition: relation.sourcePosition,
    cost: { fullTextQueries: 1, candidateProbe: DYNAMIC_QUERY_COST.fullTextCandidateProbe,
      membersSelected: selected.length } };
}

/** A captured Collection's owner manifest freezes the original query result across retries. */
export async function readCapturedSnapshot(env: WorkActivationEnvironment, collection: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?source ?coverage ?manifest WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ;
      rv:collectionKind rv:CapturedCollection ; rv:capturedFrom ?source ;
      rv:captureCoverage ?coverage ; rv:collectionHead ?head . }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:CollectionRevision ;
      rv:component ${iri(collection)} ; rv:manifest ?manifest . } } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.source || !rows[0]?.coverage || !rows[0]?.manifest) return null;
  const row = rows[0]!;
  const state = await readWorkComponentState(env, row.manifest!.value, collection, COLLECTION_PROFILE);
  const capture = state.capture as { from?: string; coverage?: string;
    members?: { work: string; selection: string }[];
    sourcePosition?: { datasetId: 'product'; dataEpoch: string; sequence: string } } | undefined;
  if (capture?.from !== row.source!.value
    || (row.coverage!.value === `${RV}Complete` ? 'complete' : 'partial') !== capture.coverage
    || !Array.isArray(capture.members)
    || capture.members.length > DYNAMIC_QUERY_COST.maxSnapshotMembers
    || !capture.sourcePosition || capture.coverage !== 'complete' && capture.coverage !== 'partial') {
    throw new DynamicCollectionUnavailable('Captured Collection manifest differs');
  }
  return capture as { from: string; coverage: 'complete' | 'partial';
    members: { work: string; selection: string }[];
    sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string } };
}

export interface ReviseDynamicDefinitionInput {
  definition: string; expectedHead: string; actingSubject: string; idempotencyKey: string;
  query: DynamicQuery; resultBudget: number;
}

/** One exact-head query-rule revision; it never mutates a captured Collection. */
export async function reviseDynamicDefinition(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: ReviseDynamicDefinitionInput) {
  checkDynamicQuery(input.query, input.resultBudget);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const digest = hash(JSON.stringify({ family: 'dynamic-collection-revise-v1', ...input,
    idempotencyKey: undefined }));
  const principal = await account.verify(request, ['collection:edit']);
  const scope = `collection:edit:${input.definition}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'collection.edit', idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealStructureAdmissionCancellation(env, admission);
  } else if (admission.state !== 'sealed'
    && !await readCompositionReceipt(env, admission.id, admission.action)) {
    const current = await readDynamicDefinition(env, input.definition);
    if (current.head !== input.expectedHead) {
      const cancelled = await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id, cancelled);
      throw new DynamicCollectionStale('Dynamic Collection head changed');
    }
    const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const manifest = prepareComponent(env.objectDirectory, input.definition, {
      kind: 'definition', owner: input.definition, actingSubject: input.actingSubject,
      query: input.query, resultBudget: input.resultBudget }, COLLECTION_PROFILE);
    const receipt = compositionReceiptIri(admission.id, admission.action);
    const batch = `urn:rezics:outbox:${hash(receipt)}`;
    const event = `urn:rezics:event:${hash(operation)}`;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.definition)} rv:definitionHead ${iri(input.expectedHead)} . } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.definition)} rv:definitionHead ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:DynamicCollectionRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.definition)} ; rv:predecessor ${iri(input.expectedHead)} ;
          rv:operation ${iri(operation)} ; rv:definitionOperation rv:DynamicCollectionRevise ;
          rv:queryProfile ${iri(input.query.context
            ? 'https://rezics.com/definition/public-realm-phrase-v1'
            : 'https://rezics.com/definition/public-main-phrase-v1')} ;
          rv:resultBudget ${input.resultBudget} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(COLLECTION_PROFILE)} ; rv:shapeRevision ${iri(COLLECTION_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(scope)} ; rv:outcome rv:Succeeded ;
          rv:structureOwner ${iri(input.definition)} ; rv:structureRevision ${iri(revision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:DynamicCollectionReviseEvent ; rv:ordinal 0 ;
            rv:action "collection.edit" ; rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} . }
      }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.definition)} a rv:DynamicCollection ;
          rv:collectionState rv:Active ; rv:definitionHead ${iri(input.expectedHead)} . }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'collection-curation-v1', [
      { shape: `${COLLECTION_PROFILE}/definition-shape`, focus: [input.definition],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${COLLECTION_PROFILE}/definition-revision-shape`, focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    try { await validatedCommand(env, { receipt, digest, update, validations,
      deadlineMs: 10_000 }, admission); }
    catch { /* A lost graph response is resolved by the durable receipt. */ }
    if (!await readCompositionReceipt(env, admission.id, admission.action)) {
      const now = await readDynamicDefinition(env, input.definition);
      if (now.head !== input.expectedHead) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw new DynamicCollectionStale('Dynamic Collection head changed');
      }
    }
  }
  const terminal = await readCompositionReceipt(env, registered.id, registered.action);
  if (!terminal) throw new PendingActivation('Dynamic Collection revision outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  terminalResult(terminal, registered);
  if (terminal.owner !== input.definition || terminal.requestDigest !== digest
    || !terminal.revision) throw new IdempotencyConflict('Dynamic Collection receipt differs');
  return { definition: input.definition, revision: terminal.revision, receipt: terminal.receipt,
    replayed: registered.replayed, sourcePosition: { datasetId: 'product' as const,
      dataEpoch: terminal.dataEpoch, sequence: terminal.sequence } };
}
