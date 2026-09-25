import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { AddressClaimConflict, AddressClaimUnavailable } from './claim.ts';
import { disposeWorkAddress, readWorkAddressDispositionTerminal,
  sealWorkAddressDispositionAdmission, workAddressDispositionDigest,
  type WorkAddressDispositionInput } from './dispose.ts';

export async function disposeAdmittedWorkAddress(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: WorkAddressDispositionInput & { idempotencyKey: string },
) {
  const digest = workAddressDispositionDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['address:manage']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `address:dispose:${input.work}`, action: 'address.dispose',
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
        await sealWorkAddressDispositionAdmission(env, admission);
      } else {
        try { await disposeWorkAddress(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (!(error instanceof AddressClaimConflict || error instanceof AddressClaimUnavailable)) {
            throw error;
          }
        }
      }
    }
    const terminal = await readWorkAddressDispositionTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-address-disposition');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('address disposition receipt differs from admission');
    }
    if (terminal.outcome === 'cancelled') {
      throw new AddressClaimConflict(terminal.reason === 'target-unavailable'
        ? 'merge target has no current address' : 'address disposition head changed');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof AddressClaimConflict
      || error instanceof AddressClaimUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-address-disposition');
  }
}
