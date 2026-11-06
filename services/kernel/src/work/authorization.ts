import type { Pool } from 'pg';
import { createAuthConsentReader, readAuthConsentConfig, type CurrentConsentReader } from '../access/auth-consent.ts';
import { createAccess } from '../access/index.ts';
import { readMembershipWorkConfig } from '../access/membership-work-config.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import { readReceiptKeyRing } from '../command/receipt-key.ts';
import { createKernel } from '../http/kernel.ts';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from './client.ts';

export type WorkerAuthorization = Readonly<{ access: Access; readConsent: CurrentConsentReader }>;
export { readAuthConsentConfig };

/** Trusted composition only: mounting the kernel creates no request or listener. */
export function createWorkerAuthorization(
  deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    env: Readonly<Record<string, string | undefined>>;
    clock: KernelClock;
    receiptKeys?: KeyRing;
  }>,
): WorkerAuthorization {
  const config = readMembershipWorkConfig(deps.env);
  const consent = readAuthConsentConfig(deps.env);
  const readConsent: CurrentConsentReader =
    consent === null
      ? async () => {
          throw new AccessUnavailableError('overloaded');
        }
      : createAuthConsentReader(consent);
  let access: Access | undefined;
  createKernel({
    pool: deps.pool,
    workClient: deps.client,
    routeKey: config.routeKey,
    tokens: config.referenceKeys,
    receiptKeys: readReceiptKeyRing(deps.env, deps.receiptKeys),
    clock: deps.clock,
    access: (mounted) => createAccess({ ...mounted, auth: config.auth, clock: deps.clock }),
    content: { readConsent },
    onAccessReady: (mounted) => {
      access = mounted;
    },
  });
  if (!access) throw new Error('Kernel composition did not supply worker Access');
  return Object.freeze({ access, readConsent });
}
