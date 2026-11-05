import { DBOS } from '@dbos-inc/dbos-sdk';
import { createHash } from 'node:crypto';
import { noEffect, runCommand } from '../command/command.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { requireAccessDeadline } from '../access/unavailable.ts';
import { ProblemError } from '../http/problem.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import { withReadTransaction } from '../access/read-transaction.ts';
import { authorizedContextMetadata } from './context-lifecycle-read.ts';
import { refreshSemanticErasureSourceRecord } from './account-erasure.ts';
import {
  readSemanticSourceDisposition,
  recordSemanticSourceDisposition,
  type SemanticCopyRole,
} from './erasure-producer.ts';
import type { WorkContext } from '../work/registry.ts';
import type { Effect } from '../events/effects.ts';
import { t } from 'elysia';
import type { Pool } from 'pg';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import prefixCandidates from './context-directory-prefix.sql';
import rawCandidates from './context-directory-raw.sql';

export const ContextDirectoryEntrySchema = t.Object(
  {
    id: t.String({ format: 'uuid' }),
    kind: t.Union([t.Literal('global'), t.Literal('community')]),
    labels: t.Record(t.String(), t.String()),
    state: t.Union([t.Literal('active'), t.Literal('deleted')]),
    deletedAt: t.Union([t.String(), t.Null()]),
    purgeAfter: t.Union([t.String(), t.Null()]),
  },
  { additionalProperties: false },
);
export type ContextDirectoryEntry = {
  id: string;
  kind: 'global' | 'community';
  labels: Record<string, string>;
  state: 'active' | 'deleted';
  deletedAt: string | null;
  purgeAfter: string | null;
};
export type ContextDirectoryPage = { contexts: ContextDirectoryEntry[]; next: string | null };
export type ContextDirectoryRead = { actor: Actor; deadline: number };
export type ContextDirectoryQuery = { query?: string; limit?: number; cursor?: string; deleted?: boolean };
export type ContextDirectory = {
  list(input: ContextDirectoryRead & ContextDirectoryQuery): Promise<ContextDirectoryPage>;
  lifecycle(input: ContextDirectoryRead & { id: string }): Promise<ContextDirectoryEntry | null>;
};
export class ContextDirectoryPreparingError extends Error {
  constructor() {
    super('Context directory is preparing');
  }
}
export function createContextDirectory(dependencies: {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: () => Date;
}): ContextDirectory {
  const clock = dependencies.clock ?? (() => new Date());
  return {
    async list(input) {
      const limit = input.limit ?? 20;
      const query = (input.query ?? '').normalize('NFC').toLowerCase();
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        Buffer.byteLength(query) > 256 ||
        Array.from(query).some(
          (char) => char === '\0' || (char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff),
        )
      )
        throw new ProblemError('invalid_request');
      const binding = {
        route: 'GET /v1/contexts',
        viewer: input.actor.kind === 'account' ? input.actor.accountId : null,
        query: {
          query,
          limit,
          deleted: input.deleted ?? false,
          meaning: 'native-label-prefix-v1',
          // Fixed-size binding preserves the native token limit even for accounts with many admitted scopes.
          authority:
            input.actor.kind === 'account'
              ? createHash('sha256')
                  .update(
                    JSON.stringify([
                      input.actor.clientId,
                      input.actor.authnEpoch,
                      [...input.actor.scopes].sort(),
                      input.actor.requestedBy,
                    ]),
                  )
                  .digest('hex')
              : null,
        },
      };
      const decoded = input.cursor ? await decodeListCursor(dependencies.tokens, binding, input.cursor, clock()) : null;
      if (
        decoded &&
        (!decoded.ok || decoded.after.length !== 3 || decoded.after.some((key) => typeof key !== 'string'))
      )
        throw new ProblemError('invalid_request');
      const after = decoded?.ok ? (decoded.after as string[]) : ['', '00000000-0000-0000-0000-000000000000', ''];
      const snapshot = await withReadTransaction(dependencies.pool, async (connection) => {
        const tx = deadlineClient(connection, input.deadline);
        const owner = await readPartition(tx, 0);
        if (!owner || owner.writeState !== 'active') throw new ContextDirectoryPreparingError();
        if (decoded?.ok && decoded.epoch !== owner.epoch) throw new ProblemError('invalid_request');
        const pending = await tx.query(
          `(SELECT 1 FROM semantic.context_directory_home WHERE NOT complete ORDER BY route LIMIT 1)
           UNION ALL (SELECT 1 FROM semantic.context_directory_entry WHERE route=0 AND refresh_pending ORDER BY context_id LIMIT 1)
           LIMIT 1`,
        );
        // All installed homes are seeded by migration. The partial index proves coverage without request enumeration.
        if (pending.rowCount) throw new ContextDirectoryPreparingError();
        const state = input.deleted ? 'deleted' : 'active';
        const rows = query
          ? await prefixCandidates.run(tx, {
              state,
              prefix: query,
              prefix_end: prefixEnd(query),
              after_key: after[0]!,
              after_id: after[1]!,
              after_language: after[2]!,
            })
          : await rawCandidates.run(tx, { state, after_id: after[1]! });
        return { rows, epoch: owner.epoch };
      });
      const authorized = await authorizedContextMetadata(dependencies, {
        ids: [...new Set(snapshot.rows.map((row) => row.id))],
        expected: new Map(snapshot.rows.map((row) => [row.id, { version: row.version, epoch: row.source_epoch }])),
        actor: input.actor,
        deadline: input.deadline,
      });
      const entries = new Map(authorized.map((entry) => [entry.id, entry]));
      const contexts: ContextDirectoryEntry[] = [];
      const emitted = new Set<string>();
      let consumed = 0;
      let bytes = 0;
      for (const candidate of snapshot.rows) {
        consumed++;
        const entry = entries.get(candidate.id);
        if (!entry || entry.state !== (input.deleted ? 'deleted' : 'active') || emitted.has(entry.id)) continue;
        // No stale matching private label is reflected in the response, even after a rename or minimization.
        const value =
          candidate.language === '@id' ? entry.id : candidate.language === '' ? '' : entry.labels[candidate.language];
        if (value === undefined || directoryKey(value) !== candidate.key) continue;
        if (query) {
          const matching = [['@id', entry.id], ...Object.entries(entry.labels)]
            .filter(([, value]) => value!.normalize('NFC').toLowerCase().startsWith(query))
            .sort(
              (a, b) =>
                Buffer.compare(Buffer.from(directoryKey(a[1]!)), Buffer.from(directoryKey(b[1]!))) ||
                Buffer.compare(Buffer.from(a[0]!), Buffer.from(b[0]!)),
            );
          if (matching[0]?.[0] !== candidate.language) continue;
        }
        const entryBytes = Buffer.byteLength(JSON.stringify(entry));
        // Reserve the existing confidential token envelope and response framing, then resume before this key.
        if (bytes + entryBytes > 60000) {
          if (!contexts.length) throw new ContextDirectoryPreparingError();
          consumed--;
          break;
        }
        contexts.push(entry);
        bytes += entryBytes;
        emitted.add(entry.id);
        if (contexts.length === limit) break;
      }
      const last = snapshot.rows[consumed - 1];
      const next =
        last && (consumed < snapshot.rows.length || snapshot.rows.length === 100)
          ? await encodeListCursor(
              dependencies.tokens,
              binding,
              { epoch: snapshot.epoch, after: [last.key, last.id, last.language] },
              clock(),
            )
          : null;
      await withReadTransaction(dependencies.pool, async (connection) => {
        const tx = deadlineClient(connection, input.deadline);
        const owner = await readPartition(tx, 0);
        if (!owner || owner.writeState !== 'active' || owner.epoch !== snapshot.epoch)
          throw new ContextDirectoryPreparingError();
        const pending = await tx.query(
          `(SELECT 1 FROM semantic.context_directory_home WHERE NOT complete ORDER BY route LIMIT 1)
           UNION ALL (SELECT 1 FROM semantic.context_directory_entry WHERE route=0 AND refresh_pending ORDER BY context_id LIMIT 1)
           LIMIT 1`,
        );
        if (pending.rowCount) throw new ContextDirectoryPreparingError();
      });
      if (Buffer.byteLength(JSON.stringify({ contexts, next })) > 65536) throw new ContextDirectoryPreparingError();
      requireAccessDeadline(input.deadline);
      return { contexts, next };
    },
    async lifecycle(input) {
      if (routeOf(input.id) === null) return null;
      return (await authorizedContextMetadata(dependencies, { ...input, ids: [input.id] }))[0] ?? null;
    },
  };
}

