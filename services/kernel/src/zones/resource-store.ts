import type { ZoneStarter } from '@rezics/composition';
import type { AccessClient } from '../request/access.ts';
import type { CommandTransaction } from '../command/command.ts';
import head from './resource-head.sql';
import lock from './resource-lock.sql';
import insert from './resource-insert.sql';
import cas from './resource-cas.sql';
import keys from './resource-owner-keys.sql';
import owner from './resource-owner-evidence.sql';

/** Internal authoritative head. This type must never be serialized as a public response. */
export type ZoneHead = Omit<
  NonNullable<Awaited<ReturnType<typeof head.run>>>,
  'configuration' | 'visibility' | 'mounts'
> & {
  configuration: ZoneStarter | null;
  visibility: 'private' | 'unlisted' | 'public';
  mounts: string[] | null;
};
function model(row: NonNullable<Awaited<ReturnType<typeof head.run>>>): ZoneHead {
  if (!['private', 'unlisted', 'public'].includes(row.visibility)) throw new Error('Invalid stored visibility');
  if (row.mounts?.some((id) => id === null)) throw new Error('Invalid stored mount');
  return row as ZoneHead;
}
export async function readZoneHead(client: AccessClient, route: number, id: string): Promise<ZoneHead | null> {
  const row = await head.run(client, { route, id });
  return row ? model(row) : null;
}
/** Caller owns the command transaction; locks the exact resource head, never starts or commits a transaction. */
export async function lockZoneHead(tx: CommandTransaction, route: number, id: string): Promise<ZoneHead | null> {
  const row = await lock.run(tx, { route, id });
  return row ? model(row) : null;
}
export async function insertZone(
  tx: CommandTransaction,
  input: {
    route: number;
    id: string;
    ownerId: string;
    visibility: ZoneHead['visibility'];
    configuration: ZoneStarter;
    mounts: string[];
    releaseDigest: string;
    at: string;
    transactionId: string;
  },
): Promise<ZoneHead> {
  const [row] = await insert.run(tx, {
    route: input.route,
    id: input.id,
    owner_id: input.ownerId,
    visibility: input.visibility,
    configuration: input.configuration,
    mounts: input.mounts,
    release_digest: input.releaseDigest,
    at: input.at,
    transaction_id: input.transactionId,
  });
  if (!row) throw new Error('Zone insert returned no head');
  return model(row);
}
/** Sole payload/state writer. Supply the locked head; both resource and lifecycle revisions fence the update.
 * Lifecycle callers share their command transaction with receipts/outbox and preserve independent evidence.
 */
export async function compareAndSetZone(
  tx: CommandTransaction,
  before: ZoneHead,
  next: Pick<
    ZoneHead,
    | 'ownerId'
    | 'state'
    | 'visibility'
    | 'configuration'
    | 'mounts'
    | 'releaseDigest'
    | 'deletedAt'
    | 'restoreUntil'
    | 'writeFenced'
    | 'withholding'
    | 'held'
  >,
  context: { at: string; transactionId: string },
): Promise<ZoneHead | null> {
  const [row] = await cas.run(tx, {
    route: before.route,
    id: before.id,
    revision: before.revision,
    lifecycle_revision: before.lifecycleRevision,
    owner_id: next.ownerId,
    state: next.state,
    visibility: next.visibility,
    configuration: next.configuration,
    mounts: next.mounts,
    release_digest: next.releaseDigest,
    deleted_at: next.deletedAt,
    restore_until: next.restoreUntil,
    write_fenced: next.writeFenced,
    withholding: next.withholding,
    held: next.held,
    at: context.at,
    transaction_id: context.transactionId,
  });
  return row ? model(row) : null;
}
export function ownerZoneKeys(
  client: AccessClient,
  input: {
    route: number;
    owner_id: string;
    state: string;
    after: string;
    limit: number;
  },
) {
  return keys.run(client, input);
}
/** Current ordinary role evidence only; native Access still decides every action and actor admission. */
export async function hasZoneOwnerRole(client: AccessClient, route: number, id: string, accountId: string, at: string) {
  return (await owner.run(client, { route, id, account_id: accountId, at })) !== null;
}
