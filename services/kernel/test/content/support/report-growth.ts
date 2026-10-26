import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type ReportGrowthRow = {
  reportId: string;
  reportRoute: number;
  targetKind: 'board' | 'post';
  targetId: string;
  targetRoute: number;
  createdAt: string;
  transactionId: string;
  idempotencyKey: string;
  reporterAccountId?: string | null;
};

export type ReportGrowthBoard = {
  id: string;
  route: number;
  subjectId: string;
  transactionId: string;
};

/** Seed fixture noise with set-based writes while retaining the real indexed report shapes. */
export async function seedReportGrowth(
  admin: Pool,
  rows: readonly ReportGrowthRow[],
  boards: readonly ReportGrowthBoard[] = [],
  options: {
    projectTargets?: boolean;
    commandEvents?: { principalId: string; principalKind: 'account' | 'anonymous'; clientId?: string };
  } = {},
): Promise<void> {
  if (rows.length === 0 && boards.length === 0) return;
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    if (boards.length > 0) {
      await client.query(
        `INSERT INTO content.board
           (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
         SELECT route, board_id, subject_id, 'Distractor', 'published', 1, transaction_id
         FROM unnest($1::integer[], $2::uuid[], $3::uuid[], $4::uuid[])
           AS row(route, board_id, subject_id, transaction_id)`,
        [
          boards.map((board) => board.route),
          boards.map((board) => board.id),
          boards.map((board) => board.subjectId),
          boards.map((board) => board.transactionId),
        ],
      );
    }
    if (rows.length > 0) {
      await client.query(
        `INSERT INTO content.report
           (route, report_id, target_kind, target_id, revision_id, reason, evidence, reporter_account_id,
            created_at, recorded_transaction_id)
         SELECT report_route, report_id, target_kind, target_id, NULL, 'spam', 'Report evidence', reporter_account_id,
                created_at, transaction_id
         FROM unnest($1::integer[], $2::uuid[], $3::text[], $4::uuid[], $5::timestamptz[], $6::uuid[], $7::uuid[])
           AS row(report_route, report_id, target_kind, target_id, created_at, transaction_id, reporter_account_id)`,
        [
          rows.map((row) => row.reportRoute),
          rows.map((row) => row.reportId),
          rows.map((row) => row.targetKind),
          rows.map((row) => row.targetId),
          rows.map((row) => row.createdAt),
          rows.map((row) => row.transactionId),
          rows.map((row) => row.reporterAccountId ?? null),
        ],
      );
      if (options.projectTargets ?? true) {
        await client.query(
          `INSERT INTO content.report_target
             (route, target_kind, target_id, report_route, report_id, created_at)
           SELECT target_route, target_kind, target_id, report_route, report_id, created_at
           FROM unnest($1::integer[], $2::text[], $3::uuid[], $4::integer[], $5::uuid[], $6::timestamptz[])
             AS row(target_route, target_kind, target_id, report_route, report_id, created_at)`,
          [
            rows.map((row) => row.targetRoute),
            rows.map((row) => row.targetKind),
            rows.map((row) => row.targetId),
            rows.map((row) => row.reportRoute),
            rows.map((row) => row.reportId),
            rows.map((row) => row.createdAt),
          ],
        );
      }
      if (options.commandEvents) await seedCommandEvents(client, rows, options.commandEvents);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function seedCommandEvents(
  client: PoolClient,
  rows: readonly ReportGrowthRow[],
  actor: { principalId: string; principalKind: 'account' | 'anonymous'; clientId?: string },
): Promise<void> {
  const partitions = [...new Set(rows.map((row) => row.reportRoute >>> 4))];
  const { rows: states } = await client.query<{ partition_no: number; epoch: number; position: string }>(
    'SELECT partition_no, epoch, position::text AS position FROM core.partition WHERE partition_no=ANY($1::integer[])',
    [partitions],
  );
  const positions = new Map(states.map((state) => [state.partition_no, BigInt(state.position)]));
  const seeded = rows.map((row) => {
    const partition = row.reportRoute >>> 4;
    const position = (positions.get(partition) ?? 0n) + 1n;
    positions.set(partition, position);
    return { ...row, partition, position: position.toString() };
  });
  const epochs = new Map(states.map((state) => [state.partition_no, state.epoch]));
  const maxPositions = new Map<number, string>();
  for (const row of seeded) maxPositions.set(row.partition, row.position);
  const maximums = [...maxPositions];
  await client.query(
    `UPDATE core.partition AS partition
     SET position = seeded.position::bigint
     FROM unnest($1::integer[], $2::bigint[]) AS seeded(partition_no, position)
     WHERE partition.partition_no = seeded.partition_no`,
    [maximums.map(([partition]) => partition), maximums.map(([, position]) => position)],
  );
  await client.query(
    `INSERT INTO editorial.write_basis
       (partition_no, transaction_id, epoch, position, principal_id, client_id, principal_kind)
     SELECT partition_no, transaction_id, epoch, position::bigint, $1, $2, $3
     FROM unnest($4::integer[], $5::uuid[], $6::integer[], $7::bigint[])
       AS row(partition_no, transaction_id, epoch, position)`,
    [
      actor.principalId,
      actor.clientId ?? null,
      actor.principalKind,
      seeded.map((row) => row.partition),
      seeded.map((row) => row.transactionId),
      seeded.map((row) => epochs.get(row.partition) ?? 1),
      seeded.map((row) => row.position),
    ],
  );
  await client.query(
    `INSERT INTO core.receipt
       (partition_no, principal_kind, principal_id, command_kind, idempotency_key, request_digest,
        epoch, position, transaction_id, response)
     SELECT partition_no, $1, $2, 'content.report.create', idempotency_key,
            sha256(convert_to(idempotency_key, 'UTF8')), epoch, position::bigint, transaction_id,
            jsonb_build_object('reportId', report_id)
     FROM unnest($3::integer[], $4::text[], $5::integer[], $6::bigint[], $7::uuid[], $8::uuid[])
       AS row(partition_no, idempotency_key, epoch, position, transaction_id, report_id)`,
    [
      actor.principalKind,
      actor.principalId,
      seeded.map((row) => row.partition),
      seeded.map((row) => row.idempotencyKey),
      seeded.map((row) => epochs.get(row.partition) ?? 1),
      seeded.map((row) => row.position),
      seeded.map((row) => row.transactionId),
      seeded.map((row) => row.reportId),
    ],
  );
  await client.query(
    `INSERT INTO core.outbox
       (partition_no, position, event_seq, event_count, epoch, id, type, subject, data)
     SELECT partition_no, position::bigint, 0, 1, epoch, event_id,
            'com.rezics.content.report.created.v1', report_id::text,
            jsonb_build_object('reportId', report_id, 'targetKind', target_kind, 'targetId', target_id)
     FROM unnest($1::integer[], $2::bigint[], $3::integer[], $4::uuid[], $5::uuid[], $6::text[], $7::uuid[])
       AS row(partition_no, position, epoch, event_id, report_id, target_kind, target_id)`,
    [
      seeded.map((row) => row.partition),
      seeded.map((row) => row.position),
      seeded.map((row) => epochs.get(row.partition) ?? 1),
      seeded.map(() => randomUUID()),
      seeded.map((row) => row.reportId),
      seeded.map((row) => row.targetKind),
      seeded.map((row) => row.targetId),
    ],
  );
}