/** C-collation upper bound for the exact prefix; no extra matcher or query language. */
function prefixEnd(prefix: string): string {
  const points = Array.from(prefix, (char) => char.codePointAt(0)!);
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i]! < 0x10ffff)
      return String.fromCodePoint(...points.slice(0, i), points[i] === 0xd7ff ? 0xe000 : points[i]! + 1);
  }
  // Sixty-five maximum codepoints exceed every bounded 256-byte index key. Keep both SQL index bounds
  // unconditional even at Unicode's maximum, without a nullable-parameter OR or a rejected-label scan.
  return String.fromCodePoint(0x10ffff).repeat(65);
}

export const CONTEXT_DIRECTORY_CHANGED = 'com.rezics.semantic.context-directory.changed.v1';
type SourceContext = {
  route: number;
  id: string;
  kind: string;
  labels: Record<string, string>;
  state: string;
  version: string;
  erasure_key: string;
  roles: (SemanticCopyRole & { delivery_position: string })[];
  disposition: 'removed' | 'retained-nonpersonal' | null;
};

/** One retained native home step. Route/key order is indexed; raw100 includes keys with no eligible payload.
 * The native Source connection closes before the receiving Source command. No account/history completion is inferred.
 */
export async function stepContextDirectory(pool: Pool, home: number, clock?: () => Date): Promise<boolean> {
  if (!Number.isInteger(home) || home < 0 || home > 4095) throw new RangeError('Invalid Context directory home');
  const source = (
    await runCommand(pool, { partition: home, clock }, async (tx) => {
      const owner = await readPartition(tx, home);
      if (!owner || owner.writeState !== 'active') throw new ContextDirectoryPreparingError();
      const progress = (
        await tx.query<{ after_route: number; after_key: string; complete: boolean; source_epoch: number }>(
          'SELECT after_route,after_key::text,complete,source_epoch FROM semantic.context_directory_home WHERE route=$1 FOR UPDATE',
          [home * 16],
        )
      ).rows[0];
      if (!progress || progress.source_epoch !== owner.epoch) throw new ContextDirectoryPreparingError();
      let route = progress.complete ? home * 16 : progress.after_route;
      let key = progress.complete ? '0' : progress.after_key;
      let rows: SourceContext[] = [];
      // Sixteen fixed routes of this home; total raw rows is at most 100.
      for (; route < home * 16 + 16; route++, key = '0') {
        rows = (
          await tx.query<SourceContext>(
            `SELECT route,context_id::text AS id,kind,labels,state,security_revision::text AS version,erasure_key::text
         FROM semantic.context WHERE route=$1 AND erasure_key>$2
           ${progress.complete ? 'AND directory_pending' : ''} ORDER BY erasure_key LIMIT 1`,
            [route, key],
          )
        ).rows;
        if (rows.length) break;
      }
      for (const row of rows) {
        row.roles = (
          await tx.query<SourceContext['roles'][number]>(
            `SELECT account_id::text,role,delivery_position::text FROM semantic.erasure_locator
         WHERE partition_no=$1 AND store='context' AND record_key=$2 ORDER BY account_id,role LIMIT 101`,
            [home, row.erasure_key],
          )
        ).rows;
        if (row.roles.length > 100 || (row.kind !== 'global' && !row.roles.length))
          throw new ContextDirectoryPreparingError();
        row.disposition = await readSemanticSourceDisposition(tx, 'context', row.erasure_key);
      }
      return noEffect({
        rows,
        epoch: owner.epoch,
        complete: progress.complete,
        afterRoute: rows.length ? route : home * 16 + 16,
        afterKey: rows.at(-1)?.erasure_key ?? '0',
      });
    })
  ).value;
  if (source.complete && !source.rows.length) return true;
  // A bounded account-role capture is itself actual private Source data. Fence every role before receiving it.
  if (Buffer.byteLength(JSON.stringify(source.rows)) > 65536) throw new ContextDirectoryPreparingError();
  const fenced = await fencedDirectoryAccounts(
    pool,
    source.rows.flatMap((row) => row.roles),
  );
  for (const row of source.rows) {
    if (row.state === 'purged') continue;
    if (row.roles.some((role) => fenced.has(role.account_id))) {
      // Only the real native minimizer's exact current-row receipt can release former personal roles.
      if (row.disposition !== 'retained-nonpersonal') {
        const role = row.roles.find((role) => fenced.has(role.account_id))!;
        // A later surviving-owner write invalidates old xmin custody. Ask the existing exact-key native
        // minimizer to refresh its real sealed role; no history completion or nonpersonal classification is inferred.
        await refreshSemanticErasureSourceRecord(pool, role.account_id, home, {
          store: 'context',
          recordKey: row.erasure_key,
          role: role.role,
          deliveryPosition: role.delivery_position,
        });
        return false;
      }
      row.roles = row.roles.filter((role) => !fenced.has(role.account_id));
    }
  }
  await runCommand(pool, { partition: 0, clock }, async (tx, { transactionId }) => {
    for (const row of source.rows) {
      const old = (
        await tx.query<{ erasure_key: string }>(
          'SELECT erasure_key::text FROM semantic.context_directory_entry WHERE route=0 AND context_id=$1 ORDER BY language LIMIT 515',
          [row.id],
        )
      ).rows;
      if (old.length > 514) throw new ContextDirectoryPreparingError();
      // The registered deferred removal producer records each exact key in this native command's custody.
      await tx.query('DELETE FROM semantic.context_directory_entry WHERE route=0 AND erasure_key=ANY($1::bigint[])', [
        old.map((entry) => entry.erasure_key),
      ]);
      if (row.state === 'purged') continue;
      const local = await tx.query(
        'SELECT 1 FROM semantic.erasure_home WHERE partition_no=0 AND account_id=ANY($1::uuid[]) LIMIT 1',
        [row.roles.map((role) => role.account_id)],
      );
      if (local.rowCount) throw new ContextDirectoryPreparingError();
      const keys = [['', ''], ['@id', row.id], ...Object.entries(row.labels)];
      if (keys.length > 514) throw new ContextDirectoryPreparingError();
      await tx.query(
        `WITH inserted AS (
           INSERT INTO semantic.context_directory_entry(route,context_id,language,search_key,state,source_epoch,source_version,recorded_transaction_id)
           SELECT 0,$1,language,key,$4,$5,$6,$7 FROM unnest($2::text[],$3::text[]) AS keys(language,key)
           RETURNING erasure_key
         ) INSERT INTO semantic.erasure_copy_role(partition_no,store,record_key,transaction_id,account_id,role)
           SELECT 0,'context_directory_entry',erasure_key,$7,account_id,role FROM inserted
           CROSS JOIN unnest($8::uuid[],$9::text[]) AS roles(account_id,role) WHERE true ON CONFLICT DO NOTHING`,
        [
          row.id,
          keys.map(([language]) => language!),
          keys.map(([, value]) => directoryKey(value!)),
          row.state,
          source.epoch,
          row.version,
          transactionId,
          row.roles.map((role) => role.account_id),
          row.roles.map((role) => role.role),
        ],
      );
    }
    return { value: null, events: [{ type: CONTEXT_DIRECTORY_CHANGED, data: {} }] };
  });
  return (
    await runCommand(pool, { partition: home, clock }, async (tx) => {
      const owner = await readPartition(tx, home);
      if (!owner || owner.writeState !== 'active' || owner.epoch !== source.epoch)
        throw new ContextDirectoryPreparingError();
      for (const row of source.rows) {
        const disposition = await readSemanticSourceDisposition(tx, 'context', row.erasure_key);
        await tx.query(
          'UPDATE semantic.context SET directory_pending=false WHERE route=$1 AND context_id=$2 AND security_revision=$3',
          [row.route, row.id, row.version],
        );
        // Updating only the technical pending flag must carry forward an already proven native minimization.
        if (disposition === 'retained-nonpersonal')
          recordSemanticSourceDisposition(tx, 'context', row.erasure_key, disposition);
        // A concurrent newer Source write must remain preparing even if a different receiver already acknowledged it.
        await tx.query(
          'UPDATE semantic.context SET directory_pending=true WHERE route=$1 AND context_id=$2 AND security_revision<>$3',
          [row.route, row.id, row.version],
        );
      }
      let done = source.afterRoute === home * 16 + 16;
      let afterRoute = source.afterRoute;
      let afterKey = source.afterKey;
      if (done) {
        const pending = (
          await tx.query<{ route: number }>(
            `SELECT route FROM semantic.context WHERE route BETWEEN $1 AND $2 AND directory_pending ORDER BY route,erasure_key LIMIT 1`,
            [home * 16, home * 16 + 15],
          )
        ).rows[0];
        if (pending) {
          done = false;
          afterRoute = pending.route;
          afterKey = '0';
        }
      }
      if (!source.complete || !done)
        await tx.query(
          'UPDATE semantic.context_directory_home SET after_route=$2,after_key=$3,complete=$4 WHERE route=$1 AND source_epoch=$5',
          [home * 16, afterRoute, afterKey, done, source.epoch],
        );
      return { value: done, events: [{ type: CONTEXT_DIRECTORY_CHANGED, data: {} }] };
    })
  ).value;
}

