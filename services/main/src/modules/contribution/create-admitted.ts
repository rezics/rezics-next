import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { activateTextContribution, assertCurrentContributionWork,
  readTextContributionReceipt, sealTextContributionAdmission,
  textContributionDigest, type CreateTextContributionInput,
  type TextContributionReceipt } from './draft.ts';

/** Account and Access admit the author before any draft graph update. */
export async function createAdmittedTextContribution(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateTextContributionInput & { idempotencyKey: string },
): Promise<TextContributionReceipt & { replayed: boolean }> {
  const digest = textContributionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  await assertCurrentContributionWork(env, input.work);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `contribution:create:${input.work}`, action: 'contribution.create',
    idempotencyKey: input.idempotencyKey, requestDigest: digest });
  try {
    let admission = registered;
    if (registered.state !== 'sealed' && registered.dispatchEligible) {
      try { admission = await access.claim(registered.id, digest); }
      catch (error) {
        if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      }
    }
    const terminal = admission.state === 'sealed' || !admission.dispatchEligible
      || admission.state === 'registered'
      ? await sealTextContributionAdmission(env, admission)
      : await activateTextContribution(env, admission, input);
    const verified = await readTextContributionReceipt(env, registered.id);
    if (!verified || verified.receipt !== terminal.receipt) {
      throw new PendingAdmittedWork(registered.id, 'contribution-draft');
    }
    await access.recordGraphOutcome(registered.id, verified);
    if (verified.outcome === 'cancelled') throw new CancelledActivation('Contribution admission was cancelled');
    if (verified.work !== input.work || verified.author !== input.actingSubject
      || verified.language !== input.language || verified.requestDigest !== digest) {
      throw new IdempotencyConflict('Contribution receipt differs from intent');
    }
    return { ...verified, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'contribution-draft');
  }
}
