import type { Pool } from 'pg';
import type { CurrentConsentReader } from '../access/auth-consent.ts';

const mountedConsent = new WeakMap<Pool, CurrentConsentReader>();

/** Trusted kernel composition only; mount the actual Auth-owned current reader. */
export function mountContentEditionConsent(pool: Pool, reader: CurrentConsentReader): void {
  mountedConsent.set(pool, reader);
}

export function mountedContentEditionConsent(pool: Pool): CurrentConsentReader | undefined {
  return mountedConsent.get(pool);
}
