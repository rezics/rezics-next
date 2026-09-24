import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { checkedMainSelectionReceipt, MainSelectionUnavailable,
  mainSelectionDigest, readMainSelectionReceipt, sealMainSelectionAdmission,
  selectMainDefault, StaleMainSelection,
  type MainSelectionReceipt, type SelectMainDefaultInput } from './select-main.ts';

/** Separate Main maintainer authority is required to select an eligible draft. */
export async function selectAdmittedMainDefault(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SelectMainDefaultInput & { idempotencyKey: string },
): Promise<MainSelectionReceipt & { replayed: boolean }> {
  const digest = mainSelectionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `publication:select:${input.context.id}`, action: 'publication.select',
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
        await sealMainSelectionAdmission(env, admission);
      } else {
        try { await selectMainDefault(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof MainSelectionUnavailable) {
            await sealMainSelectionAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readMainSelectionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'publication-selection');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedMainSelectionReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleMainSelection
      || error instanceof MainSelectionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'publication-selection');
  }
}
