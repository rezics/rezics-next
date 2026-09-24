import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { classificationContextDigest, createClassificationContext,
  readClassificationContextReceipt, sealClassificationContextAdmission,
  ClassificationRealmUnavailable, type CreateClassificationContextInput,
  type ClassificationContextReceipt } from './context.ts';

export async function createAdmittedClassificationContext(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateClassificationContextInput & { idempotencyKey: string },
): Promise<ClassificationContextReceipt & { replayed: boolean }> {
  const digest = classificationContextDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['realm:classify']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `classification:context:${input.realm}`, action: 'classification.context.configure',
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
        await sealClassificationContextAdmission(env, admission);
      } else {
        try { await createClassificationContext(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof ClassificationRealmUnavailable) {
            await sealClassificationContextAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readClassificationContextReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'classification-context');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('classification context admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      throw new CancelledActivation('classification context creation was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'classification-context');
  }
}
