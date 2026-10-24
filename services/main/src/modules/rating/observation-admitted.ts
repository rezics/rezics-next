import { InvalidRatingObservationInput } from './observation.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, AdmissionLockBusy, AdmissionUnavailable, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { checkedRatingReceipt, readStandingRatingReceipt,
  RatingCurrentVisibility, RatingObservationUnavailable, sealStandingRatingAdmission, setStandingRating,
  standingRatingDigest, StaleRatingObservation,
  type RatingObservationReceipt, type SetStandingRatingInput } from './observation.ts';

export async function setAdmittedStandingRating(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'prepareStandingRatingPublication'>,
  request: Request,
  input: SetStandingRatingInput & { idempotencyKey: string }, daily = false,
): Promise<RatingObservationReceipt & { replayed: boolean }> {
  const digest = standingRatingDigest(input, daily);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:submit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:observe:${input.context}`, action: 'rating.observation.set',
    baselineRelatedWork: input.work,
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest, principal); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    if (admission.state !== 'sealed') {
      if (!admission.dispatchEligible || admission.state === 'registered') {
        await sealStandingRatingAdmission(env, admission);
      } else {
        try { await setStandingRating(env, admission, input, daily,
          !daily && input.occasion === undefined ? () => access.prepareStandingRatingPublication(admission,input,request.signal) : undefined); }
        catch (error) {
          if (error instanceof IdempotencyConflict || error instanceof InvalidRatingObservationInput || error instanceof RatingCurrentVisibility
            || error instanceof AdmissionUnavailable || error instanceof AdmissionLockBusy) throw error;
          if (error instanceof RatingObservationUnavailable) {
            await sealStandingRatingAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readStandingRatingReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-observation');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...await checkedRatingReceipt(env, terminal, registered, input, digest, daily),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof InvalidRatingObservationInput || error instanceof AdmissionLockBusy || error instanceof AdmissionUnavailable || error instanceof IdempotencyConflict || error instanceof StaleRatingObservation
      || error instanceof RatingObservationUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-observation');
  }
}