/** Existing effect delivery bridges changes; retained maintenance frontiers populate old native Contexts. */
export function contextDirectoryEffect(pool: Pool, clock?: () => Date): Effect {
  return {
    name: 'semantic_context_directory',
    types: [
      'com.rezics.semantic.context.created.v1',
      'com.rezics.semantic.record.deleted.v1',
      'com.rezics.semantic.record.restored.v1',
    ],
    async run(event) {
      const data = event.data as { id?: string; kind?: string };
      if (typeof data?.id !== 'string' || (data.kind !== undefined && data.kind !== 'context')) return;
      const route = routeOf(data.id);
      if (route !== null) await stepContextDirectory(pool, partitionOf(route), clock);
    },
  };
}

export async function registerContextDirectoryWork(context: WorkContext) {
  const page = DBOS.registerStep(
    async () => {
      // The partial index returns the next unfinished home. It is technical native progress, never a user result.
      const home = await nextDirectoryHome(context.pool, context.clock);
      if (home === undefined) return true;
      await stepContextDirectory(context.pool, home, context.clock);
      return false;
    },
    { name: 'semantic.contextDirectory.page', retriesAllowed: true, maxAttempts: 3 },
  );
  DBOS.registerWorkflow(
    async () => {
      for (let step = 0; step < 100; step++) if (await page()) break;
    },
    { name: 'semantic.contextDirectory.prepare' },
  );
  await context.client.applySchedules([
    {
      scheduleName: 'semantic.contextDirectory.prepare',
      workflowName: 'semantic.contextDirectory.prepare',
      schedule: '* * * * *',
      queueName: 'maintenance',
      cronTimezone: 'UTC',
      automaticBackfill: false,
    },
  ]);
}

