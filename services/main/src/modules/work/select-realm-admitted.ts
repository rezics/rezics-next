import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { assertGraphAdmissionOpen } from './restore-lineage.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from './activate.ts';
import { PendingAdmittedWork } from './create-admitted.ts';
import { checkedRealmSelectionReceipt, RealmSelectionUnavailable,
  realmSelectionDigest, readRealmSelectionReceipt, sealRealmSelectionAdmission,
  selectRealmLocal, StaleRealmSelection,
  type RealmSelectionReceipt, type SelectRealmLocalInput } from './select-realm.ts';

/** Realm manager authority is independent of contributor and Main maintainer control. */
export async function selectAdmittedRealmLocal(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: SelectRealmLocalInput & { idempotencyKey: string },
): Promise<RealmSelectionReceipt & { replayed: boolean }> {
  const digest = realmSelectionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['realm:adopt']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `publication:adopt:${input.context.id}`, action: 'publication.adopt',
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
        await sealRealmSelectionAdmission(env, admission);
      } else {
        try { await selectRealmLocal(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (error instanceof RealmSelectionUnavailable) {
            await sealRealmSelectionAdmission(env, admission);
          }
        }
      }
    }
    const terminal = await readRealmSelectionReceipt(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'realm-adoption');
    await access.recordGraphOutcome(registered.id, terminal);
    return { ...checkedRealmSelectionReceipt(terminal, registered, input, digest),
      replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof StaleRealmSelection
      || error instanceof RealmSelectionUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'realm-adoption');
  }
}
