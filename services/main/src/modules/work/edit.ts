import { structureTypeRemovalGuard } from '../structure/profiles.ts';
import { genericWorkType } from './work-kinds.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt, validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { CONTINUITY, DATASET, GRAPHS, ID, PROFILE, RV, hash, iri, lit,
  metadataWorkRequestDigest, prepareComponent, prepareWorkComponent, workMetadataValidations,
  normalizeWorkSemanticTypes, PendingActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { checkedWorkTypes, WorkTypeConflict, WORK_TYPE_PROFILE } from './type-schema.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { POST_REVISION_PROFILE, readPostPayloadForRevision, readWorkPayloadForRevision, RevisionCorrupt } from './history.ts';
import { unerased } from './public-patterns.ts';
import { checkedWorkScalarValue, sameScalar, scalarFromBinding, scalarRdfTerm,
  SCALAR_PREDICATE, type WorkScalarValue } from './scalar-value.ts';

export class StaleWorkHead extends Error {}
export class WorkEditUnavailable extends Error {}

export interface EditMetadataWorkIntent {
  admission: Pick<RegisteredAdmission, 'id' | 'scope' | 'action' | 'requestDigest' | 'authorityEpoch' | 'expiresAt'>
    & Partial<Pick<RegisteredAdmission, 'actingSubject'>>;
  work: string;
  expectedHead: string;
  title: string;
}

export interface SetWorkScalarIntent extends Omit<EditMetadataWorkIntent, 'title'> {
  scalarValue?: WorkScalarValue;
}

export interface SetWorkTypesIntent extends Omit<EditMetadataWorkIntent, 'title'> {
  types: readonly string[];
}

export interface WorkEditReceipt {
  work: string;
  revision: string;
  predecessor: string;
  receipt: string;
  admissionId: string;
  dataEpoch: string;
  sequence: string;
  replayed: boolean;
}

export interface TerminalWorkEdit {
  outcome: 'succeeded' | 'cancelled';
  reason?: 'stale-head';
  work?: string;
  revision?: string;
  predecessor?: string;
  receipt: string;
  admissionId: string;
  requestDigest: string;
  authorityEpoch: string;
  scope: string;
  dataEpoch: string;
  sequence: string;
}

export function metadataWorkEditDigest(work: string, expectedHead: string, title: string): string {
  iri(work);
  iri(expectedHead);
  metadataWorkRequestDigest(title);
  return hash(JSON.stringify({ family: 'edit-metadata-work-v1', work, expectedHead, title }));
}

export function workScalarEditDigest(work: string, expectedHead: string,
  scalarValue: WorkScalarValue | undefined): string {
  iri(work); iri(expectedHead);
  return hash(JSON.stringify({ family: 'work-scalar-state-v1', work, expectedHead,
    ...(scalarValue === undefined ? {} : { scalarValue: checkedWorkScalarValue(scalarValue) }) }));
}

export function workTypeEditDigest(work: string, expectedHead: string,
  types: readonly string[]): string {
  iri(work); iri(expectedHead);
  return hash(JSON.stringify({ family: 'work-type-v2', work, expectedHead,
    types: checkedWorkTypes(types) }));
}