/** The index/cursor key is a bounded prefix, never a replacement label. Native matching uses the full value. */
function directoryKey(value: string): string {
  let result = '';
  for (const char of value.normalize('NFC').toLowerCase()) {
    if (Buffer.byteLength(result + char) > 256) break;
    result += char;
  }
  return result;
}

async function fencedDirectoryAccounts(pool: Pool, roles: readonly SemanticCopyRole[]): Promise<Set<string>> {
  const groups = new Map<number, string[]>();
  for (const id of new Set(roles.map((role) => role.account_id))) {
    const home = partitionOf(routeOf(id)!);
    groups.set(home, [...(groups.get(home) ?? []), id]);
  }
  const fenced = new Set<string>();
  for (const [home, ids] of groups) {
    const found = await withReadTransaction(pool, async (tx) => {
      const owner = await readPartition(tx, home);
      if (!owner || owner.writeState !== 'active') throw new ContextDirectoryPreparingError();
      return (
        await tx.query<{ id: string }>(
          `SELECT account_id::text AS id FROM access.account
         WHERE (route,account_id) IN (SELECT * FROM unnest($1::int[],$2::uuid[]))
           AND state<>'deleted' AND NOT authn_fenced`,
          [ids.map((id) => routeOf(id)!), ids],
        )
      ).rows;
    });
    const live = new Set(found.map((row) => row.id));
    for (const id of ids) if (!live.has(id)) fenced.add(id);
  }
  return fenced;
}

