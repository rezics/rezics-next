import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { CollectionAliasProgress } from '../library/collection-source.ts';
import type { ScopeLeafResume } from './scope-execution.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import type { NativeSourceFrontier, NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { PublicFilterSourceDefinition } from '../semantic/index.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { withBoundedReadLifetime } from '../database/bounded-read-lifetime.ts';
import { deadlineFor } from '../request/deadline.ts';
import { ProblemError } from '../http/problem-error.ts';
import { enqueueWorkIntent, type WorkClient } from '../work/client.ts';
import {
  scopeOrderedNameKey,
  validateScopeOrderedHit,
  type ScopeOrderedDefinition,
  type ScopeOrderedPreparation,
} from './scope-ordered.ts';
import type { SearchHit } from './query.ts';
import { ScopeWork, zeroScopeWork } from './scope-work.ts';
import type { ConceptBrowseBinding, ConceptDescendantSelection } from './concept-browse.ts';
import orderedStateSql from './scope-ordered-state.sql';
import orderedSaveSql from './scope-ordered-save.sql';
import orderedPageSql from './scope-ordered-page.sql';
import orderedFirstSql from './scope-ordered-first.sql';

/** Explicit turns and ambient request work share the earlier deadline. */
export function scopePreparationDeadline(deadline = Date.now() + 30000): number {
  return Math.min(deadline, deadlineFor(30000));
}

/** No implicit transaction: callers may read or write, without spanning native owner calls. */
export function withScopePreparationConnection<T>(
  pool: Pool,
  deadline: number,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withBoundedReadLifetime(
    (bounded) =>
      withConnection(pool, async (client) => {
        try {
          return await bounded(client);
        } catch (error) {
          // The lifetime also ends callback work stalled between transaction statements.
          // Discard the physical client before release, including failed cleanup.
          discardConnection(client, error instanceof Error ? error : new Error('Scope preparation connection failed'));
          throw error;
        }
      }),
    discardConnection,
    scopePreparationDeadline(deadline),
    run,
    {
      deadlineError: () => new ProblemError('semantic_not_ready'),
      mapError: (error) => {
        if (
          error instanceof Error &&
          (error.message === 'Query read timeout' ||
            error.message === 'timeout exceeded when trying to connect' ||
            error.message === 'Connection terminated due to connection timeout' ||
            ('code' in error && (error.code === '57014' || error.code === '55P03')))
        )
          return new ProblemError('semantic_not_ready');
        return error;
      },
      isUncertainSettledQueryError: () => true,
    },
  );
}

/** A failed CAS rolls back its rows as well as its frontier; cleanup uses the same deadline. */
function withScopePreparationTransaction<T>(
  pool: Pool,
  deadline: number,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withScopePreparationConnection(pool, deadline, async (client) => {
    await client.query('BEGIN');
    try {
      const result = await run(client);
      await client.query(result === false ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Keep the original failure; the bounded lifetime retires uncertain cleanup.
      }
      throw error;
    }
  });
}

export type ScopeOrdinalMembershipProgress = Readonly<{ row: NativeOrdinalKey; value: CollectionAliasProgress }>;

export const SCOPE_PREPARATION_WORKFLOW = 'search.scopePreparation';
export type ScopeCaptureDefinition = (
  | Readonly<{ kind: 'concept'; selection: ConceptDescendantSelection; binding: ConceptBrowseBinding }>
  | Readonly<{ kind: 'library'; identity: NativeSourceIdentity }>
  | Readonly<{ kind: 'realm'; identity: string; realm: string }>
  | Readonly<{
      kind: 'public';
      definition: Omit<PublicFilterSourceDefinition, 'meaning'> & {
        meaning: Omit<PublicFilterSourceDefinition['meaning'], 'release'>;
      };
    }>
) &
  Readonly<{
    ordered?: ScopeOrderedDefinition;
    nativeOutput?: Readonly<{ nativeOrder: 'name' | 'collections'; pageSize: number }>;
  }>;
