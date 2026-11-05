/** Retained-occurrence SQL declarations. Plans retain original operands and clients. */
import { declareBound, sumBounds, type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
import { runLibraryBoundedStep } from './command-support.ts';
import { SELECTED_COST } from '../work/selected-runtime-cost.ts';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import { PARTITIONS } from '../route/route.ts';
import due from './member-retention-due-page.sql';
import purge from './member-retention-purge.sql';
import remove from './collection-store-collection-member-delete.sql';
import restore from './collection-store-collection-member-restore.sql';
import read from './collection-store-collection-member-retention-read.sql';
import partition from '../partition/read.sql';

type Client = Pick<PoolClient, 'query'>;
const size = (input: unknown) => Buffer.byteLength(JSON.stringify(input, (_, v) => typeof v === 'bigint' ? String(v) : v));
export const retentionCost = (part: Partial<Bound> = {}): Bound => declareBound({
  candidateKeys: 0, nativeRows: 0, identityMetadataRows: 0, emptySeeks: 0,
  nativePoints: 0, witnessKeys: 0, statements: 0, bytes: 0, engineRequests: 0, ...part,
});
const uuid = 'f'.repeat(36);
const timestamp = '\0'.repeat(64);
// Schema maxima, including JSON escaping, rather than one observed successful row.
const memberBytes = size({ collectionId: uuid, id: uuid, subjectId: uuid, note: '\0'.repeat(2000),
  ordinalKey: '\0'.repeat(48), addedAt: timestamp, deletionId: uuid, revision: '9223372036854775807' });
const dueBytes = size({ purgeAfter: timestamp, route: 65535, collectionId: uuid, memberId: uuid, deletionId: uuid });

export const MEMBER_RETENTION_LIMITS = Object.freeze({ seeks: 100, partitions: PARTITIONS, pages: 100,
  selected: 100, retries: COMMAND_STEP_RETRIES.maxAttempts });

type Shape = Readonly<{ examined: number; points: number; returned: number; rowBytes: number; candidates: number }>;
export function memberRetentionSqlPlan(sql: string, values: readonly unknown[], shape: Shape) {
  const serializedBinds = JSON.stringify(values);
  return Object.freeze({ sql, serializedBinds, examinedRows: shape.examined, resultLimit: shape.returned,
    total: retentionCost({ candidateKeys: shape.candidates, nativeRows: shape.examined,
      nativePoints: shape.points, emptySeeks: shape.points, statements: 1,
      bytes: Buffer.byteLength(sql) + Buffer.byteLength(serializedBinds) + 2 + shape.returned * (shape.rowBytes + 1) }),
  });
}

/** A negative point probe has the same examined-work ceiling as a successful probe. */
export function memberRetentionPoint(sql: string, values: readonly unknown[], rows = 1, rowBytes = memberBytes) {
  return memberRetentionSqlPlan(sql, values, { examined: rows, points: rows, returned: rows, rowBytes, candidates: 1 });
}

export function memberRetentionDuePlan(input: Parameters<typeof due.run>[1]) {
  // UNION's one-time gates open exactly one indexed range. No prior history is a candidate.
  return memberRetentionSqlPlan(due.sql, due.params.map(key => input[key as keyof typeof input]), {
    examined: input.page_limit, points: 1, returned: input.page_limit, rowBytes: dueBytes, candidates: input.page_limit,
  });
}

export function memberRetentionRemovalPlan(input: Parameters<typeof remove.run>[1], n: number) {
  const values = remove.params.map(key => key === 'items' ? JSON.stringify(input.items) : input[key as keyof typeof input]);
  return Object.freeze({ values: Object.freeze(values), ...memberRetentionSqlPlan(remove.sql, values, {
    // requested/selected materialization and scans, parent CAS and addressed member writes.
    examined: 8 * n + 2, points: 2 * n + 1, returned: n, rowBytes: memberBytes, candidates: n,
  }) });
}

export function memberRetentionReadPlan(input: Parameters<typeof read.run>[1]) {
  return memberRetentionPoint(read.sql, read.params.map(key => input[key as keyof typeof input]), 1,
    memberBytes + size({ deletedAt: timestamp, purgeAfter: timestamp, deletionRevision: '9223372036854775807' }));
}
export function memberRetentionRestorePlan(input: Parameters<typeof restore.run>[1]) {
  return memberRetentionPoint(restore.sql, restore.params.map(key => input[key as keyof typeof input]), 8);
}
export function memberRetentionPurgePlan(input: Parameters<typeof purge.run>[1]) {
  // Parent/member target probes, exact DELETE and public UPDATE alternatives and RETURNING.
  return memberRetentionPoint(purge.sql, purge.params.map(key => input[key as keyof typeof input]), 8, size({ purged: true }));
}
export function memberRetentionPartitionPlan(partitionNo: number) {
  return memberRetentionPoint(partition.sql, [partitionNo], 1, 1024);
}
export function consumeMemberRetention<T>(name: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  return runLibraryBoundedStep(`library.member-retention.${name}`, bound, dispatch);
}
export async function memberRetentionControl(client: Client, sql: string): Promise<void> {
  // Hold terminal control costs before useful work. Expiry cannot prevent the original client's rollback.
  if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') {
    const controls = sumBounds(...[sql, 'COMMIT', 'ROLLBACK'].map(text => memberRetentionSqlPlan(text, [], {
      examined: 0, points: 0, returned: 0, rowBytes: 0, candidates: 0,
    }).total));
    await consumeMemberRetention('control', controls, () => client.query(sql));
  } else {
    await client.query(sql);
  }
}

export function memberRetentionContinuationPlan(input: unknown, options: unknown) {
  return sumBounds(SELECTED_COST.enqueue, retentionCost({ bytes: size([input, options]) }));
}
/** The mounted adapter still owns encoding. Account for this sizing pass and its output encoding. */
export function serializeMemberRetention<T>(name: string, value: T): Promise<T> {
  return consumeMemberRetention(name, retentionCost({ bytes: 2 * size(value) }), async () => value);
}
