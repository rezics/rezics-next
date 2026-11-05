import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { CommandUnavailableError, requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import { withRequestDeadline } from '../request/deadline.ts';
import { withReadTransaction } from './read.ts';

/** Native structural tuple. Generation/pending remain Semantic's identity authority. */
export type HomeIdentity = Readonly<{
  partition: number;
  epoch: number;
  home: string;
  generation: bigint;
  pending: bigint;
}>;
export type IdentityBasis = Readonly<{ digest: string }>;
export type BasisRead = { state: 'ready'; basis: IdentityBasis } | { state: 'not_ready' };

const HOME_SQL = `SELECT p.partition_no, p.epoch, p.node, p.write_state, p.moved_to,
  (COALESCE(g.version_sum, 0) + COALESCE(r.seq_sum, 0))::text AS generation,
  (COALESCE(g.pending_count, 0) + CASE WHEN c.pending_job IS NOT NULL THEN 1 ELSE 0 END)::text AS pending
FROM core.partition p
LEFT JOIN semantic.identity_epoch_control c ON c.partition_no = p.partition_no
LEFT JOIN (
  SELECT partition_no, SUM(version) AS version_sum,
    COUNT(*) FILTER (WHERE pending_job IS NOT NULL) AS pending_count
  FROM semantic.identity_epoch_group GROUP BY partition_no
) g ON g.partition_no = p.partition_no
LEFT JOIN (
  SELECT (route / 16) AS partition_no, SUM(sequence) AS seq_sum
  FROM semantic.redirect GROUP BY route / 16
) r ON r.partition_no = p.partition_no`;

type HomeRow = {
  partition_no: number;
  epoch: number;
  node: string;
  write_state: string;
  moved_to: string | null;
  generation: string;
  pending: string;
};

function homeFrom(row: HomeRow | undefined, partition: number): HomeIdentity {
  if (row?.write_state === 'moved') throw new CommandUnavailableError('moved', partition, row.moved_to);
  if (row?.write_state === 'fenced') throw new CommandUnavailableError('fenced', partition);
  if (!row || row.write_state !== 'active') throw new CommandUnavailableError('deadline', partition);
  return {
    partition,
    epoch: row.epoch,
    home: row.node,
    generation: BigInt(row.generation),
    pending: BigInt(row.pending),
  };
}

export async function readIdentityHome(client: PoolClient, partition: number): Promise<HomeIdentity> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096) throw new RangeError('Invalid identity home');
  const result = await client.query<HomeRow>(`${HOME_SQL} WHERE p.partition_no = $1`, [partition]);
  return homeFrom(result.rows[0], partition);
}

async function readIdentityHomes(client: PoolClient): Promise<readonly HomeIdentity[] | null> {
  const result = await client.query<HomeRow>(
    `${HOME_SQL} WHERE p.partition_no BETWEEN 0 AND 4095 ORDER BY p.partition_no`,
  );
  if (result.rows.length !== 4096) return null;
  const homes: HomeIdentity[] = [];
  for (let partition = 0; partition < 4096; partition++) {
    const row = result.rows[partition];
    if (!row || row.partition_no !== partition || row.write_state !== 'active') return null;
    homes.push({
      partition,
      epoch: row.epoch,
      home: row.node,
      generation: BigInt(row.generation),
      pending: BigInt(row.pending),
    });
  }
  return homes;
}

function tuples(homes: readonly HomeIdentity[]): string {
  const field = (value: string) => `${Buffer.byteLength(value, 'utf8')}:${value}`;
  return (
    field('rezics.identity-basis.v1') +
    homes
      .map((home) =>
        [String(home.partition), String(home.epoch), home.home, home.generation.toString()].map(field).join(''),
      )
      .join('')
  );
}

/** Two released observations, never an Access decision or promise about subsequent writes. */
export async function readIdentityBasis(pool: Pool, options: { deadline: number }): Promise<BasisRead> {
  const { deadline } = options;
  try {
    requireAccessDeadline(deadline);
    const first = await withRequestDeadline(deadline, () => withReadTransaction(pool, readIdentityHomes, deadline));
    requireAccessDeadline(deadline);
    const second = await withRequestDeadline(deadline, () => withReadTransaction(pool, readIdentityHomes, deadline));
    requireAccessDeadline(deadline);
    if (!first || !second || first.some((home) => home.pending !== 0n) || second.some((home) => home.pending !== 0n))
      return { state: 'not_ready' };
    const encoded = tuples(first);
    if (encoded !== tuples(second)) return { state: 'not_ready' };
    requireAccessDeadline(deadline);
    return { state: 'ready', basis: { digest: createHash('sha256').update(encoded, 'utf8').digest('hex') } };
  } catch (error) {
    throwAccessUnavailable(error, deadline);
    throw error;
  }
}
