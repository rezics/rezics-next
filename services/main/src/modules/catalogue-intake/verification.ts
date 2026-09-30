import type { MainWorkDependencies } from '../../routes/dependencies.ts';
import type { RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { CatalogueInvalid, CatalogueStale, CatalogueUnavailable } from './schema.ts';

export const VERIFICATION_ACTION = 'catalogue.verify';
export const VERIFICATION_SCOPE = 'catalogue:verify:root';
export const verificationReceipt = (admission: string) => `urn:rezics:receipt:${hash(`${admission}\0catalogue-verify-v1`)}`;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export interface CatalogueVerificationInput { work: string; expectedHead: string; evidence: string; actingSubject: string; idempotencyKey: string }
export interface CatalogueVerificationReceipt {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string; work?: string;
}

export async function readCatalogueVerification(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string): Promise<CatalogueVerificationReceipt | null> {
  const receipt = verificationReceipt(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work WHERE {
    GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ; rv:outcome ?outcome ;
      rv:requestDigest ?digest ; rv:authorityEpoch ?authority ; rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
      OPTIONAL { ${iri(receipt)} rv:work ?work } } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded' : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.authority || !row.scope || !row.epoch || !row.sequence
    || outcome === 'succeeded' && !row.work) throw new CatalogueUnavailable('Verification receipt is incomplete');
  return { outcome, receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value, work: row.work?.value };
}

/** One exact Work-head CAS plus evidence, receipt, sequence and outbox. Remote
 * graph transactions cannot include Access SQL; retries reconcile the receipt:
 * https://jena.apache.org/documentation/rdfconnection/#remote-transactions */
async function commit(env: WorkActivationEnvironment, admission: RegisteredAdmission,
  input: CatalogueVerificationInput | null): Promise<void> {
  const receipt = verificationReceipt(admission.id);
  const update = (success: boolean) => {
    const batch = `urn:rezics:outbox:${hash(`${receipt}\0${success}`)}`;
    const event = `urn:rezics:event:${hash(batch)}`;
    return `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        ${success && input ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:provisional true }` : ''} }
      INSERT { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        ${success && input ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:provisional false ; rv:catalogueVerification ${iri(receipt)} }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(receipt)} a rv:CatalogueVerification ; rv:work ${iri(input.work)} ;
            rv:verifiedHead ${iri(input.expectedHead)} ; rv:evidence ${lit(input.evidence)} ; rv:reviewer ${iri(input.actingSubject)} }` : ''}
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ; rv:admissionId ${lit(admission.id)} ;
          rv:requestDigest ${lit(admission.requestDigest)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(admission.scope)} ; rv:outcome rv:${success ? 'Succeeded' : 'Cancelled'} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${input ? `${iri(receipt)} rv:work ${iri(input.work)} .` : ''} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:sequence ?next ; rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:${success ? 'CatalogueVerifiedEvent' : 'AdmissionCancelledEvent'} ; rv:ordinal 0 ;
            rv:action "catalogue.verify" ; rv:receipt ${iri(receipt)} ; rv:admissionId ${lit(admission.id)} ;
            rv:digest ${lit(admission.requestDigest)} ; rv:scope ${lit(admission.scope)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} } }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        ${success && input ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.work)} rv:head ${iri(input.expectedHead)} ; rv:provisional true }
          FILTER(NOW() < ${lit(admission.expiresAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime>)` : ''}
        BIND(?n + 1 AS ?next) }`;
  };
  const validations = input ? await profileValidations(env.fuseki, 'work-metadata-v1', [
    { shape: 'https://rezics.com/definition/work-metadata-v1/work-shape', focus: [input.work], graphs: [GRAPHS.current] },
  ]) : [];
  const result = await validatedCommand(env, { receipt, digest: admission.requestDigest,
    update: update(input !== null), validations, deadlineMs: 10_000 }, admission);
  if (input && result.status === 'guard-unmatched') {
    // The native command boundary admits one update at a time. Cancellation
    // uses the same receipt, so a concurrent retry still decides exactly once.
    await commit(env, admission, null);
  }
}

/** The same receipt identity serializes a late dispatch against revocation. */
export async function sealCatalogueVerification(env: WorkActivationEnvironment, admission: RegisteredAdmission) {
  if (admission.action !== VERIFICATION_ACTION || admission.scope !== VERIFICATION_SCOPE) {
    throw new CatalogueInvalid('Verification admission is invalid');
  }
  let terminal = await readCatalogueVerification(env, admission.id);
  if (!terminal) {
    try { await commit(env, admission, null); } catch { /* Reconcile an unknown response. */ }
    terminal = await readCatalogueVerification(env, admission.id);
  }
  if (!terminal) throw new PendingAdmittedWork(admission.id, 'work-edit');
  if (terminal.requestDigest !== admission.requestDigest || terminal.authorityEpoch !== admission.authorityEpoch
    || terminal.scope !== admission.scope) throw new IdempotencyConflict('Verification receipt differs from admission');
  return terminal;
}

export async function verifyCatalogueWork(deps: MainWorkDependencies, request: Request, input: CatalogueVerificationInput) {
  if (![input.work, input.expectedHead, input.actingSubject].every(value => native.test(value))
    || !input.evidence.trim() || input.evidence.length > 2000) throw new CatalogueInvalid('Verification needs a Work head and evidence');
  await assertGraphAdmissionOpen(deps.environment.fuseki, deps.environment.lineage);
  const principal = await deps.account.verify(request, ['work:edit']);
  const digest = hash(JSON.stringify({ profile: 'catalogue-verify-v1', work: input.work,
    expectedHead: input.expectedHead, evidence: input.evidence, actingSubject: input.actingSubject }));
  const registered = await deps.access.register({ principal, actingSubject: input.actingSubject,
    scope: VERIFICATION_SCOPE, action: VERIFICATION_ACTION, idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let terminal = await readCatalogueVerification(deps.environment, registered.id);
  if (!terminal && registered.dispatchEligible && registered.state !== 'sealed') {
    const admitted = await deps.access.claim(registered.id, digest, principal);
    try { await commit(deps.environment, admitted, input); }
    catch { /* Re-read the durable result after a lost response. */ }
    terminal = await readCatalogueVerification(deps.environment, registered.id);
  }
  if (!terminal && !registered.dispatchEligible) terminal = await sealCatalogueVerification(deps.environment, registered);
  if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-edit');
  if (terminal.requestDigest !== digest || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
    throw new IdempotencyConflict('Verification admission differs from its receipt');
  }
  await deps.access.recordGraphOutcome(registered.id, terminal);
  if (terminal.outcome === 'cancelled') throw new CatalogueStale('Work changed or is already verified; refresh it and use a new key');
  return { work: input.work, verification: 'verified' as const, receipt: terminal.receipt,
    sourcePosition: { datasetId: 'product' as const, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence }, replayed: registered.replayed };
}
