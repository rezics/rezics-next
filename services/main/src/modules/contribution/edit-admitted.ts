import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { checkedTextContributionEditReceipt, ContributionEditUnavailable,
  editTextContributionDraft, readTextContributionEditReceipt,
  sealTextContributionEditAdmission, StaleContributionDraftHead,
  textContributionEditDigest, type EditTextContributionInput,
  type TextContributionEditReceipt } from './edit.ts';

/** Current Account and Contribution-specific Access admission precede the edit. */
export async function editAdmittedTextContribution(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: EditTextContributionInput & { idempotencyKey: string },
): Promise<TextContributionEditReceipt & { replayed: boolean }> {
  const digest = textContributionEditDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `contribution:edit:${input.contribution}`, action: 'contribution.edit',
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
        await sealTextContributionEditAdmission(env, admission);
      } else {
        try { await editTextContributionDraft(env, admission, input); }
        catch (error) { if (error instanceof IdempotencyConflict) throw error; }
      }
    }
    const terminal = await readTextContributionEditReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'contribution-edit');
    await access.recordGraphOutcome(registered.id, terminal);
    const checked = checkedTextContributionEditReceipt(terminal, registered, input, digest);
    return { ...checked, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleContributionDraftHead
      || error instanceof ContributionEditUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'contribution-edit');
  }
}
