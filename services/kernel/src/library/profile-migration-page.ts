import { shareAccount } from '../access/account-share.ts';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { fenceOperationalAccount } from '../access/account-share.ts';
import { hasLiveOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { LibraryProfilePin } from './profile.ts';

export type LibraryProfileMigrationSource = {
  id: string;
  revision: number;
  incarnationId: string | null;
  pin: LibraryProfilePin | null;
  kind: string | null;
  deleted: boolean;
};
const sources = {
  entry: { table: 'entry', key: 'subject_id' },
  session: { table: 'progress_session', key: 'session_id' },
  copy: { table: 'copy', key: 'copy_id' },
} as const;

/** Trusted database maintenance only. The caller verifies the immutable destination
 * release and owns orchestration, page receipts/checkpoints and the eventual writer cutover.
 * This acquires the native owner deletion fence; it supplies no human authorization.
 */
export async function pinLegacyFactsPage(
  tx: CommandTransaction | OperationalTransaction,
  input: {
    accountId: string;
    kind: 'entry' | 'session' | 'copy';
    releaseDigest: string;
    after: string | null;
    limit: number;
    observeRead?: (rows: readonly LibraryProfileMigrationSource[]) => void | Promise<void>;
    observeChanged?: (ids: readonly string[]) => void;
  },
): Promise<{ examined: number; changed: number; after: string | null; exhausted: boolean }> {
  const { accountId, kind, releaseDigest, after, limit } = input;
  const route = routeOf(accountId);
  if (route === null || accountId.length !== 36 || (after !== null && (routeOf(after) === null || after.length !== 36)))
    throw new TypeError('Invalid legacy pin page identity');
  if (kind !== 'entry' && kind !== 'session' && kind !== 'copy') throw new TypeError('Invalid legacy pin page kind');
  if (typeof releaseDigest !== 'string' || releaseDigest.length !== 71 || !/^sha256:[0-9a-f]{64}$/.test(releaseDigest))
    throw new TypeError('Invalid legacy pin release digest');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Legacy pin page limit must be an integer from 1 to 100');
  if (hasLiveOperationalTransaction(tx)) {
    await fenceOperationalAccount(tx, accountId);
  } else {
    if (currentCommand(tx).partition !== partitionOf(route))
      throw new TypeError('Legacy pin owner belongs to another command partition');
    await shareAccount(tx, accountId);
  }

  const pin: LibraryProfilePin = {
    provenance: 'legacy',
    releaseDigest,
    acceptingType: null,
    profileId: 'legacy-fixed-v1',
  };
  const { table, key } = sources[kind];
  // Charge every source key, including pinned and deleted rows. Read without row
  // locks so a current writer can win before the revision/incarnation CAS. The
  // owning serializable transaction retries a conflicting snapshot in full.
  const { rows } = await tx.query<LibraryProfileMigrationSource>(
    `/* library.profileMigration.source:${kind} */
     SELECT ${key}::text AS id, revision,
       ${kind === 'entry' ? 'incarnation_id::text' : 'NULL::text'} AS "incarnationId",
       library_profile_pin AS pin, ${kind === 'copy' ? 'kind' : 'NULL::text'} AS kind,
       ${kind === 'copy' ? 'deletion_id IS NOT NULL' : 'false'} AS deleted
     FROM library.${table}
     WHERE route=$1 AND account_id=$2 AND ${key}>$3::uuid
     ORDER BY ${key} LIMIT $4`,
    [route, accountId, after ?? '00000000-0000-0000-0000-000000000000', limit],
  );
  await input.observeRead?.(rows);
  const pending = rows.filter((row) => row.pin === null && !row.deleted);
  if (kind === 'copy' && pending.some((row) => row.kind !== null && row.kind !== 'legacy-unspecified'))
    throw new Error('Incompatible unpinned legacy copy kind');
  const changed = pending.length
    ? (await tx.query<{ id: string }>(
        `/* library.profileMigration.cas:${kind} */
         UPDATE library.${table} AS fact
         SET library_profile_pin=$3::jsonb
           ${kind === 'copy' ? ",kind=COALESCE(fact.kind,'legacy-unspecified'),kind_profile_pin=$3::jsonb,status_profile_pin=$3::jsonb" : ''}
         FROM jsonb_to_recordset($4::jsonb) AS source(id uuid,revision integer,"incarnationId" uuid)
         WHERE fact.route=$1 AND fact.account_id=$2 AND fact.${key}=source.id
           AND fact.revision=source.revision AND fact.library_profile_pin IS NULL
           ${kind === 'entry' ? 'AND fact.incarnation_id IS NOT DISTINCT FROM source."incarnationId"' : ''}
           ${kind === 'copy' ? 'AND fact.deletion_id IS NULL' : ''}
         RETURNING fact.${key}::text AS id`,
        [route, accountId, JSON.stringify(pin), JSON.stringify(pending)],
      )).rows
    : [];
  input.observeChanged?.(changed.map((row) => row.id));
  return {
    examined: rows.length,
    changed: changed.length,
    after: rows.at(-1)?.id ?? after,
    // A full page deliberately needs another seek; there is no uncharged lookahead.
    exhausted: rows.length < limit,
  };
}
