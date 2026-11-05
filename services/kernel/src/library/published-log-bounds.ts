import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { runLibraryBoundedStep } from './command-support.ts';
import read from './published-log-read.sql';
import lock from './published-log-lock.sql';
import page from './published-log-page.sql';
import due from './published-log-due.sql';
import insert from './published-log-insert.sql';
import remove from './published-log-delete.sql';
import restore from './published-log-restore.sql';
import purge from './published-log-purge.sql';

// These closed leaves execute on the original caller's client. They do not open a
// connection, acquire authority, or replace the enclosing command/source plan.
export type PublishedLogReadPlan = Readonly<{
  kind: 'published-log.read';
  input: Readonly<Parameters<typeof read.run>[1]>;
  total: Bound;
}>;
export type PublishedLogLockPlan = Readonly<{
  kind: 'published-log.lock';
  input: Readonly<Parameters<typeof lock.run>[1]>;
  total: Bound;
}>;
export type PublishedLogPagePlan = Readonly<{
  kind: 'published-log.page';
  input: Readonly<Parameters<typeof page.run>[1]>;
  total: Bound;
}>;
export type PublishedLogDuePlan = Readonly<{
  kind: 'published-log.due';
  input: Readonly<Parameters<typeof due.run>[1]>;
  total: Bound;
}>;
export type PublishedLogInsertPlan = Readonly<{
  kind: 'published-log.insert';
  input: Readonly<Parameters<typeof insert.run>[1]>;
  total: Bound;
}>;
export type PublishedLogDeletePlan = Readonly<{
  kind: 'published-log.delete';
  input: Readonly<Parameters<typeof remove.run>[1]>;
  total: Bound;
}>;
export type PublishedLogRestorePlan = Readonly<{
  kind: 'published-log.restore';
  input: Readonly<Parameters<typeof restore.run>[1]>;
  total: Bound;
}>;
export type PublishedLogPurgePlan = Readonly<{
  kind: 'published-log.purge';
  input: Readonly<Parameters<typeof purge.run>[1]>;
  total: Bound;
}>;

const bytes = (value: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: value,
    engineRequests: 0,
  });

// library.published_log schema: UUIDs are 36 ASCII characters, route is uint16,
// revision is a positive int32, state has the three literal values below, note is
// at most 1000 PostgreSQL characters. Six-byte JSON escaping bounds both control
// characters and four-byte supplementary Unicode in the native JSON encoding.
// PostgreSQL timestamp text reserves 64 characters including range/zone/BC suffix.
const uuid = 'f'.repeat(36);
const timestamp = '\u0000'.repeat(64);
const pageProjection = {
  route: 65535,
  id: uuid,
  accountId: uuid,
  sessionId: uuid,
  subjectId: uuid,
  sessionState: 'completed',
  startedAt: timestamp,
  completedAt: timestamp,
  note: '\u0000'.repeat(1000),
  publishedAt: timestamp,
  transactionId: uuid,
  sort_at: timestamp,
};
const readProjection = {
  ...pageProjection,
  revision: 2147483646,
  deleted: false,
  deletionId: uuid,
  deletedAt: timestamp,
  restoreUntil: timestamp,
};
const dueProjection = {
  route: 65535,
  logId: uuid,
  accountId: uuid,
  deletionId: uuid,
  revision: 2147483646,
  restoreUntil: timestamp,
};
// Include null as an alternative to each short scalar: false and the positive
// integers above already dominate null. State, UUID and timestamp strings do too.
const rowBytes = (projection: object) => Buffer.byteLength(JSON.stringify(projection)) + 1;

function leaf(
  sql: string,
  input: object,
  candidates: number,
  rows: number,
  seeks: number,
  projection: object,
  projections: number,
  statements = 1,
): Bound {
  return sumBounds(
    declareBound({
      candidateKeys: candidates,
      nativeRows: rows,
      identityMetadataRows: 0,
      emptySeeks: seeks,
      nativePoints: seeks,
      witnessKeys: 0,
      statements,
      bytes: 0,
      // These closed SQL leaves do not supply Search admission or execution evidence.
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(sql)),
    bytes(Buffer.byteLength(JSON.stringify(input))),
    repeatBound(bytes(rowBytes(projection)), projections),
    bytes(2),
  );
}

export function publishedLogReadPlan(input: Parameters<typeof read.run>[1]): PublishedLogReadPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.read',
    input: original,
    total: leaf(read.sql, original, 1, 1, 1, readProjection, 1),
  });
}
export function publishedLogLockPlan(input: Parameters<typeof lock.run>[1]): PublishedLogLockPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.lock',
    input: original,
    total: leaf(lock.sql, original, 1, 1, 1, { ...readProjection, expired: false }, 1),
  });
}
export function publishedLogPagePlan(input: Parameters<typeof page.run>[1]): PublishedLogPagePlan {
  const original = Object.freeze({ ...input });
  // The UNION ALL has two independently limited index ranges on next pages.
  // Count discarded candidates before the final sort/LIMIT and both candidate
  // projections plus the final returned projection, including the sentinel.
  const streams = input.has_cursor ? 2 : 1;
  const rows = repeatBound(bytes(1), input.limit).bytes;
  const examined = repeatBound(bytes(rows), streams).bytes;
  return Object.freeze({
    kind: 'published-log.page',
    input: original,
    total: leaf(
      page.sql,
      original,
      rows,
      examined,
      streams,
      pageProjection,
      sumBounds(bytes(examined), bytes(rows)).bytes,
    ),
  });
}
export function publishedLogDuePlan(input: Parameters<typeof due.run>[1]): PublishedLogDuePlan {
  const original = Object.freeze({ ...input });
  // published_log_due is partial on deleted AND restore_until IS NOT NULL.
  // Cutoff and the exact three-column keyset are index ranges, not postfilters.
  return Object.freeze({
    kind: 'published-log.due',
    input: original,
    total: leaf(due.sql, original, input.limit, input.limit, 1, dueProjection, input.limit),
  });
}

