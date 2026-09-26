import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { ratingPolicyDigest, readRatingPolicyReceipt, sealRatingPolicyAdmission,
  setRatingDefaultPolicy, StaleRatingPolicy, type SetRatingDefaultInput,
  type RatingPolicyReceipt } from './policy.ts';

export async function setAdmittedRatingDefaultPolicy(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SetRatingDefaultInput & { idempotencyKey: string },
): Promise<RatingPolicyReceipt & { replayed: boolean }> {
  const digest = ratingPolicyDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['rating:configure']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `rating:policy:${input.context}`, action: 'rating.context.policy.set',
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
        await sealRatingPolicyAdmission(env, admission);
      } else {
        try { await setRatingDefaultPolicy(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof StaleRatingPolicy) await sealRatingPolicyAdmission(env, admission, 'stale-head');
        }
      }
    }
    const terminal = await readRatingPolicyReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'rating-policy');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('Rating policy admission differs from graph receipt');
    }
    if (terminal.reason === 'stale-head') throw new StaleRatingPolicy('Rating policy head changed');
    if (terminal.outcome === 'cancelled') throw new AdmissionDenied('Rating policy admission was cancelled');
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRatingPolicy
      || error instanceof AdmissionDenied) throw error;
    throw new PendingAdmittedWork(registered.id, 'rating-policy');
  }
}