export function workEditReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${hash(`${admissionId}\0edit-metadata-work`)}`;
}

export async function readWorkEditTerminalReceipt(env: WorkActivationEnvironment, admissionId: string): Promise<TerminalWorkEdit | null> {
  const receipt = workEditReceiptIri(admissionId);
  const owned = await env.receiptCustody?.resolve(receipt);
  if (owned) {
    if (!owned.predecessor) throw new WorkEditUnavailable('Custodied edit receipt has no predecessor');
    return { outcome: owned.outcome, work: owned.work, revision: owned.revision, predecessor: owned.predecessor,
      receipt: owned.receipt, admissionId: owned.admissionId, requestDigest: owned.requestDigest,
      authorityEpoch: owned.authorityEpoch, scope: owned.scope, dataEpoch: owned.dataEpoch, sequence: owned.sequence };
  }
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?reason ?digest ?admissionId ?authorityEpoch ?scope ?work ?revision ?predecessor ?sequence ?epoch WHERE {
      GRAPH <${GRAPHS.receipts}> {
        <${receipt}> rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:admissionId ?admissionId ;
          rv:authorityEpoch ?authorityEpoch ; rv:admittedScope ?scope ; rv:sequence ?sequence ; rv:dataEpoch ?epoch .
        OPTIONAL { <${receipt}> rv:reason ?reason }
        OPTIONAL { <${receipt}> rv:work ?work ; rv:workRevision ?revision ; rv:expectedHead ?predecessor }
      }
    }`);
  const rows = result.results?.bindings ?? [];
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('Work edit receipt cardinality violation');
  const row = rows[0]!;
  if (!row.digest || !row.admissionId || !row.authorityEpoch || !row.scope || !row.sequence || !row.epoch) {
    throw new Error('incomplete Work edit receipt');
  }
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (!outcome) throw new Error('unknown Work edit outcome');
  const reason = row.reason?.value === `${RV}StaleHead` ? 'stale-head' : undefined;
  if (outcome === 'succeeded' && (!row.work || !row.revision || !row.predecessor)) {
    throw new Error('successful Work edit has no result');
  }
  if (outcome === 'cancelled' && (row.work || row.revision || row.predecessor)) {
    throw new Error('cancelled Work edit has a result');
  }
  return { outcome, ...(reason ? { reason } : {}),
    ...(row.work ? { work: row.work.value, revision: row.revision!.value,
      predecessor: row.predecessor!.value } : {}),
    receipt, admissionId: row.admissionId.value, requestDigest: row.digest.value,
    authorityEpoch: row.authorityEpoch.value, scope: row.scope.value,
    dataEpoch: row.epoch.value, sequence: row.sequence.value };
}

function checkedTerminal(terminal: TerminalWorkEdit,
  intent: Omit<EditMetadataWorkIntent, 'title'>, digest: string): WorkEditReceipt {
  if (terminal.admissionId !== intent.admission.id || terminal.requestDigest !== digest
    || terminal.authorityEpoch !== intent.admission.authorityEpoch || terminal.scope !== intent.admission.scope) {
    throw new IdempotencyConflict('Work edit receipt does not match admission');
  }
  if (terminal.outcome === 'cancelled') {
    if (terminal.reason === 'stale-head') throw new StaleWorkHead('expected Work head is stale');
    throw new WorkEditUnavailable('Work edit was cancelled');
  }
  if (terminal.work !== intent.work || terminal.predecessor !== intent.expectedHead) {
    throw new IdempotencyConflict('Work edit receipt targets another intent');
  }
  return { work: terminal.work, revision: terminal.revision!, predecessor: terminal.predecessor,
    receipt: terminal.receipt, admissionId: terminal.admissionId,
    dataEpoch: terminal.dataEpoch, sequence: terminal.sequence, replayed: true };
}

