import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type RegisteredAdmission, type VerifiedPrincipal } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { readRatingContextReceipt, sealRatingContextAdmission, type RatingContextReceipt } from './context.ts';
import { checkedGlobalContextReceipt, checkedGlobalRatingReceipt, createGlobalRatingContext,
  GLOBAL_CONTEXT_SCOPE, globalRatingContextDigest, globalRatingDigest, setGlobalRating,
  type CreateGlobalRatingContextInput, type SetGlobalRatingInput } from './global.ts';
import { RatingObservationUnavailable, readStandingRatingReceipt, sealStandingRatingAdmission,
  StaleRatingObservation, type RatingObservationReceipt } from './observation.ts';

type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>;

/** Claim when eligible; an ineligible or failed claim seals a terminal cancellation. */
async function dispatch(access: Access, registered: RegisteredAdmission, digest: string, principal: VerifiedPrincipal,
  run: (admission: RegisteredAdmission) => Promise<unknown>,
  cancel: (admission: RegisteredAdmission) => Promise<unknown>) {
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) { if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error; }
  }
  if (admission.state === 'sealed') return;
  if (!admission.dispatchEligible || admission.state === 'registered') await cancel(admission);
  else await run(admission);
}

export async function createAdmittedGlobalRatingContext(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: Access, request: Request,
  input: CreateGlobalRatingContextInput & { idempotencyKey: string },
): Promise<RatingContextReceipt & { replayed: boolean }> {
  const digest = globalRatingContextDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:configure']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: GLOBAL_CONTEXT_SCOPE, action: 'rating.context.create',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    await dispatch(access, registered, digest, principal, async admission => {
      try { await createGlobalRatingContext(env, admission, input); }
      catch (error) { if (error instanceof IdempotencyConflict) throw error; }
    }, admission => sealRatingContextAdmission(env, admission));
    const terminal = await readRatingContextReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-context');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedGlobalContextReceipt(terminal, registered, digest), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-context');
  }
}

export async function setAdmittedGlobalRating(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>, access: Access, request: Request,
  input: SetGlobalRatingInput & { idempotencyKey: string },
): Promise<RatingObservationReceipt & { replayed: boolean }> {
  const digest = globalRatingDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:submit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:observe:${input.context}`, action: 'rating.observation.set',
    baselineRelatedWork: input.work,
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    await dispatch(access, registered, digest, principal, async admission => {
      try { await setGlobalRating(env, admission, input); }
      catch (error) {
        if (error instanceof IdempotencyConflict) throw error;
        if (error instanceof RatingObservationUnavailable) await sealStandingRatingAdmission(env, admission);
      }
    }, admission => sealStandingRatingAdmission(env, admission));
    const terminal = await readStandingRatingReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-observation');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedGlobalRatingReceipt(terminal, registered, input, digest), replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRatingObservation
      || error instanceof RatingObservationUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-observation');
  }
}
