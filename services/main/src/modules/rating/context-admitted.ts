import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { createRatingContext, ratingContextDigest, readRatingContextReceipt,
  sealRatingContextAdmission, RatingRealmUnavailable,
  type CreateRatingContextInput, type RatingContextReceipt } from './context.ts';

export async function createAdmittedRatingContext(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateRatingContextInput & { idempotencyKey: string },
): Promise<RatingContextReceipt & { replayed: boolean }> {
  const digest = ratingContextDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:configure']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:context:${input.realm}`, action: 'rating.context.create',
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
        await sealRatingContextAdmission(env, admission);
      } else {
        try { await createRatingContext(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RatingRealmUnavailable) {
            await sealRatingContextAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readRatingContextReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-context');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('rating context admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      throw new CancelledActivation('rating context creation was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-context');
  }
}
