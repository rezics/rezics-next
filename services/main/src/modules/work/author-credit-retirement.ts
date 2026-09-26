import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { readWorkEditTerminalReceipt, sealMetadataWorkEditAdmission, workEditReceiptIri } from './edit.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { authorCreditValidations, readAuthorCredit, AuthorCreditConflict,
  AuthorCreditInvalid, AuthorCreditUnavailable } from './author-credit.ts';

const NATIVE = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;

export interface AuthorCreditRetirementInput {
  work: string; credit: string; revision: string; expectedHead: string;
  actingSubject: string; reason: string; idempotencyKey: string;
}
export interface AuthorCreditRetirement {
  profile: 'work-author-credit-retirement-v1'; state: 'retired'; retirement: string;
  work: string; credit: string; revision: string; workHead: string; reason: string;
  admissionId: string; requestDigest: string;
  sourcePosition: { datasetId: 'product'; dataEpoch: string; sequence: string };
}

export function authorCreditRetirementDigest(input: Omit<AuthorCreditRetirementInput, 'idempotencyKey'>): string {
  if (![input.work, input.credit, input.revision, input.expectedHead, input.actingSubject]
    .every(value => NATIVE.test(value)) || input.reason !== input.reason.trim()
    || input.reason.length < 1 || input.reason.length > 500
    || /[\u0000-\u001f\u007f]/.test(input.reason)) throw new AuthorCreditInvalid('invalid credit retirement');
  return hash(JSON.stringify({ profile: 'work-author-credit-retirement-v1', work: input.work,
    credit: input.credit, revision: input.revision, expectedHead: input.expectedHead,
    actingSubject: input.actingSubject, reason: input.reason }));
}

async function origin(env: WorkActivationEnvironment, credit: string, revision: string) {
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?intent ?authority WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:authorCredit ${iri(credit)} ;
      rv:creditRevision ${iri(revision)} ; rv:sourceIntent ?intent ;
      rv:authorityEpoch ?authority ; rv:outcome rv:Succeeded . } } LIMIT 2`, 4096);
  const rows = data.results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.receipt || !rows[0].intent || !rows[0].authority) {
    throw new AuthorCreditUnavailable('original credit receipt is unavailable');
  }
  return { receipt: rows[0].receipt.value, intent: rows[0].intent.value,
    authorityEpoch: rows[0].authority.value };
}

export async function readAuthorCreditRetirement(env: WorkActivationEnvironment,
  credit: string): Promise<AuthorCreditRetirement | null> {
  if (!NATIVE.test(credit)) throw new AuthorCreditInvalid('invalid credit identity');
  const data = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?receipt ?work ?revision ?head ?reason
    ?admission ?digest ?epoch ?sequence WHERE {
    GRAPH ${iri(GRAPHS.current)} { ${iri(credit)} a rv:AuthorCredit ; rv:retiredBy ?receipt . }
    GRAPH ${iri(GRAPHS.receipts)} { ?receipt rv:authorCredit ${iri(credit)} ;
      rv:creditRevision ?revision ; rv:work ?work ; rv:expectedHead ?head ;
      rv:workRevision ?head ; rv:retirementReason ?reason ; rv:admissionId ?admission ;
      rv:requestDigest ?digest ; rv:outcome rv:Succeeded ; rv:dataEpoch ?epoch ; rv:sequence ?sequence . }
  } LIMIT 2`, 8192);
  const rows = data.results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  if (rows.length !== 1 || !row.receipt || !row.work || !row.revision || !row.head
    || !row.reason || !row.admission || !row.digest || !row.epoch || !row.sequence) {
    throw new AuthorCreditUnavailable('native credit retirement is ambiguous');
  }
  return { profile: 'work-author-credit-retirement-v1', state: 'retired',
    retirement: row.receipt.value, work: row.work.value, credit, revision: row.revision.value,
    workHead: row.head.value, reason: row.reason.value, admissionId: row.admission.value,
    requestDigest: row.digest.value,
    sourcePosition: { datasetId: 'product', dataEpoch: row.epoch.value, sequence: row.sequence.value } };
}

