import type { QueryResultRow } from 'pg';
import type { AccessClient } from '../request/access.ts';

export const PUBLICATION_AUTHORITY_HOME_COUNT = 4096;

export type PublicationAuthorityEpoch = Readonly<{
  home: number;
  generation: string;
  epoch: string;
}>;

type EpochRow = QueryResultRow & {
  home_no: number;
  generation: string;
  epoch: string;
};

export type PublicationAuthorityLockResult = Readonly<{
  matches: boolean;
  locked: readonly PublicationAuthorityEpoch[];
}>;

/** Read the installed fixed topology in one statement snapshot before authority observations begin. */
export async function capturePublicationAuthorityVector(
  client: AccessClient,
): Promise<readonly PublicationAuthorityEpoch[]> {
  const result = await client.query<EpochRow>(
    `SELECT home_no,generation::text,epoch::text
     FROM core.publication_authority_epoch
     ORDER BY home_no`,
  );
  if (
    result.rows.length !== PUBLICATION_AUTHORITY_HOME_COUNT ||
    result.rows.some((row, index) => row.home_no !== index)
  )
    throw new Error('Publication authority topology is incomplete');
  return result.rows.map((row) => ({ home: row.home_no, generation: row.generation, epoch: row.epoch }));
}

/** Lock only owner-proved homes in deterministic order and compare their captured epochs. */
export async function lockAndComparePublicationAuthorityHomes(
  client: AccessClient,
  expected: readonly PublicationAuthorityEpoch[],
): Promise<PublicationAuthorityLockResult> {
  const ordered = [...new Map(expected.map((entry) => [entry.home, entry])).values()].sort(
    (left, right) => left.home - right.home,
  );
  const lockedRows = await client.query<EpochRow>(
    `SELECT home_no,generation::text,epoch::text
     FROM core.lock_publication_authority($1::integer[])`,
    [ordered.map((entry) => entry.home)],
  );
  const locked = lockedRows.rows.map((row) => ({ home: row.home_no, generation: row.generation, epoch: row.epoch }));
  const current = new Map(locked.map((entry) => [entry.home, entry]));
  const matches =
    locked.length === ordered.length &&
    ordered.every((entry) => {
      const observed = current.get(entry.home);
      return observed?.generation === entry.generation && observed.epoch === entry.epoch;
    });
  return { matches, locked };
}
