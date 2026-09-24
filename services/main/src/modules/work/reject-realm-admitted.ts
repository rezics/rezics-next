import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { checkedRealmRejectionReceipt, RealmRejectionUnavailable,
  realmRejectionDigest, readRealmRejectionReceipt, rejectRealmLocal,
  sealRealmRejectionAdmission, StaleRealmRejection,
  type RealmRejectionReceipt, type RejectRealmLocalInput } from './reject-realm.ts';

/** A local suppression uses a separate manager authority and durable admission. */
export async function rejectAdmittedRealmLocal(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: RejectRealmLocalInput & { idempotencyKey: string },
): Promise<RealmRejectionReceipt & { replayed: boolean }> {
  const digest = realmRejectionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['realm:reject']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `publication:reject:${input.context.id}`, action: 'publication.reject',
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
        await sealRealmRejectionAdmission(env, admission);
      } else {
        try { await rejectRealmLocal(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RealmRejectionUnavailable) {
            await sealRealmRejectionAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readRealmRejectionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'realm-rejection');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedRealmRejectionReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRealmRejection
      || error instanceof RealmRejectionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'realm-rejection');
  }
}
