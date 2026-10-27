import { shareAccount } from '../access/account-share.ts';
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { LibraryProfilePin } from './profile.ts';
import entryPage from './profile-migration-entry.sql';
import sessionPage from './profile-migration-session.sql';
import copyPage from './profile-migration-copy.sql';

/** Trusted database maintenance only. The caller verifies the immutable destination
 * release and owns orchestration, page receipts/checkpoints and the eventual writer cutover.
 * This acquires the native owner deletion fence; it supplies no human authorization.
 */
export async function pinLegacyFactsPage(
  tx: CommandTransaction,
  input: {
    accountId: string;
    kind: 'entry' | 'session' | 'copy';
    releaseDigest: string;
    after: string | null;
    limit: number;
  },
): Promise<{ examined: number; changed: number; after: string | null; exhausted: boolean }> {
  const { accountId, kind, releaseDigest, after, limit } = input;
  const route = routeOf(accountId);
  if (route === null || (after !== null && routeOf(after) === null))
    throw new TypeError('Invalid legacy pin page identity');
  if (kind !== 'entry' && kind !== 'session' && kind !== 'copy') throw new TypeError('Invalid legacy pin page kind');
  if (typeof releaseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(releaseDigest))
    throw new TypeError('Invalid legacy pin release digest');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError('Legacy pin page limit must be an integer from 1 to 100');
  if (currentCommand(tx).partition !== partitionOf(route))
    throw new TypeError('Legacy pin owner belongs to another command partition');
  await shareAccount(tx, accountId);

  const pin: LibraryProfilePin = {
    provenance: 'legacy',
    releaseDigest,
    acceptingType: null,
    profileId: 'legacy-fixed-v1',
  };
  const statement = kind === 'entry' ? entryPage : kind === 'session' ? sessionPage : copyPage;
  const rows = await statement.run(tx, {
    route,
    account_id: accountId,
    // All validated routable IDs are greater than this first-page lower bound.
    after_id: after ?? '00000000-0000-0000-0000-000000000000',
    page_limit: limit,
    pin: JSON.stringify(pin),
  });
  if (rows.some((row) => row.incompatible)) throw new Error('Incompatible unpinned legacy copy kind');
  return {
    examined: rows.length,
    changed: rows.filter((row) => row.changed).length,
    after: rows.at(-1)?.id ?? after,
    // A full page deliberately needs another seek; there is no uncharged lookahead.
    exhausted: rows.length < limit,
  };
}