// A successful row mutation also fires the Library native-source fence. Insert
// advances one owner fence and one fact-source head. Delete and restore update
// both old/new native-source fence anchors and one visibility head. Exact purge
// advances the retained old-owner fence only; it does not change visibility.
function mutation(
  sql: string,
  input: object,
  projections: number,
  projection: object,
  candidateKeys: number,
  nativeRows: number,
  nativePoints: number,
  triggerStatements: number,
  emptySeeks: number,
): Bound {
  return sumBounds(
    declareBound({
      candidateKeys,
      nativeRows,
      identityMetadataRows: 0,
      emptySeeks,
      nativePoints,
      witnessKeys: 0,
      statements: 1 + triggerStatements,
      bytes: 0,
      engineRequests: 0,
    }),
    bytes(Buffer.byteLength(sql)),
    bytes(Buffer.byteLength(JSON.stringify(input))),
    repeatBound(bytes(rowBytes(projection)), projections),
    bytes(2),
  );
}

export function publishedLogInsertPlan(input: Parameters<typeof insert.run>[1]): PublishedLogInsertPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.insert',
    input: original,
    // Heap plus PK/account-page/owner entries; three trigger upserts include
    // the fact-head writer's own native-source fence trigger.
    total: mutation(insert.sql, original, 1, readProjection, 7, 10, 7, 3, 4),
  });
}
export function publishedLogDeletePlan(input: Parameters<typeof remove.run>[1]): PublishedLogDeletePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.delete',
    input: original,
    // Old/new row versions and index changes plus two direct fence writes, the
    // fact visibility head and its native-source fence trigger.
    total: mutation(remove.sql, original, 1, readProjection, 8, 14, 5, 4, 5),
  });
}
export function publishedLogRestorePlan(input: Parameters<typeof restore.run>[1]): PublishedLogRestorePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.restore',
    input: original,
    total: mutation(restore.sql, original, 1, readProjection, 8, 14, 5, 4, 5),
  });
}
export function publishedLogPurgePlan(input: Parameters<typeof purge.run>[1]): PublishedLogPurgePlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'published-log.purge',
    input: original,
    // Minimization removes the retained owner index and due entry; only the
    // old owner fence is advanced. The deleted visibility head is unchanged.
    total: mutation(purge.sql, original, 1, { purged: true }, 4, 6, 2, 1, 2),
  });
}

export const executePublishedLogRead = (client: Parameters<typeof read.run>[0], plan: PublishedLogReadPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => read.run(client, plan.input));
export const executePublishedLogLock = (client: Parameters<typeof lock.run>[0], plan: PublishedLogLockPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => lock.run(client, plan.input));
export const executePublishedLogPage = (client: Parameters<typeof page.run>[0], plan: PublishedLogPagePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => page.run(client, plan.input));
export const executePublishedLogDue = (client: Parameters<typeof due.run>[0], plan: PublishedLogDuePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => due.run(client, plan.input));
export const executePublishedLogInsert = (client: Parameters<typeof insert.run>[0], plan: PublishedLogInsertPlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => insert.run(client, plan.input));
export const executePublishedLogDelete = (client: Parameters<typeof remove.run>[0], plan: PublishedLogDeletePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => remove.run(client, plan.input));
export const executePublishedLogRestore = (client: Parameters<typeof restore.run>[0], plan: PublishedLogRestorePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => restore.run(client, plan.input));
export const executePublishedLogPurge = (client: Parameters<typeof purge.run>[0], plan: PublishedLogPurgePlan) =>
  runLibraryBoundedStep(plan.kind, plan.total, () => purge.run(client, plan.input));
