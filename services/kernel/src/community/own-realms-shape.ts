import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type confirmMembership from './own-realms-membership.sql';

/** Own-Realm dependencies supplied by composition: domain time is `clock`, never read here. */
export type OwnRealmsDependencies = {
  pool: Pool;
  tokens: KeyRing;
  access: Access;
  clock: () => Date;
};
export type OwnRealmMembership = NonNullable<Awaited<ReturnType<typeof confirmMembership.run>>> & {
  epoch: number;
  since: string;
};
/** Exact selected native episode and source, independent of presentation labels. */
export function sameOwnRealmMembership(a: OwnRealmMembership | null, b: OwnRealmMembership | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.realmId === b.realmId &&
    a.reservationId === b.reservationId &&
    a.transactionId === b.transactionId &&
    a.interval === b.interval &&
    a.since === b.since &&
    a.headRevisionId === b.headRevisionId &&
    a.lifecycleVersion === b.lifecycleVersion &&
    a.epoch === b.epoch
  );
}