async function sealStaleHead(env: WorkActivationEnvironment,
  intent: Omit<EditMetadataWorkIntent, 'title'>, digest: string): Promise<TerminalWorkEdit | null> {
  const receipt = workEditReceiptIri(intent.admission.id);
  const batch = `urn:rezics:outbox:${hash(`${receipt}\0stale`)}`;
  const event = `urn:rezics:event:${hash(`${receipt}\0stale`)}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(intent.admission.id)} ; rv:authorityEpoch ${lit(intent.admission.authorityEpoch)} ;
          rv:admittedScope ${lit(intent.admission.scope)} ; rv:outcome rv:Cancelled ; rv:reason rv:StaleHead ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
      }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkEditRejectedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
          rv:receipt ${iri(receipt)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ?currentHead . }
      FILTER(?currentHead != ${iri(intent.expectedHead)})
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} . } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const dispatch = async () => { await env.fuseki.commandWithReceipt({ receipt, digest, update, validations: [], deadlineMs: 10_000 }); };
  try {
    if (env.receiptCustody) await env.receiptCustody.guardCancellation(receipt, dispatch);
    else await dispatch();
  }
  catch { /* resolve the same receipt after an ambiguous response */ }
  return readWorkEditTerminalReceipt(env, intent.admission.id);
}

/** Strong closure races this terminal cancellation against the original edit. */
export async function sealMetadataWorkEditAdmission(
  env: WorkActivationEnvironment, admission: RegisteredAdmission,
): Promise<TerminalWorkEdit> {
  if (admission.action !== 'work.edit') throw new Error('unsupported edit admission');
  const existing = await readWorkEditTerminalReceipt(env, admission.id);
  if (existing) {
    if (existing.admissionId !== admission.id || existing.requestDigest !== admission.requestDigest
      || existing.scope !== admission.scope || existing.authorityEpoch !== admission.authorityEpoch) {
      throw new IdempotencyConflict('edit receipt differs from Access admission');
    }
    return existing;
  }
  const receipt = workEditReceiptIri(admission.id);
  const eventHash = hash(`${receipt}\0cancel`);
  const batch = `urn:rezics:outbox:${eventHash}`;
  const event = `urn:rezics:event:${eventHash}`;
  const update = `PREFIX rv: <${RV}>
    DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:requestDigest ${lit(admission.requestDigest)} ; rv:admissionId ${lit(admission.id)} ;
        rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
        rv:outcome rv:Cancelled ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:AdmissionCancelledEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
          rv:receipt ${iri(receipt)} ; rv:admissionId ${lit(admission.id)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const dispatch = async () => { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest,
    update, validations: [], deadlineMs: 10_000 }); };
  try {
    if (env.receiptCustody) await env.receiptCustody.guardCancellation(receipt, dispatch);
    else await dispatch();
  }
  catch { /* resolve the same receipt after a lost response */ }
  const terminal = await readWorkEditTerminalReceipt(env, admission.id);
  if (!terminal) throw new PendingActivation('Work edit cancellation outcome is unknown');
  if (terminal.admissionId !== admission.id || terminal.requestDigest !== admission.requestDigest
    || terminal.scope !== admission.scope || terminal.authorityEpoch !== admission.authorityEpoch) {
    throw new IdempotencyConflict('edit receipt differs from Access admission');
  }
  return terminal;
}

/** Internal guarded Work title edit; Access binding is the next boundary. */
export async function editMetadataWork(env: WorkActivationEnvironment, intent: EditMetadataWorkIntent,
  fenceNativePost?: (commit: () => Promise<void>) => Promise<void>): Promise<WorkEditReceipt> {
  return editWorkRevision(env, intent, { kind: 'title', title: intent.title }, fenceNativePost);
}

export async function setWorkScalar(env: WorkActivationEnvironment,
  intent: SetWorkScalarIntent): Promise<WorkEditReceipt> {
  return editWorkRevision(env, intent, { kind: 'scalar', value: checkedWorkScalarValue(intent.scalarValue) });
}

export async function setWorkTypes(env: WorkActivationEnvironment,
  intent: SetWorkTypesIntent): Promise<WorkEditReceipt> {
  return editWorkRevision(env, intent, { kind: 'types', types: checkedWorkTypes(intent.types) });
}

