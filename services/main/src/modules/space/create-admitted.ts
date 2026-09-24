import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { CancelledActivation, IdempotencyConflict,
  type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { createRealmSpace, readSpaceCreationReceipt, sealRealmSpaceAdmission,
  spaceCreationDigest, type CreateRealmSpaceInput, type SpaceCreationReceipt } from './create.ts';

export async function createAdmittedRealmSpace(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: CreateRealmSpaceInput & { idempotencyKey: string },
): Promise<SpaceCreationReceipt & { replayed: boolean }> {
  const digest = spaceCreationDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['space:create']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: 'space:create:root', action: 'space.create',
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
        await sealRealmSpaceAdmission(env, admission);
      } else {
        try { await createRealmSpace(env, admission, input); }
        catch (error) { if (error instanceof IdempotencyConflict) throw error; }
      }
    }
    const terminal = await readSpaceCreationReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'space-create');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('Space admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') {
      throw new CancelledActivation('Space creation was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof CancelledActivation) throw error;
    throw new PendingAdmittedWork(registered.id, 'space-create');
  }
}
