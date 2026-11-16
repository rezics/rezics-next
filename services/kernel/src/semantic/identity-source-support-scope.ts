import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import type { AuthoritativeTime } from '../command/command.ts';
import type { Partition } from '../partition/partition.ts';
import type { IdentityJobRef } from './identity-epoch-contract.ts';

type RootCheck = Readonly<{
  original: string;
  check(tx: PoolClient, owner: Partition, visibility: string, time: AuthoritativeTime | null): Promise<void>;
}>;

// The support bridge alone installs this scope. Its projection check runs on the native Source snapshot.
const jobs = new AsyncLocalStorage<Readonly<{ job: IdentityJobRef; root?: RootCheck }>>();
export function withIdentitySourceSupportJob<T>(job: IdentityJobRef, read: () => T, root?: RootCheck): T {
  return jobs.run(Object.freeze({ job: Object.freeze({ ...job }), root }), read);
}
export function identitySourceSupportJob(): IdentityJobRef | undefined {
  return jobs.getStore()?.job;
}
export function identitySourceSupportRoot(): RootCheck | undefined {
  return jobs.getStore()?.root;
}