async function editWorkRevision(env: WorkActivationEnvironment,
  intent: EditMetadataWorkIntent | SetWorkScalarIntent | SetWorkTypesIntent,
  change: { kind: 'title'; title: string } | { kind: 'scalar'; value: WorkScalarValue | undefined }
    | { kind: 'types'; types: string[] },
  fenceNativePost?: (commit: () => Promise<void>) => Promise<void>,
): Promise<WorkEditReceipt> {
  if (intent.admission.action !== 'work.edit' || !/^[0-9a-f-]{36}$/.test(intent.admission.id)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(intent.work)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(intent.expectedHead)
    || intent.admission.actingSubject !== undefined
      && !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(intent.admission.actingSubject)
    || !/^[0-9]+$/.test(intent.admission.authorityEpoch)) throw new Error('invalid Work edit admission');
  const digest = change.kind === 'title'
    ? metadataWorkEditDigest(intent.work, intent.expectedHead, change.title)
    : change.kind === 'scalar' ? workScalarEditDigest(intent.work, intent.expectedHead, change.value)
      : workTypeEditDigest(intent.work, intent.expectedHead, change.types);
  if (digest !== intent.admission.requestDigest) throw new IdempotencyConflict('Work edit digest differs');
  await assertNotInvalidProfileReceipt(env.fuseki, workEditReceiptIri(intent.admission.id));
  const existing = await readWorkEditTerminalReceipt(env, intent.admission.id);
  if (existing) return checkedTerminal(existing, intent, digest);
  if (Date.parse(intent.admission.expiresAt) <= Date.now()) throw new PendingActivation('Work edit admission expired');
  const current = await env.fuseki.query(`PREFIX rv: <${RV}>
    PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    SELECT ?main ?head ?type ?title ?scalar ?manifest ?model ?shape ?publisher WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ?head ; rdfs:label ?title ; a ?type .
      OPTIONAL { ${iri(intent.work)} rv:mainVersion ?main }
      OPTIONAL { ${iri(intent.work)} rv:publisher ?publisher }
      OPTIONAL { ${iri(intent.work)} <${SCALAR_PREDICATE}> ?scalar } }
    GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:RevisionAnchor ;
      rv:component ${iri(intent.work)} ; rv:manifest ?manifest ;
      rv:modelRevision ?model ; rv:shapeRevision ?shape .
      FILTER NOT EXISTS { ?head a rv:ErasedRevision } }
    ${unerased(iri(intent.work))}
  } LIMIT 25`);
  const rows = current.results?.bindings ?? [];
  if (!rows.length || rows.some(row => !row.head || !row.type || !row.title || !row.manifest || !row.model || !row.shape)) {
    throw new WorkEditUnavailable('Work is unavailable');
  }
  const mains = new Set(rows.flatMap(row => row.main ? [row.main.value] : []));
  const heads = new Set(rows.map(row => row.head!.value));
  const types = new Set(rows.map(row => row.type!.value));
  const titles = new Set(rows.map(row => row.title!.value));
  const manifests = new Set(rows.map(row => row.manifest!.value));
  const models = new Set(rows.map(row => row.model!.value));
  const shapes = new Set(rows.map(row => row.shape!.value));
  const publishers = new Set(rows.flatMap(row => row.publisher ? [row.publisher.value] : []));
  const nativePost = models.size === 1 && models.has(POST_REVISION_PROFILE);
  const scalarBindings = rows.map(row => row.scalar).filter(binding => binding !== undefined);
  const scalarKeys = new Set(scalarBindings.map(binding => JSON.stringify(binding)));
  if (heads.size !== 1 || manifests.size !== 1 || models.size !== 1 || shapes.size !== 1
    || !shapes.has([...models][0]!) || (nativePost
      ? change.kind !== 'title' || types.size !== 1 || !types.has(`${RV}Post`) || mains.size !== 0
        || publishers.size !== 1 || scalarBindings.length !== 0 || rows.length > 24
      : !models.has(PROFILE) || mains.size !== 1 || rows.some(row => !row.main)
        || types.size !== rows.length || titles.size !== 1 || scalarKeys.size > 1
        || !types.has('https://schema.org/CreativeWork'))) {
    throw new WorkEditUnavailable('Work is unavailable');
  }
  let semanticTypes: string[];
  try { semanticTypes = nativePost ? [] : normalizeWorkSemanticTypes(
    [...types].filter(type => type !== 'https://schema.org/CreativeWork'), true); }
  catch { throw new WorkEditUnavailable('Work semantic types are unavailable'); }
  if (heads.values().next().value !== intent.expectedHead) {
    const stale = await sealStaleHead(env, intent, digest);
    if (stale) return checkedTerminal(stale, intent, digest);
    throw new PendingActivation('stale Work edit outcome not sealed');
  }
  const main = mains.values().next().value!;
  const post = nativePost
    ? await readPostPayloadForRevision(env, manifests.values().next().value!, intent.work) : undefined;
  const metadata = nativePost ? undefined
    : await readWorkPayloadForRevision(env, manifests.values().next().value!, intent.work);
  const prior = metadata ?? { title: post!.labels[0]!.value, language: post!.labels[0]!.language,
    semanticTypes: [], localizedTitle: undefined, description: undefined, scalarValue: undefined };
  let currentScalar: WorkScalarValue | undefined;
  try { currentScalar = scalarFromBinding(scalarBindings[0]); }
  catch { throw new RevisionCorrupt('Work scalar graph term is invalid'); }
  const labelKeys = new Set(rows.map(row => JSON.stringify({ value: row.title!.value, language: row.title!['xml:lang'] })));
  if (post ? post.publisher !== [...publishers][0] || labelKeys.size !== rows.length
      || post.labels.length !== labelKeys.size || post.labels.some(label => !labelKeys.has(JSON.stringify(label)))
    : metadata!.mainVersion !== main || prior.title !== titles.values().next().value
      || prior.language !== rows[0]!.title!['xml:lang'] || !sameScalar(prior.scalarValue, currentScalar)
      || JSON.stringify(prior.semanticTypes) !== JSON.stringify(semanticTypes)) {
    throw new RevisionCorrupt('Work graph differs from its retained head');
  }
  const typeGuard = change.kind === 'types'
    ? structureTypeRemovalGuard(intent.work, [genericWorkType, ...change.types]) : '';
  const typeDependency = async () => typeGuard && !(await env.fuseki.query(`ASK { ${typeGuard} }`, 4096)).boolean;
  if (await typeDependency()) throw new WorkTypeConflict('An attached Structure profile requires its owner type');
  const revision = ID + Bun.randomUUIDv7();
  const validations = post ? await profileValidations(env.fuseki, 'post-v1', [{
    shape: `${POST_REVISION_PROFILE}/post-shape`, focus: [intent.work], graphs: [GRAPHS.current],
  }], { post: intent.work, publisher: post.publisher, revision })
    : await workMetadataValidations(env, intent.work, main);
  if (change.kind === 'types') validations.push(...await profileValidations(env.fuseki, 'work-type-v3', [
    { shape: `${WORK_TYPE_PROFILE}/work-shape`, focus: [intent.work], graphs: [GRAPHS.current] },
    { shape: `${WORK_TYPE_PROFILE}/work-revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] },
  ]));
  const nextTitle = change.kind === 'title' ? change.title : prior.title;
  const nextScalar = change.kind === 'scalar' ? change.value : prior.scalarValue;
  const nextTypes = change.kind === 'types' ? change.types : semanticTypes;
  const state = post ? { ...post, labels: post.labels.map((label, index) => index === 0 ? { ...label, value: nextTitle } : label) }
    : { mainVersion: main, continuityProfile: CONTINUITY, title: nextTitle,
    language: prior.language, ...(nextTypes.length ? { semanticTypes: nextTypes } : {}),
    ...(prior.localizedTitle ? { localizedTitle: prior.localizedTitle } : {}),
    ...(prior.description ? { description: prior.description } : {}),
    ...(nextScalar === undefined ? {} : { scalarValue: nextScalar }) };
  const revisionProfile = post ? POST_REVISION_PROFILE : PROFILE;
  const manifest = env.workObjects
    ? await prepareWorkComponent(env.workObjects, intent.work, state, revisionProfile)
    : prepareComponent(env.objectDirectory, intent.work, state, revisionProfile);
  if (Date.parse(intent.admission.expiresAt) <= Date.now()) throw new PendingActivation('Work edit admission expired before update');
  const operation = ID + Bun.randomUUIDv7();
  const receipt = workEditReceiptIri(intent.admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(operation)}`;
  const nextScalarTerm = scalarRdfTerm(nextScalar);
  // Scalar/type revisions preserve the title without claiming its controlled write predicate.
  const update = `PREFIX rv: <${RV}> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
    DELETE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} .
        ${change.kind === 'title' ? `${iri(intent.work)} rdfs:label ?oldTitle .` : ''}
        ${post ? '' : `${iri(intent.work)} <${SCALAR_PREDICATE}> ?oldScalar .`}
        ${change.kind === 'types' ? `${iri(intent.work)} a ?oldType .` : ''} }
    }
    INSERT {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(revision)} .
        ${change.kind === 'title' ? `${iri(intent.work)} rdfs:label ${lit(nextTitle)}@${prior.language} .` : ''}
        ${nextScalarTerm ? `${iri(intent.work)} <${SCALAR_PREDICATE}> ${nextScalarTerm} .` : ''}
        ${change.kind === 'types' ? nextTypes.map(type => `${iri(intent.work)} a <${type}> .`).join('\n') : ''} }
      GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:RevisionAnchor ; rv:component ${iri(intent.work)} ;
        rv:predecessor ${iri(intent.expectedHead)} ; rv:operation ${iri(operation)} ;
        ${intent.admission.actingSubject ? `rv:actor ${iri(intent.admission.actingSubject)} ;` : ''}
        rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ; rv:modelRevision ${iri(revisionProfile)} ;
        rv:shapeRevision ${iri(revisionProfile)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:operation ${iri(operation)} ;
        rv:requestDigest ${lit(digest)} ; rv:admissionId ${lit(intent.admission.id)} ;
        rv:authorityEpoch ${lit(intent.admission.authorityEpoch)} ; rv:admittedScope ${lit(intent.admission.scope)} ;
        rv:outcome rv:Succeeded ; rv:work ${iri(intent.work)} ; rv:workRevision ${iri(revision)} ;
        ${change.kind === 'types' ? 'rv:commandFamily "work-type-v2" ;' : ''}
        rv:expectedHead ${iri(intent.expectedHead)} ; rv:datasetId ${iri(DATASET)} ;
        rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
      GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
        ${iri(event)} a rv:WorkEditedEvent ; rv:ordinal 0 ; rv:action "work.edit" ;
          rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} ; rv:work ${iri(intent.work)} . }
    }
    WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n .
        ${post ? '' : `${iri(DATASET)} rv:modelHead ${iri(PROFILE)} ; rv:shapeHead ${iri(PROFILE)} .`} }
      GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:head ${iri(intent.expectedHead)} ;
        ${post ? `a rv:Post ; rv:publisher ${iri(post.publisher)}` : `rv:mainVersion ${iri(main)}`} ; rdfs:label ?oldTitle .
        ${post ? `FILTER(LANG(?oldTitle) = ${lit(prior.language)})` : `OPTIONAL { ${iri(intent.work)} <${SCALAR_PREDICATE}> ?oldScalar }`}
        ${change.kind === 'types' ? `OPTIONAL { ${iri(intent.work)} a ?oldType .
          FILTER(?oldType != <https://schema.org/CreativeWork>) }` : ''} }
      ${typeGuard}
      ${post ? `${unerased(iri(intent.work))}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(intent.work)} rv:titleControlHead ?titleControl } }` : ''}
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
      BIND(?n + 1 AS ?next)
    }`;
  const commit = async () => {
    try {
      const result = await validatedCommand(env, { receipt, digest, update, validations, deadlineMs: 10_000 }, intent.admission);
      if (result.status === 'invalid' || result.status === 'unknown-profile') throw new CommandRejected(result);
    } catch (error) {
      if (error instanceof CommandRejected) throw error;
      /* resolve by receipt after a lost response */
    }
  };
  if (post && fenceNativePost) await fenceNativePost(commit);
  else await commit();
  const committed = await readWorkEditTerminalReceipt(env, intent.admission.id);
  if (committed) {
    const result = checkedTerminal(committed, intent, digest);
    return { ...result, replayed: committed.revision !== revision };
  }
  const stale = await sealStaleHead(env, intent, digest);
  if (stale) return checkedTerminal(stale, intent, digest);
  if (await typeDependency()) throw new WorkTypeConflict('An attached Structure profile requires its owner type');
  throw new PendingActivation('Work edit guard did not match');
}
