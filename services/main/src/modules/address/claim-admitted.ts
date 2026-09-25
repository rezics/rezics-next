import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { AddressClaimConflict, AddressClaimUnavailable, claimWorkAddress,
  readWorkAddressTerminal, sealWorkAddressAdmission, workAddressDigest,
  type WorkAddressClaimInput } from './claim.ts';

/** A scoped Account/Access claim is settled by the same immutable graph receipt. */
export async function claimAdmittedWorkAddress(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: WorkAddressClaimInput & { idempotencyKey: string },
) {
  const digest = workAddressDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['address:claim']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `address:claim:${input.work}`, action: 'address.claim',
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
        await sealWorkAddressAdmission(env, admission);
      } else {
        try { await claimWorkAddress(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (!(error instanceof AddressClaimConflict || error instanceof AddressClaimUnavailable)) {
            throw error;
          }
        }
      }
    }
    const terminal = await readWorkAddressTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-address');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('address receipt differs from admission');
    }
    if (terminal.outcome === 'cancelled') {
      if (terminal.reason === 'slug-taken' || terminal.reason === 'work-address-exists') {
        throw new AddressClaimConflict('work address is already claimed');
      }
      throw new AddressClaimUnavailable('work address claim was cancelled');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof AddressClaimConflict
      || error instanceof AddressClaimUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-address');
  }
}
