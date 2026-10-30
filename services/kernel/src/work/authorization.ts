import type { Pool } from 'pg';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { AccessUnavailableError } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from './client.ts';

export type WorkerAuthorization = Readonly<{ access: Access; readConsent: CurrentConsentReader }>;

/** Accounts owns the mounted native factory; this declaration grants no fallback authority. */
export function createWorkerAuthorization(_options: {
  pool: Pool;
  client: WorkClient;
  env: Readonly<Record<string, string | undefined>>;
  clock: KernelClock;
  receiptKeys?: KeyRing;
}): WorkerAuthorization {
  throw new AccessUnavailableError('overloaded');
}
