import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { checkedClassificationDecisionReceipt, classificationDecisionDigest,
  classificationDecisionScope, ClassificationDecisionUnavailable,
  readClassificationDecisionReceipt, sealClassificationDecisionAdmission,
  setClassificationDecision, StaleClassificationDecision,
  type ClassificationDecisionReceipt, type SetClassificationDecisionInput } from './decision.ts';

export async function setAdmittedClassificationDecision(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SetClassificationDecisionInput & { idempotencyKey: string },
): Promise<ClassificationDecisionReceipt & { replayed: boolean }> {
  const digest = classificationDecisionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['classification:decide']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: classificationDecisionScope(input.context), action: 'classification.decision.set',
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
        await sealClassificationDecisionAdmission(env, admission);
      } else {
        try { await setClassificationDecision(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof ClassificationDecisionUnavailable) {
            await sealClassificationDecisionAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readClassificationDecisionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'classification-decision');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedClassificationDecisionReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleClassificationDecision
      || error instanceof ClassificationDecisionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'classification-decision');
  }
}