export async function populateContextDirectory(pool: Pool, clock?: () => Date, steps = 100) {
  for (let step = 0; step < steps; step++) {
    const home = await nextDirectoryHome(pool, clock);
    if (home === undefined) return;
    try {
      await stepContextDirectory(pool, home, clock);
    } catch (error) {
      if (error instanceof ContextDirectoryPreparingError) return;
      throw error;
    }
  }
}

async function nextDirectoryHome(pool: Pool, clock?: () => Date): Promise<number | undefined> {
  const repair = (
    await pool.query<{ id: string }>(
      'SELECT context_id::text AS id FROM semantic.context_directory_entry WHERE route=0 AND refresh_pending ORDER BY context_id LIMIT 1',
    )
  ).rows[0];
  if (repair) {
    const route = routeOf(repair.id)!;
    const home = partitionOf(route);
    await runCommand(pool, { partition: home, clock }, async (tx) => {
      const native = (
        await tx.query<{ erasure_key: string }>(
          'SELECT erasure_key::text FROM semantic.context WHERE route=$1 AND context_id=$2',
          [route, repair.id],
        )
      ).rows[0];
      if (!native) throw new ContextDirectoryPreparingError();
      const disposition = await readSemanticSourceDisposition(tx, 'context', native.erasure_key);
      await tx.query('UPDATE semantic.context SET directory_pending=true WHERE route=$1 AND context_id=$2', [
        route,
        repair.id,
      ]);
      if (disposition === 'retained-nonpersonal')
        recordSemanticSourceDisposition(tx, 'context', native.erasure_key, disposition);
      return { value: null, events: [{ type: CONTEXT_DIRECTORY_CHANGED, data: {} }] };
    });
    return home;
  }
  return (
    await pool.query<{ partition_no: number }>(
      'SELECT partition_no FROM semantic.context_directory_home WHERE NOT complete ORDER BY route LIMIT 1',
    )
  ).rows[0]?.partition_no;
}
