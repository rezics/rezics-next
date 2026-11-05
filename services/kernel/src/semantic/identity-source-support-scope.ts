import { AsyncLocalStorage } from 'node:async_hooks';
import type { IdentityJobRef } from './identity-epoch-contract.ts';

// Only the support bridge installs this scope, after reading genuine mapping custody.
// It changes identity availability, never Access, disclosure or candidate eligibility.
const jobs = new AsyncLocalStorage<IdentityJobRef>();
export function withIdentitySourceSupportJob<T>(job: IdentityJobRef, read: () => T): T {
  return jobs.run(Object.freeze({ ...job }), read);
}
export function identitySourceSupportJob(): IdentityJobRef | undefined {
  return jobs.getStore();
}
