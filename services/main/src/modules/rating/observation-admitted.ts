import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { checkedStandingRatingReceipt, readStandingRatingReceipt,
  RatingObservationUnavailable, sealStandingRatingAdmission, setStandingRating,
  standingRatingDigest, StaleRatingObservation,
  type RatingObservationReceipt, type SetStandingRatingInput } from './observation.ts';

export async function setAdmittedStandingRating(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SetStandingRatingInput & { idempotencyKey: string },
): Promise<RatingObservationReceipt & { replayed: boolean }> {
  const digest = standingRatingDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:submit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:observe:${input.context}`, action: 'rating.observation.set',
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
        await sealStandingRatingAdmission(env, admission);
      } else {
        try { await setStandingRating(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RatingObservationUnavailable) {
            await sealStandingRatingAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readStandingRatingReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-observation');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedStandingRatingReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRatingObservation
      || error instanceof RatingObservationUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-observation');
  }
}
