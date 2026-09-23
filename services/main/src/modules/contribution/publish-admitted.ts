import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { checkedTextPublicationReceipt, PublicationUnavailable,
  publishTextContribution, readTextPublicationReceipt, sealTextPublicationAdmission,
  StalePublicationHead, textPublicationDigest,
  type PublishTextContributionInput, type TextPublicationReceipt } from './publish.ts';

/** Account and contributor-specific Access admission precede public eligibility. */
export async function publishAdmittedTextContribution(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: PublishTextContributionInput & { idempotencyKey: string },
): Promise<TextPublicationReceipt & { replayed: boolean }> {
  const digest = textPublicationDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `contribution:publish:${input.contribution}`, action: 'contribution.publish',
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
        await sealTextPublicationAdmission(env, admission);
      } else {
        try { await publishTextContribution(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof PublicationUnavailable) {
            await sealTextPublicationAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readTextPublicationReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'contribution-publication');
    await access.recordGraphOutcome(registered.id, terminal);
    const checked = checkedTextPublicationReceipt(terminal, registered, input, digest);
    return { ...checked, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StalePublicationHead
      || error instanceof PublicationUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'contribution-publication');
  }
}
