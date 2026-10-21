import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { CommandRejected } from '../../infrastructure/fuseki.ts';
import type { VerifiedPublicationAttribution } from './sourced-structure-publication.ts';
import type { InstructionAdoption } from './instruction-adoption.ts';
import { AdmissionDenied, AdmissionExpired, AdmissionUnavailable,
  type AccessAdmissionRegistry, type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { GRAPHS, RV, iri, IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { InvalidPublicationInput, PublicationUnavailable, StalePublicationHead }
  from '../contribution/publish.ts';
import { changeStructuredWorkPublication, checkedWorkStructurePublicationReceipt,
  readWorkStructurePublicationReceipt, sealWorkStructurePublicationAdmission,
  denyWorkStructurePublicationAdmission,
  WorkStructurePublicationRightsDenied,
  workStructurePublicationDigest, workStructurePublicationReceiptIri, type WorkStructurePublicationInput,
  type WorkStructurePublicationReceipt } from './structured-publication.ts';

/** Native validation refusals precede the publication profile's own receipt.
 * Preserve that immutable receipt and settle Access from its exact generic proof. */
async function recordNativePublicationRejection(env: WorkActivationEnvironment,
  access: Pick<AccessAdmissionRegistry, 'recordGraphOutcome'>, admission: RegisteredAdmission,
  action: 'work.publish' | 'work.withdraw-publication'): Promise<boolean> {
  const receipt = workStructurePublicationReceiptIri(admission.id, action);
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?nativeDigest ?nativeId ?nativeEpoch ?nativeScope ?nativeDataEpoch ?nativeSequence WHERE {
      GRAPH ${iri(GRAPHS.receipts)} {
        ${iri(receipt)} a rv:OperationReceipt ; rv:outcome rv:Cancelled ;
          rv:rejectionKind rv:InvalidProfile ; rv:requestDigest ?nativeDigest ;
          rv:admissionId ?nativeId ; rv:authorityEpoch ?nativeEpoch ;
          rv:admittedScope ?nativeScope ; rv:dataEpoch ?nativeDataEpoch ; rv:sequence ?nativeSequence .
      }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return false;
  const row = rows[0]!;
  if (rows.length !== 1 || row.nativeDigest?.value !== admission.requestDigest
    || row.nativeId?.value !== admission.id || row.nativeEpoch?.value !== admission.authorityEpoch
    || row.nativeScope?.value !== admission.scope || row.nativeDataEpoch?.value !== env.lineage.dataEpoch
    || !/^[0-9]+$/.test(row.nativeSequence?.value ?? '')) {
    throw new AdmissionUnavailable('Native publication rejection does not match its admission');
  }
  try {
    await access.recordGraphOutcome(admission.id, { receipt, outcome: 'cancelled', admissionId: admission.id,
      requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch, scope: admission.scope,
      dataEpoch: row.nativeDataEpoch.value, sequence: row.nativeSequence!.value });
  } catch (cause) {
    throw new AdmissionUnavailable('Native publication cancellation could not be recorded', { cause });
  }
  return true;
}

/** Access admission and the graph receipt together decide publish and withdrawal outcomes. */
export async function changeAdmittedWorkStructurePublication(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'admittedActingSubject'>>,
  request: Request,
  input: WorkStructurePublicationInput & { idempotencyKey: string },
  publicationFence: <T>(dispatch: (allowed: boolean) => Promise<T>) => Promise<T>,
  prepareDependencies?: (admissionId: string, principal: VerifiedPrincipal) => Promise<{
    adoptions: readonly InstructionAdoption[]; attribution?: VerifiedPublicationAttribution;
    verifyAttribution?: () => Promise<void>;
  }>,
): Promise<WorkStructurePublicationReceipt & { replayed: boolean }> {
  const digest = workStructurePublicationDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const action = input.operation === 'publish' ? 'work.publish' : 'work.withdraw-publication';
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    baselineRelatedWork: input.work,
    requireExplicitGrant: input.operation === 'publish' && input.rightsBasis === 'public-domain', scope: `work:publish:${input.work}`, action,
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  let nativeRejectionRecorded = false;
  try {
    let terminal: WorkStructurePublicationReceipt | null =
      await readWorkStructurePublicationReceipt(env, registered.id, action);
    if (!terminal && await recordNativePublicationRejection(env, access, registered, action)) {
      nativeRejectionRecorded = true;
      throw new CommandRejected({ status: 'invalid' });
    }
    if (!terminal && registered.state !== 'sealed') {
      let admission = registered;
      if (registered.dispatchEligible) {
        try { admission = await access.claim(registered.id, digest, principal); }
        catch (error) {
          if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
          admission = { ...registered, dispatchEligible: false };
        }
      }
      if (!admission.dispatchEligible || admission.state === 'registered') {
        terminal = await sealWorkStructurePublicationAdmission(env, admission);
      } else {
        terminal = await publicationFence(async allowed => {
          let dependencies: Awaited<ReturnType<NonNullable<typeof prepareDependencies>>> | undefined;
          if (allowed && input.operation === 'publish') {
            try { dependencies = await prepareDependencies?.(admission.id, principal); }
            catch (error) {
              if (error instanceof PublicationUnavailable || error instanceof AdmissionDenied
                || error instanceof WorkStructurePublicationRightsDenied
                || error instanceof StalePublicationHead || error instanceof InvalidPublicationInput) throw error;
              throw new AdmissionUnavailable('Work publication dependencies are unavailable', { cause: error });
            }
          }
          const result = await (!allowed
            ? denyWorkStructurePublicationAdmission(env, admission, input)
            : changeStructuredWorkPublication(env, admission, input,
            id => access.admittedActingSubject
              ? access.admittedActingSubject(id)
              : Promise.reject(new AdmissionDenied('Structure author provenance is unavailable')),
            dependencies?.adoptions, dependencies?.attribution, dependencies?.verifyAttribution));
          if (result.outcome === 'succeeded') await dependencies?.verifyAttribution?.();
          return result;
        });
      }
    }
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-publication');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedWorkStructurePublicationReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof CommandRejected && error.result.status === 'invalid' && !nativeRejectionRecorded) {
      await recordNativePublicationRejection(env, access, registered, action);
    }
    if (error instanceof CommandRejected || error instanceof IdempotencyConflict || error instanceof InvalidPublicationInput
      || error instanceof PublicationUnavailable || error instanceof StalePublicationHead
      || error instanceof WorkStructurePublicationRightsDenied
      || error instanceof AdmissionDenied || error instanceof AdmissionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-publication');
  }
}
