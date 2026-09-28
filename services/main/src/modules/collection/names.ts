import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { validLocalizedText, type LocalizedText } from '../display-language/select.ts';
import { compositionReceiptIri, readCompositionReceipt, sealStructureAdmissionCancellation,
  terminalResult } from '../structure/change.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict,
  PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';

const PROFILE = 'https://rezics.com/definition/collection-public-name-v1';
const CURATION = 'https://rezics.com/definition/collection-curation-v1';
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const COLLECTION_NAME_COST = { labels: 20, payloadCharacters: 8000,
  graphCalls: 12, graphWrites: 1 } as const;

export class CollectionNameInvalid extends Error {}
export class CollectionNameUnavailable extends Error {}
export class CollectionNameStale extends Error {}

export function checkedCollectionName(name: LocalizedText): LocalizedText {
  if (!validLocalizedText(name, 300) || JSON.stringify(name).length > COLLECTION_NAME_COST.payloadCharacters) {
    throw new CollectionNameInvalid('Collection name is invalid');
  }
  return name;
}

/** One bounded current-name read; a legacy Collection has no name revision. */
export async function readCollectionName(env: WorkActivationEnvironment, collection: string) {
  if (!native.test(collection)) throw new CollectionNameInvalid('Collection identity is invalid');
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
    SELECT ?plain ?head ?payload WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(collection)} a rv:Collection ;
        rv:collectionState rv:Active ; rv:disclosure rv:Public ; schema:name ?plain .
        OPTIONAL { ${iri(collection)} rv:collectionNameHead ?head }
        FILTER NOT EXISTS { ${iri(collection)} rv:protectionHead ?protection } }
      OPTIONAL { FILTER(BOUND(?head)) GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:CollectionNameRevision ;
        rv:component ${iri(collection)} ; rv:modelRevision ${iri(PROFILE)} ; rv:profilePayload ?payload } }
    } LIMIT 2`)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.plain || rows[0].head && !rows[0].payload) {
    throw new CollectionNameUnavailable('Collection name is unavailable');
  }
  const row = rows[0]!;
  const name: LocalizedText = row.head
    ? (() => { try { return JSON.parse(row.payload!.value) as LocalizedText; }
      catch { throw new CollectionNameUnavailable('Collection name revision is invalid'); } })()
    : { original: row.plain!['xml:lang'] || 'en',
      labels: { [row.plain!['xml:lang'] || 'en']: row.plain!.value } };
  try { checkedCollectionName(name); }
  catch { throw new CollectionNameUnavailable('Collection name revision is invalid'); }
  if (row.head && (row.plain!.value !== name.labels[name.original]
    || row.plain!['xml:lang']?.toLowerCase() !== name.original.toLowerCase())) {
    throw new CollectionNameUnavailable('Collection original name differs from its revision');
  }
  return { profile: 'collection-public-name-v1' as const, collection,
    revision: row.head?.value ?? null, name };
}

/** One Access admitted CAS; O(labels) input validation and constant graph work. */
export async function publishCollectionName(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: { collection: string; actingSubject: string; expectedHead: string | null;
    idempotencyKey: string; name: LocalizedText }) {
  if (!native.test(input.collection) || !native.test(input.actingSubject)
    || input.expectedHead !== null && !native.test(input.expectedHead)) {
    throw new CollectionNameInvalid('Collection name identity is invalid');
  }
  const name = checkedCollectionName(input.name);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const digest = hash(JSON.stringify({ family: 'collection-public-name-v1',
    collection: input.collection, actingSubject: input.actingSubject,
    expectedHead: input.expectedHead, name }));
  const principal = await account.verify(request, ['collection:edit']);
  const scope = `collection:edit:${input.collection}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'collection.edit', idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealStructureAdmissionCancellation(env, admission);
  } else if (admission.state !== 'sealed'
    && !await readCompositionReceipt(env, admission.id, admission.action)) {
    const current = await readCollectionName(env, input.collection);
    if (current.revision !== input.expectedHead) {
      const cancelled = await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id, cancelled);
      throw new CollectionNameStale('Collection name head changed');
    }
    const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const receipt = compositionReceiptIri(admission.id, admission.action);
    const batch = `urn:rezics:outbox:${hash(receipt)}`;
    const event = `urn:rezics:event:${hash(operation)}`;
    const original = name.labels[name.original]!;
    const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.collection)} schema:name ?plain .
          ${input.expectedHead ? ` ${iri(input.collection)} rv:collectionNameHead ${iri(input.expectedHead)} .` : ''} } }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.collection)} schema:name ${lit(original)}@${name.original} ;
          rv:collectionNameHead ${iri(revision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:CollectionNameRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.collection)} ; rv:operation ${iri(operation)} ;
          ${input.expectedHead ? `rv:predecessor ${iri(input.expectedHead)} ;` : ''}
          rv:profilePayload ${lit(JSON.stringify(name))} ; rv:modelRevision ${iri(PROFILE)} ;
          rv:shapeRevision ${iri(PROFILE)} ; rv:datasetId ${iri(DATASET)} ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(scope)} ; rv:outcome rv:Succeeded ;
          rv:structureOwner ${iri(input.collection)} ; rv:structureRevision ${iri(revision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
          rv:event ${iri(event)} .
          ${iri(event)} a rv:CollectionNamePublishedEvent ; rv:ordinal 0 ;
            rv:action ${lit(admission.action)} ; rv:receipt ${iri(receipt)} ;
            rv:operation ${iri(operation)} . } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.collection)} a rv:Collection ;
          rv:collectionState rv:Active ; rv:disclosure rv:Public ; schema:name ?plain .
          ${input.expectedHead ? `${iri(input.collection)} rv:collectionNameHead ${iri(input.expectedHead)} .` : ''} }
        ${input.expectedHead ? '' : `FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
          ${iri(input.collection)} rv:collectionNameHead ?prior } }`}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = [...await profileValidations(env.fuseki, 'collection-public-name-v1', [{
      shape: `${PROFILE}/revision-shape`, focus: [revision],
      graphs: [GRAPHS.current, GRAPHS.revisions] }]),
    ...await profileValidations(env.fuseki, 'collection-curation-v1', [{
      shape: `${CURATION}/collection-shape`, focus: [input.collection],
      graphs: [GRAPHS.current, GRAPHS.revisions] }])];
    try { await validatedCommand(env, { receipt, digest, update, validations,
      deadlineMs: 10_000 }, admission); }
    catch { /* A lost response is resolved by the durable receipt. */ }
    if (!await readCompositionReceipt(env, admission.id, admission.action)
      && (await readCollectionName(env, input.collection)).revision !== input.expectedHead) {
      await sealStructureAdmissionCancellation(env, admission);
    }
  }
  const terminal = await readCompositionReceipt(env, registered.id, registered.action);
  if (!terminal) throw new PendingActivation('Collection name outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  terminalResult(terminal, registered);
  if (terminal.owner !== input.collection || !terminal.revision) {
    throw new IdempotencyConflict('Collection name receipt differs from admission');
  }
  return { collection: input.collection, revision: terminal.revision,
    receipt: terminal.receipt, replayed: registered.replayed,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: terminal.dataEpoch,
      sequence: terminal.sequence } };
}
