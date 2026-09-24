import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { classificationPropositionDigest, createClassificationProposition,
  readClassificationPropositionReceipt, sealClassificationPropositionAdmission,
  ClassificationDefinitionUnavailable, type CreateClassificationPropositionInput,
  type ClassificationPropositionReceipt } from './proposition.ts';

export async function createAdmittedClassificationProposition(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateClassificationPropositionInput & { idempotencyKey: string },
): Promise<ClassificationPropositionReceipt & { replayed: boolean }> {
  const digest = classificationPropositionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['classification:define']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: 'classification:define:global', action: 'classification.proposition.define',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealClassificationPropositionAdmission(env, admission);
      } else {
        try { await createClassificationProposition(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof ClassificationDefinitionUnavailable) {
            await sealClassificationPropositionAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readClassificationPropositionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'classification-proposition');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('classification proposition admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      throw new CancelledActivation('classification proposition creation was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'classification-proposition');
  }
}
