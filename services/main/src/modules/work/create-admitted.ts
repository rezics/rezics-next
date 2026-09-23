import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import {
  activateMetadataWork, CancelledActivation, IdempotencyConflict, metadataWorkRequestDigest,
  PendingActivation, type WorkActivationEnvironment, type WorkActivationReceipt,
} from './activate.ts';
import { readWorkTerminalReceipt } from './receipt.ts';

export interface AdmittedMetadataWorkInput {
  actingSubject: string;
  idempotencyKey: string;
  title: string;
}

/** Internal only until claim/strong-revoke and public error handling are complete. */
export async function createAdmittedMetadataWork(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>,
  request: Request,
  input: AdmittedMetadataWorkInput,
): Promise<WorkActivationReceipt> {
  const digest = metadataWorkRequestDigest(input.title);
  const principal = await account.verify(request, ['work:create']);
  const registered = await access.register({
    principal,
    actingSubject: input.actingSubject,
    scope: 'work:create:root',
    action: 'work.create',
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
  });
  if (registered.state === 'sealed') {
    const terminal = await readWorkTerminalReceipt(env.fuseki, registered.id);
    if (!terminal) throw new PendingActivation('sealed Access admission has no graph receipt');
    if (terminal.requestDigest !== digest || terminal.admissionId !== registered.id
      || terminal.authorityEpoch !== registered.authorityEpoch || terminal.scope !== registered.scope) {
      throw new IdempotencyConflict('sealed Access admission differs from graph receipt');
    }
    if (terminal.outcome === 'cancelled') throw new CancelledActivation('Work admission was cancelled');
    return { work: terminal.work!, mainVersion: terminal.mainVersion!, receipt: terminal.receipt,
      admissionId: registered.id, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence,
      replayed: true };
  }
  const admission = await access.claim(registered.id, digest);
  const result = await activateMetadataWork(env, { admission, title: input.title });
  const terminal = await readWorkTerminalReceipt(env.fuseki, admission.id);
  if (!terminal || terminal.outcome !== 'succeeded') {
    throw new PendingActivation('Work receipt needs Access reconciliation');
  }
  await access.recordGraphOutcome(admission.id, terminal);
  return result;
}
