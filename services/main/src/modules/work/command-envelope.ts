import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import { assertNotInvalidProfileReceipt } from '../../infrastructure/invalid-receipt.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, IdempotencyConflict,
  type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { workEditReceiptIri } from './edit.ts';

// One work-edit receipt and cancel seal. Another component command passes predicates and errors.

const predicateName = /^[A-Za-z][A-Za-z0-9]*$/;
interface CommandFailure { new (message: string): Error; prototype: Error }
type WorkEditResult<K extends string> = {
  work: string | undefined; revision: string; receipt: string; replayed: boolean;
  sourcePosition: { dataEpoch: string; sequence: string };
} & Record<K, string>;

export interface WorkEditEnvelope<K extends string> {
  /** Receipt field and `rv:` local name of the succeeded component. */
  target: K;
  /** `rv:` local name of the succeeded revision. */
  revision: string;
  deadlineMs: number;
  unavailable: CommandFailure;
  invalid: CommandFailure;
  stale: CommandFailure;
  incomplete: string;
  cancelled: string;
  mismatch: string;
  /** Release seals an invalid correction that left commit; Realization seals inside commit. */
  sealInvalid: boolean;
}

export type WorkEditReceipt<K extends string> = {
  outcome: 'succeeded' | 'cancelled'; receipt: string; admissionId: string; requestDigest: string;
  authorityEpoch: string; scope: string; dataEpoch: string; sequence: string;
  work?: string; revision?: string;
} & Partial<Record<K, string>>;

export async function readWorkEditReceipt<K extends string>(env: Pick<WorkActivationEnvironment, 'fuseki'>,
  admissionId: string, family: WorkEditEnvelope<K>): Promise<WorkEditReceipt<K> | null> {
  if (!predicateName.test(family.target) || !predicateName.test(family.revision)) throw new Error('invalid work-edit receipt predicate');
  const receipt = workEditReceiptIri(admissionId);
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?outcome ?digest ?authority ?scope ?epoch ?sequence ?work ?component ?revision WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} rv:admissionId ${lit(admissionId)} ;
        rv:outcome ?outcome ; rv:requestDigest ?digest ; rv:authorityEpoch ?authority ;
        rv:admittedScope ?scope ; rv:dataEpoch ?epoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:work ?work ; rv:${family.target} ?component ; rv:${family.revision} ?revision }
      } } LIMIT 2`, 8192)).results?.bindings ?? [];
  if (!rows.length) return null;
  const row = rows[0]!;
  const outcome = row.outcome?.value === `${RV}Succeeded` ? 'succeeded'
    : row.outcome?.value === `${RV}Cancelled` ? 'cancelled' : null;
  if (rows.length !== 1 || !outcome || !row.digest || !row.authority || !row.scope || !row.epoch || !row.sequence
    || outcome === 'succeeded' && (!row.work || !row.component || !row.revision)) {
    throw new family.unavailable(family.incomplete);
  }
  return { outcome, receipt, admissionId, requestDigest: row.digest.value, authorityEpoch: row.authority.value,
    scope: row.scope.value, dataEpoch: row.epoch.value, sequence: row.sequence.value,
    ...(outcome === 'succeeded' ? { work: row.work!.value, [family.target]: row.component!.value,
      revision: row.revision!.value } : {}) } as WorkEditReceipt<K>;
}

export async function sealWorkEdit<K extends string>(env: WorkActivationEnvironment,
  admission: RegisteredAdmission, family: WorkEditEnvelope<K>): Promise<void> {
  if (await readWorkEditReceipt(env, admission.id, family)) return;
  const receipt = workEditReceiptIri(admission.id);
  const batch = `urn:rezics:outbox:${hash(receipt)}`;
  const event = `urn:rezics:event:${hash(receipt)}`;
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
  try { await env.fuseki.commandWithReceipt({ receipt, digest: admission.requestDigest, update,
    validations: [], deadlineMs: family.deadlineMs }); }
  catch { /* A lost response still resolves through the receipt below. */ }
  if (!await readWorkEditReceipt(env, admission.id, family)) throw new PendingAdmittedWork(admission.id, 'work-edit');
}

export async function settleWorkEdit<K extends string>(env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  principal: VerifiedPrincipal, family: WorkEditEnvelope<K>, actingSubject: string, work: string,
  idempotencyKey: string, digest: string, targetId: string,
  commit: (admission: RegisteredAdmission) => Promise<boolean>): Promise<WorkEditResult<K>> {
  const registered = await access.register({ principal, actingSubject, action: 'work.edit',
    scope: `work:edit:${work}`, idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest, principal); }
      catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
    }
    let committed = false, failure: unknown;
    try {
      if (admission.state === 'sealed') { /* A retry resolves the exact receipt below. */ }
      else if (!admission.dispatchEligible || admission.state === 'registered') await sealWorkEdit(env, admission, family);
      else committed = await commit(admission);
    } catch (error) {
      failure = error;
      if (family.sealInvalid && error instanceof family.invalid) await sealWorkEdit(env, admission, family);
    }
    const terminal = await readWorkEditReceipt(env, admission.id, family);
    if (!terminal) {
      if (failure instanceof family.invalid || failure instanceof family.unavailable || failure instanceof IdempotencyConflict
        || failure instanceof CommandRejected || failure instanceof family.stale) throw failure;
      throw new PendingAdmittedWork(admission.id, 'work-edit');
    }
    await access.recordGraphOutcome(admission.id, terminal);
    if (failure instanceof family.invalid) throw failure;
    await assertNotInvalidProfileReceipt(env.fuseki, terminal.receipt);
    if (failure instanceof CommandRejected) throw failure;
    if (terminal.outcome === 'cancelled') throw new family.stale(family.cancelled);
    const target = terminal[family.target];
    if (terminal.work !== work || target !== targetId) throw new IdempotencyConflict(family.mismatch);
    return { work: terminal.work, [family.target]: target, revision: terminal.revision!,
      receipt: terminal.receipt, sourcePosition: { dataEpoch: terminal.dataEpoch, sequence: terminal.sequence },
      replayed: !committed } as WorkEditResult<K>;
  } catch (error) {
    if (error instanceof family.unavailable || error instanceof IdempotencyConflict
      || error instanceof CommandRejected || error instanceof family.stale || error instanceof family.invalid) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-edit');
  }
}
