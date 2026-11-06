import type { Pool } from 'pg';
import { readAuthConsentConfig, type CurrentConsentReader } from '../access/auth-consent.ts';
import type { KernelClock } from '../clock.ts';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from './client.ts';
export type WorkerAuthorization = Readonly<{
    access: Access;
    readConsent: CurrentConsentReader;
}>;
export { readAuthConsentConfig };
/** Trusted composition only: mounting the kernel creates no request or listener. */
export declare function createWorkerAuthorization(deps: Readonly<{
    pool: Pool;
    client: WorkClient;
    env: Readonly<Record<string, string | undefined>>;
    clock: KernelClock;
    receiptKeys?: KeyRing;
}>): WorkerAuthorization;
