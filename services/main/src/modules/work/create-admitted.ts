import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import type { AccessAdmissionRegistry } from '../access/admission.ts';
import {
  activateMetadataWork, metadataWorkRequestDigest,
  type WorkActivationEnvironment, type WorkActivationReceipt,
} from './activate.ts';

export interface AdmittedMetadataWorkInput {
  actingSubject: string;
  idempotencyKey: string;
  title: string;
}

/** Internal only until claim/strong-revoke and public error handling are complete. */
export async function createAdmittedMetadataWork(
  env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register'>,
  request: Request,
  input: AdmittedMetadataWorkInput,
): Promise<WorkActivationReceipt> {
  const digest = metadataWorkRequestDigest(input.title);
  const principal = await account.verify(request, ['work:create']);
  const admission = await access.register({
    principal,
    actingSubject: input.actingSubject,
    scope: 'work:create:root',
    action: 'work.create',
    idempotencyKey: input.idempotencyKey,
    requestDigest: digest,
  });
  return activateMetadataWork(env, { admission, title: input.title });
}
