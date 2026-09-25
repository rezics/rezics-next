import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry } from '../access/admission.ts';
import { IdempotencyConflict, type WorkActivationEnvironment } from '../work/activate.ts';
import { PendingAdmittedWork } from '../work/create-admitted.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { AddressClaimConflict, AddressClaimUnavailable } from './claim.ts';
import { readWorkAddressRenameTerminal, renameWorkAddress,
  sealWorkAddressRenameAdmission, workAddressRenameDigest,
  type WorkAddressRenameInput } from './rename.ts';

export async function renameAdmittedWorkAddress(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: WorkAddressRenameInput & { idempotencyKey: string },
) {
  const digest = workAddressRenameDigest(input);
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['address:manage']);
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope: `address:rename:${input.work}`, action: 'address.rename',
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
        await sealWorkAddressRenameAdmission(env, admission);
      } else {
        try { await renameWorkAddress(env, admission, input); }
        catch (error) {
          if (error instanceof IdempotencyConflict) throw error;
          if (!(error instanceof AddressClaimConflict || error instanceof AddressClaimUnavailable)) {
            throw error;
          }
        }
      }
    }
    const terminal = await readWorkAddressRenameTerminal(env, registered.id);
    if (!terminal) throw new PendingAdmittedWork(registered.id, 'work-address-rename');
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.admissionId !== registered.id || terminal.requestDigest !== digest
      || terminal.authorityEpoch !== registered.authorityEpoch
      || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('address rename receipt differs from admission');
    }
    if (terminal.outcome === 'cancelled') {
      throw new AddressClaimConflict(terminal.reason === 'slug-taken'
        ? 'new work slug is taken' : 'address rename head changed');
    }
    return { ...terminal, replayed: registered.replayed };
  } catch (error) {
    if (error instanceof IdempotencyConflict || error instanceof AddressClaimConflict
      || error instanceof AddressClaimUnavailable) throw error;
    throw new PendingAdmittedWork(registered.id, 'work-address-rename');
  }
}