/** A human Work edit retires one occurrence; source withdrawal never calls this. */
export async function retireAuthorCredit(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request, input: AuthorCreditRetirementInput):
  Promise<{ retirement: AuthorCreditRetirement; replayed: boolean }> {
  const { idempotencyKey, ...intent } = input;
  if (!KEY.test(idempotencyKey)) throw new AuthorCreditInvalid('invalid retirement key');
  const digest = authorCreditRetirementDigest(intent);
  const principal = await account.verify(request, ['work:edit']);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const credit = await readAuthorCredit(env, input.credit, input.revision);
  if (!credit || credit.work !== input.work) throw new AuthorCreditConflict('credit identity differs');
  const original = await origin(env, input.credit, input.revision);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `work:edit:${input.work}`, action: 'work.edit', idempotencyKey, requestDigest: digest });
  const prior = await readAuthorCreditRetirement(env, input.credit);
  if (prior) {
    if (prior.admissionId !== registered.id || prior.requestDigest !== digest
      || prior.work !== input.work || prior.revision !== input.revision
      || prior.workHead !== input.expectedHead || prior.reason !== input.reason) {
      throw new AuthorCreditConflict('credit was retired by another intent');
    }
    return { retirement: prior, replayed: true };
  }
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state !== 'sealed') {
    if (!admission.dispatchEligible || admission.state === 'registered') {
      await sealMetadataWorkEditAdmission(env, admission);
    } else {
      const receipt = workEditReceiptIri(admission.id);
      const batch = `urn:rezics:outbox:${hash(receipt)}`;
      const event = `urn:rezics:event:${hash(`${receipt}\0author-credit-retired`)}`;
      const validations = await authorCreditValidations(env, credit, original.receipt,
        original.authorityEpoch, original.intent);
      const update = `PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
        DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n } }
        INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.credit)} rv:retiredBy ${iri(receipt)} . }
          GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
            rv:outcome rv:Succeeded ; rv:action "work.edit" ;
            rv:admissionId ${lit(admission.id)} ; rv:requestDigest ${lit(digest)} ;
            rv:authorityEpoch ${lit(admission.authorityEpoch)} ; rv:admittedScope ${lit(admission.scope)} ;
            rv:work ${iri(input.work)} ; rv:workRevision ${iri(input.expectedHead)} ;
            rv:expectedHead ${iri(input.expectedHead)} ; rv:authorCredit ${iri(input.credit)} ;
            rv:creditRevision ${iri(input.revision)} ; rv:retirementReason ${lit(input.reason)} ;
            rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next . }
          GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
            rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ; rv:eventCount 1 ;
            rv:event ${iri(event)} . ${iri(event)} a rv:AuthorCreditRetiredEvent ; rv:ordinal 0 ;
            rv:action "work.edit" ; rv:work ${iri(input.work)} ; rv:receipt ${iri(receipt)} . } }
        WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
          GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} a schema:CreativeWork ;
            rv:head ${iri(input.expectedHead)} . ${iri(input.credit)} a rv:AuthorCredit ;
            rv:work ${iri(input.work)} ; rv:creditRevision ${iri(input.revision)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:protectionHead ?p } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(input.credit)} rv:retiredBy ?r } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
          BIND(?n + 1 AS ?next) }`;
      try {
        const result = await validatedCommand(env, { receipt, digest, update, validations, deadlineMs: 10_000 }, admission);
        if (result.status === 'invalid') {
          const winner = await readAuthorCreditRetirement(env, input.credit);
          if (winner && winner.admissionId !== admission.id) {
            throw new AuthorCreditConflict('credit was retired by another intent');
          }
          throw new CommandRejected(result);
        }
        if (result.status === 'unknown-profile') throw new CommandRejected(result);
        if (result.status === 'guard-unmatched') await sealMetadataWorkEditAdmission(env, admission);
      } catch (error) {
        if (error instanceof CommandRejected || error instanceof AuthorCreditConflict) throw error;
        // The exact receipt resolves a lost response.
      }
    }
  }
  const terminal = await readWorkEditTerminalReceipt(env, registered.id);
  if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
  await access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome !== 'succeeded') throw new AuthorCreditConflict('credit retirement basis changed');
  const retired = await readAuthorCreditRetirement(env, input.credit);
  if (!retired || retired.admissionId !== registered.id || retired.requestDigest !== digest
    || retired.work !== input.work || retired.revision !== input.revision
    || retired.workHead !== input.expectedHead || retired.reason !== input.reason) {
    throw new IdempotencyConflict('retirement receipt differs from intent');
  }
  return { retirement: retired, replayed: registered.replayed };
}