export type ScopeCaptureFrontier =
  | Readonly<{ kind: 'concept' }>
  | Readonly<{ kind: 'library'; value: NativeSourceFrontier | null }>
  | Readonly<{ kind: 'realm'; after: string | null; exhausted: boolean }>
  | Readonly<{ kind: 'public'; value: string | null }>;
export type RetainedScopeObservation = Omit<IdentityScopeObservation, 'committedRevision'> & {
  committedRevision: string;
};
export type ScopePreparationRecord = {
  scope_id: string;
  definition: ScopeCaptureDefinition;
  frontier: ScopeCaptureFrontier;
  observation: RetainedScopeObservation | null;
  revision: string;
  state: 'capture' | 'ready' | 'retained';
  expires_at: string;
};

/** Only native locators/frontiers; never Actor, Access, facts, allow lists or caller verdicts. */
export function createScopePreparationStore(pool: Pool, prefix: string, work?: WorkClient) {
  function query<Row extends QueryResultRow = QueryResultRow>(deadline: number, sql: string, values: unknown[]) {
    return withScopePreparationConnection(pool, deadline, (client) => client.query<Row>(sql, values));
  }
  // Keep maintenance cleanup in the same finite lifetime as due scheduling. These are
  // the existing eight-plan / 128-key cleanup windows, with no population-sized delete.
  async function cleanup(deadline: number) {
    await query(
      deadline,
      `UPDATE search.scope_preparation SET state='retained',revision=revision+1,lease_until=0
      WHERE (partition_no,prefix,scope_id) IN (
        SELECT partition_no,prefix,scope_id FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND definition->>'kind'='concept'
          AND state IN ('capture','ready') AND expires_at<=$2
        ORDER BY expires_at,scope_id LIMIT 8 FOR UPDATE SKIP LOCKED
      )`,
      [prefix, Date.now()],
    );
    await withScopePreparationTransaction(pool, deadline, async (client) => {
      const retired = await client.query<{ scope_id: string }>(
        `SELECT scope_id FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND definition->>'kind'='concept' AND state='retained'
          AND frontier->>'cleaned' IS DISTINCT FROM 'true'
        ORDER BY scope_id LIMIT 8 FOR UPDATE SKIP LOCKED`,
        [prefix],
      );
      for (const { scope_id } of retired.rows) {
        for (const [table, key] of [
          ['scope_preparation_concept_frontier', 'parent'],
          ['scope_preparation_concept_member', 'concept'],
        ] as const) {
          const keys = await client.query<{ key: string }>(
            `SELECT ${key} AS key FROM search.${table}
            WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 ORDER BY ${key} LIMIT 128 FOR UPDATE`,
            [prefix, scope_id],
          );
          for (const row of keys.rows)
            await client.query(
              `DELETE FROM search.${table} WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND ${key}=$3`,
              [prefix, scope_id, row.key],
            );
        }
        await client.query(
          `UPDATE search.scope_preparation SET frontier='{"kind":"concept","cleaned":true}'
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='retained'
            AND NOT EXISTS (SELECT 1 FROM search.scope_preparation_concept_frontier WHERE partition_no=0 AND prefix=$1 AND scope_id=$2)
            AND NOT EXISTS (SELECT 1 FROM search.scope_preparation_concept_member WHERE partition_no=0 AND prefix=$1 AND scope_id=$2)`,
          [prefix, scope_id],
        );
      }
    });
  }
  return {
    async retain(
      scopeId: string,
      definition: Exclude<ScopeCaptureDefinition, { kind: 'concept' }>,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      const frontier: ScopeCaptureFrontier =
        definition.kind === 'library'
          ? { kind: 'library', value: null }
          : definition.kind === 'realm'
            ? { kind: 'realm', after: null, exhausted: false }
            : { kind: 'public', value: null };
      await query(
        deadline,
        `INSERT INTO search.scope_preparation
        (partition_no,prefix,scope_id,definition,frontier,due_at,expires_at)
        VALUES (0,$1,$2,$3,$4,$5,$6) ON CONFLICT (partition_no,prefix,scope_id) DO UPDATE SET
        expires_at=GREATEST(search.scope_preparation.expires_at,EXCLUDED.expires_at),
        state=CASE WHEN search.scope_preparation.state='retained' THEN 'capture' ELSE search.scope_preparation.state END,
        due_at=CASE WHEN search.scope_preparation.state='retained' THEN EXCLUDED.due_at ELSE search.scope_preparation.due_at END,
        revision=search.scope_preparation.revision+CASE WHEN search.scope_preparation.state='retained' THEN 1 ELSE 0 END
        WHERE search.scope_preparation.definition=EXCLUDED.definition`,
        [prefix, scopeId, JSON.stringify(definition), JSON.stringify(frontier), Date.now(), Date.now() + 86400000],
      );
    },
    /** Retain one finite Content Realm input frontier without scheduling a public producer job. */
    async retainRealm(
      scopeId: string,
      identity: string,
      realm: string,
      deadline = scopePreparationDeadline(),
    ): Promise<ScopePreparationRecord> {
      const definition: ScopeCaptureDefinition = { kind: 'realm', identity, realm };
      const frontier: ScopeCaptureFrontier = { kind: 'realm', after: null, exhausted: false };
      await query(
        deadline,
        `INSERT INTO search.scope_preparation
        (partition_no,prefix,scope_id,definition,frontier,due_at,expires_at,state)
        VALUES (0,$1,$2,$3,$4,$5,$6,'ready') ON CONFLICT (partition_no,prefix,scope_id) DO NOTHING`,
        [prefix, scopeId, JSON.stringify(definition), JSON.stringify(frontier), Date.now(), Date.now() + 86400000],
      );
      const found = await query<ScopePreparationRecord>(
        deadline,
        `SELECT scope_id,definition,frontier,observation,
        revision::text,state,expires_at::text FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2`,
        [prefix, scopeId],
      );
      const record = found.rows[0] ?? null;
      if (
        !record ||
        record.definition.kind !== 'realm' ||
        record.definition.identity !== identity ||
        record.definition.realm !== realm ||
        record.state !== 'ready' ||
        record.frontier.kind !== 'realm'
      )
        throw new Error('Retained Realm preparation changed');
      return record;
    },
    /** CAS one opaque Content prefix and its canonical indexed-name rows atomically. */
    async advanceRealm(
      record: ScopePreparationRecord,
      frontier: Extract<ScopeCaptureFrontier, { kind: 'realm' }>,
      rows: readonly Readonly<{ subject: string; nameKey: Buffer; hit: Buffer }>[],
      deadline = scopePreparationDeadline(),
    ): Promise<boolean> {
      if (record.definition.kind !== 'realm' || record.frontier.kind !== 'realm')
        throw new TypeError('Foreign retained Realm preparation');
      const identity = record.definition.identity;
      return withScopePreparationTransaction(pool, deadline, async (client) => {
        const updated = await client.query(
          `UPDATE search.scope_preparation SET frontier=$4,revision=revision+1
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3::bigint
            AND definition=$5::jsonb AND frontier=$6::jsonb AND state='ready'
          RETURNING scope_id`,
          [
            prefix,
            record.scope_id,
            record.revision,
            JSON.stringify(frontier),
            JSON.stringify(record.definition),
            JSON.stringify(record.frontier),
          ],
        );
        if (updated.rowCount !== 1) return false;
        for (const row of rows) {
          const saved = await client.query(
            `INSERT INTO search.scope_preparation_ordered
              (partition_no,prefix,scope_id,subject,count_key,name_key,hit)
            VALUES (0,$1,$2,$3,0,$4,$5)
            ON CONFLICT (partition_no,prefix,scope_id,subject) DO UPDATE SET
              name_key=EXCLUDED.name_key,hit=EXCLUDED.hit
            WHERE search.scope_preparation_ordered.name_key=EXCLUDED.name_key
              AND search.scope_preparation_ordered.hit=EXCLUDED.hit
            RETURNING subject`,
            [prefix, identity, row.subject, row.nameKey, row.hit],
          );
          if (saved.rowCount !== 1) return false;
        }
        return true;
      });
    },
    async read(scopeId: string, deadline = scopePreparationDeadline()): Promise<ScopePreparationRecord | null> {
      const result = await query<ScopePreparationRecord>(
        deadline,
        `SELECT scope_id,definition,frontier,observation,
        revision::text,state,expires_at::text FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2`,
        [prefix, scopeId],
      );
      return result.rows[0] ?? null;
    },
    async claim(scopeId: string, revision: string, deadline: number): Promise<ScopePreparationRecord | null> {
      deadline = scopePreparationDeadline(deadline);
      const result = await query<ScopePreparationRecord>(
        deadline,
        `UPDATE search.scope_preparation
        SET lease_until=$5,revision=revision+1 WHERE partition_no=0 AND prefix=$1 AND scope_id=$2
        AND revision=$3 AND lease_until<=$4 AND state='capture'
        RETURNING scope_id,definition,frontier,observation,revision::text,state,expires_at::text`,
        [prefix, scopeId, revision, Date.now(), deadline],
      );
      return result.rows[0] ?? null;
    },
    async advance(
      record: ScopePreparationRecord,
      frontier: ScopeCaptureFrontier,
      observation: IdentityScopeObservation | null,
      delay: number,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      const retained: RetainedScopeObservation | null = observation
        ? { ...observation, committedRevision: observation.committedRevision.toString() }
        : null;
      await query(
        deadline,
        `UPDATE search.scope_preparation SET frontier=$4,observation=$5,
        state=$6,revision=revision+1,lease_until=0,due_at=$7
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3`,
        [
          prefix,
          record.scope_id,
          record.revision,
          JSON.stringify(frontier),
          retained ? JSON.stringify(retained) : null,
          observation ? 'ready' : Number(record.expires_at) <= Date.now() ? 'retained' : 'capture',
          Date.now() + delay,
        ],
      );
    },
    async refreshObservation(
      record: ScopePreparationRecord,
      observation: IdentityScopeObservation,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      const retained: RetainedScopeObservation = {
        ...observation,
        committedRevision: observation.committedRevision.toString(),
      };
      await query(
        deadline,
        `UPDATE search.scope_preparation SET observation=$4,revision=revision+1,
        ordinal_frontier=NULL,ordinal_complete=false,leaf_progress=NULL,ordinal_membership_progress=NULL
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3 AND state='ready'`,
        [prefix, record.scope_id, record.revision, JSON.stringify(retained)],
      );
    },
    async readLeafProgress(scopeId: string, deadline = scopePreparationDeadline()): Promise<ScopeLeafResume | null> {
      const result = await query<{ leaf_progress: ScopeLeafResume | null }>(
        deadline,
        `SELECT leaf_progress FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready'`,
        [prefix, scopeId],
      );
      return result.rows[0]?.leaf_progress ?? null;
    },
    async saveLeafProgress(
      scopeId: string,
      resume: ScopeLeafResume | null,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      await query(
        deadline,
        `UPDATE search.scope_preparation SET leaf_progress=$3
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready'`,
        [prefix, scopeId, resume ? JSON.stringify(resume) : null],
      );
    },
    async ordinalState(
      scopeId: string,
      observation: IdentityScopeObservation,
      deadline = scopePreparationDeadline(),
    ): Promise<{
      frontier: NativeOrdinalKey | null;
      complete: boolean;
      membership: ScopeOrdinalMembershipProgress | null;
    }> {
      const result = await query<{
        ordinal_frontier: NativeOrdinalKey | null;
        ordinal_complete: boolean;
        ordinal_membership_progress: ScopeOrdinalMembershipProgress | null;
      }>(
        deadline,
        `SELECT ordinal_frontier,ordinal_complete,ordinal_membership_progress FROM search.scope_preparation
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready' AND observation=$3::jsonb`,
        [
          prefix,
          scopeId,
          JSON.stringify({ ...observation, committedRevision: observation.committedRevision.toString() }),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Native scope preparation is not ready');
      return {
        frontier: row.ordinal_frontier,
        complete: row.ordinal_complete,
        membership: row.ordinal_membership_progress,
      };
    },
    async saveOrdinalMembership(
      scopeId: string,
      observation: IdentityScopeObservation,
      progress: ScopeOrdinalMembershipProgress | null,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      await query(
        deadline,
        `UPDATE search.scope_preparation SET ordinal_membership_progress=$4
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready' AND observation=$3::jsonb`,
        [
          prefix,
          scopeId,
          JSON.stringify({ ...observation, committedRevision: observation.committedRevision.toString() }),
          progress ? JSON.stringify(progress) : null,
        ],
      );
    },
    async advanceOrdinal(
      scopeId: string,
      cut: string,
      observation: IdentityScopeObservation,
      expected: NativeOrdinalKey | null,
      frontier: NativeOrdinalKey | null,
      complete: boolean,
      rows: readonly Readonly<{ subject: string; after: NativeOrdinalKey }>[],
      deadline = scopePreparationDeadline(),
    ): Promise<boolean> {
      return withScopePreparationTransaction(pool, deadline, async (client) => {
        const updated = await client.query(
          `UPDATE search.scope_preparation SET ordinal_frontier=$4,
          ordinal_complete=$5,ordinal_membership_progress=NULL WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready'
          AND ordinal_complete=false AND ordinal_frontier IS NOT DISTINCT FROM $3::jsonb
          AND observation=$6::jsonb RETURNING scope_id`,
          [
            prefix,
            scopeId,
            expected ? JSON.stringify(expected) : null,
            frontier ? JSON.stringify(frontier) : null,
            complete,
            JSON.stringify({ ...observation, committedRevision: observation.committedRevision.toString() }),
          ],
        );
        if (updated.rowCount !== 1) return false;
        // Rows are derived key locators only. Native facts, permissions and opaque evidence stay native.
        for (const row of rows)
          await client.query(
            `INSERT INTO search.scope_preparation_ordinal
            (partition_no,prefix,scope_id,cut,subject,ordinal_key,member_id) VALUES (0,$1,$2,$6,$3,$4,$5)
            ON CONFLICT (partition_no,prefix,scope_id,cut,subject) DO UPDATE SET
            ordinal_key=EXCLUDED.ordinal_key,member_id=EXCLUDED.member_id
            WHERE (EXCLUDED.ordinal_key,EXCLUDED.member_id)<
              (search.scope_preparation_ordinal.ordinal_key,search.scope_preparation_ordinal.member_id)`,
            [prefix, scopeId, row.subject, row.after.ordinalKey, row.after.memberId, cut],
          );
        return true;
      });
    },
    async ordinalPage(
      scopeId: string,
      cut: string,
      after: NativeOrdinalKey | null,
      limit: number,
      deadline = scopePreparationDeadline(),
    ): Promise<readonly Readonly<{ subject: string; after: NativeOrdinalKey }>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new RangeError('Invalid ordinal page');
      const result = await query<{ subject: string; ordinal_key: string; member_id: string }>(
        deadline,
        `SELECT subject,ordinal_key,member_id FROM search.scope_preparation_ordinal
          WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND cut=$6
          AND ($3::text IS NULL OR (ordinal_key,member_id)>($3,$4::uuid))
          ORDER BY ordinal_key,member_id LIMIT $5`,
        [prefix, scopeId, after?.ordinalKey ?? null, after?.memberId ?? null, limit, cut],
      );
      return result.rows.map((row) => ({
        subject: row.subject,
        after: { ordinalKey: row.ordinal_key, memberId: row.member_id },
      }));
    },
    async orderedState(
      scopeId: string,
      work: ScopeWork,
      deadline = scopePreparationDeadline(),
    ): Promise<ScopeOrderedPreparation> {
      work.consume({ ...zeroScopeWork(), statements: 1 });
      const row = await withScopePreparationConnection(pool, deadline, (client) =>
        orderedStateSql.run(client, { prefix, scope: scopeId }),
      );
      work.consume({
        ...zeroScopeWork(),
        nativeRows: row ? 1 : 0,
        bytes: Buffer.byteLength(JSON.stringify(row ?? null)),
      });
      return (row?.ordered_state as ScopeOrderedPreparation | null) ?? { queried: null, repair: null, execution: null };
    },
    async saveOrdered(
      record: ScopePreparationRecord,
      frontier: ScopeCaptureFrontier,
      state: ScopeOrderedPreparation,
      observation: IdentityScopeObservation | null,
      hits: readonly SearchHit[],
      work: ScopeWork,
      ready = false,
      deadline = scopePreparationDeadline(),
    ): Promise<void> {
      const order = record.definition.ordered;
      if (!order) throw new ProblemError('semantic_not_ready');
      for (const hit of hits) validateScopeOrderedHit(order.nativeOrder, hit, order.index);
      const values = {
        prefix,
        scope: record.scope_id,
        revision: record.revision,
        ordered_state: JSON.stringify(state),
        frontier: JSON.stringify(frontier),
        observation: observation
          ? JSON.stringify({ ...observation, committedRevision: String(observation.committedRevision) })
          : null,
        state: ready ? 'ready' : 'capture',
        due: String(Date.now()),
        subjects: hits.map((h) => h.id),
        counts: hits.map((h) => (order.nativeOrder === 'collections' ? -(h.sort[0] as number) : 0)),
        names: hits.map((h) => scopeOrderedNameKey(h.sort[h.sort.length - 2] as string | null)),
        hits: hits.map((h) => Buffer.from(JSON.stringify(h))),
      };
      work.consume({ ...zeroScopeWork(), statements: 1, bytes: Buffer.byteLength(JSON.stringify(values)) });
      const saved = await withScopePreparationConnection(pool, deadline, (client) => orderedSaveSql.run(client, values));
      work.consume({ ...zeroScopeWork(), nativeRows: 1 + hits.length });
      if (!saved) throw new ProblemError('semantic_not_ready');
    },
    async orderedPage(
      scopeId: string,
      order: 'name' | 'collections',
      after: readonly (string | number | null)[] | null,
      size: number,
      work: ScopeWork,
      deadline = scopePreparationDeadline(),
    ): Promise<SearchHit[]> {
      if (!Number.isSafeInteger(size) || size < 1 || size > 101) throw new RangeError('Invalid ordered Scope seek');
      work.consume({ ...zeroScopeWork(), statements: 1 });
      const rows = await withScopePreparationConnection(pool, deadline, (client) =>
        after
          ? orderedPageSql.run(client, {
              prefix,
              scope: scopeId,
              count_key: order === 'collections' ? -(after[0] as number) : 0,
              name_key: scopeOrderedNameKey(after[after.length - 2] as string | null),
              subject: after[after.length - 1] as string,
              size,
            })
          : orderedFirstSql.run(client, { prefix, scope: scopeId, size }),
      );
      work.consume({
        ...zeroScopeWork(),
        candidateKeys: rows.length,
        nativeRows: size,
        bytes: rows.reduce((n, row) => n + row.hit.length, 0),
      });
      return rows.map((row) => JSON.parse(Buffer.from(row.hit).toString('utf8')) as SearchHit);
    },
    async due(deadline = scopePreparationDeadline()): Promise<void> {
      if (!work) return;
      await cleanup(deadline);
      await withScopePreparationTransaction(pool, deadline, async (client) => {
        const rows = await client.query<{ scope_id: string; revision: string }>(
          `UPDATE search.scope_preparation
          SET revision=revision+1,due_at=$2+30000 WHERE (partition_no,prefix,scope_id) IN
          (SELECT partition_no,prefix,scope_id FROM search.scope_preparation WHERE partition_no=0 AND prefix=$1
          AND state='capture' AND due_at<=$2 AND lease_until<=$2 ORDER BY due_at,scope_id LIMIT 16
          FOR UPDATE SKIP LOCKED) RETURNING scope_id,revision::text`,
          [prefix, Date.now()],
        );
        for (const row of rows.rows)
          await enqueueWorkIntent(work, client, {
            queue: 'maintenance',
            workflowName: SCOPE_PREPARATION_WORKFLOW,
            workflowId: `${SCOPE_PREPARATION_WORKFLOW}:${prefix}:${row.scope_id}:${row.revision}`,
            input: { accounts: [], scopeId: row.scope_id, revision: row.revision },
          });
      });
    },
  };
}
