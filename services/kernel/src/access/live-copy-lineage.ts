import type { PoolClient } from 'pg';
import { LiveCopyPendingError } from './live-copy.ts';

export type LiveCopyLineage = {
  readonly partition: number;
  readonly domainId: string;
  readonly node: string;
  readonly epoch: number;
  readonly admittedPosition: string;
};

type LineageRow = {
  domain_id: string;
  node: string;
  epoch: number;
  admitted_position: string;
};

/** Native command/operational clients and fixture probes share this seek. pg overloads are not part of the contract. */
export type LiveCopyLineageClient = {
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: LineageRow[] }>;
};

/** Admitted migration lineage for one home. Writers never seed or rotate a domain. */
export async function readLiveCopyLineage(
  tx: LiveCopyLineageClient | Pick<PoolClient, 'query'>,
  partition: number,
): Promise<LiveCopyLineage> {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096)
    throw new TypeError('Invalid live copy lineage partition');
  const row = (
    await (tx as LiveCopyLineageClient).query(
      `SELECT d.domain_id,d.node,d.epoch,d.admitted_position::text
       FROM access.live_copy_domain d JOIN core.partition p USING(partition_no)
       WHERE d.partition_no=$1 AND d.state='active' AND p.write_state='active'
         AND (d.node,d.epoch)=(p.node,p.epoch) AND p.position>=d.admitted_position
       FOR SHARE OF d,p`,
      [partition],
    )
  ).rows[0];
  if (!row) throw new LiveCopyPendingError('Live copy domain requires native lineage reconciliation before activation');
  return {
    partition,
    domainId: row.domain_id,
    node: row.node,
    epoch: row.epoch,
    admittedPosition: row.admitted_position,
  };
}
