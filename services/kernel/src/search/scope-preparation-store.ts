import type { Pool } from 'pg';
import type { CollectionAliasProgress } from '../library/collection-source.ts';
import type { ScopeLeafResume } from './scope-execution.ts';
import type { NativeOrdinalKey } from '../library/collection-source-order.ts';
import type { NativeSourceFrontier, NativeSourceIdentity } from '../library/native-source-custody.ts';
import type { PublicFilterSourceDefinition } from '../semantic/public-filter-source-binding.ts';
import type { IdentityScopeObservation } from '../semantic/identity-scope-types.ts';
import { withConnection } from '../database/pool.ts';
import { enqueueWorkIntent, type WorkClient } from '../work/client.ts';
import type { ScopeOrderedDefinition } from './scope-ordered.ts';

export type ScopeOrdinalMembershipProgress = Readonly<{ row: NativeOrdinalKey; value: CollectionAliasProgress }>;

export const SCOPE_PREPARATION_WORKFLOW = 'search.scopePreparation';
export type ScopeCaptureDefinition = (
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
  return {
    async retain(scopeId: string, definition: ScopeCaptureDefinition): Promise<void> {
      const frontier: ScopeCaptureFrontier =
        definition.kind === 'library'
          ? { kind: 'library', value: null }
          : definition.kind === 'realm'
            ? { kind: 'realm', after: null, exhausted: false }
            : { kind: 'public', value: null };
      await pool.query(
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
    async retainRealm(scopeId: string, identity: string, realm: string): Promise<ScopePreparationRecord> {
      const definition: ScopeCaptureDefinition = { kind: 'realm', identity, realm };
      const frontier: ScopeCaptureFrontier = { kind: 'realm', after: null, exhausted: false };
      await pool.query(
        `INSERT INTO search.scope_preparation
        (partition_no,prefix,scope_id,definition,frontier,due_at,expires_at,state)
        VALUES (0,$1,$2,$3,$4,$5,$6,'ready') ON CONFLICT (partition_no,prefix,scope_id) DO NOTHING`,
        [prefix, scopeId, JSON.stringify(definition), JSON.stringify(frontier), Date.now(), Date.now() + 86400000],
      );
      const found = await pool.query<ScopePreparationRecord>(
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
    ): Promise<boolean> {
      if (record.definition.kind !== 'realm' || record.frontier.kind !== 'realm')
        throw new TypeError('Foreign retained Realm preparation');
      const identity = record.definition.identity;
      return withConnection(pool, async (client) => {
        await client.query('BEGIN');
        try {
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
          if (updated.rowCount !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
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
            if (saved.rowCount !== 1) {
              await client.query('ROLLBACK');
              return false;
            }
          }
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async read(scopeId: string): Promise<ScopePreparationRecord | null> {
      const result = await pool.query<ScopePreparationRecord>(
        `SELECT scope_id,definition,frontier,observation,
        revision::text,state,expires_at::text FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2`,
        [prefix, scopeId],
      );
      return result.rows[0] ?? null;
    },
    async claim(scopeId: string, revision: string, deadline: number): Promise<ScopePreparationRecord | null> {
      const result = await pool.query<ScopePreparationRecord>(
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
    ): Promise<void> {
      const retained: RetainedScopeObservation | null = observation
        ? { ...observation, committedRevision: observation.committedRevision.toString() }
        : null;
      await pool.query(
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
    async refreshObservation(record: ScopePreparationRecord, observation: IdentityScopeObservation): Promise<void> {
      const retained: RetainedScopeObservation = {
        ...observation,
        committedRevision: observation.committedRevision.toString(),
      };
      await pool.query(
        `UPDATE search.scope_preparation SET observation=$4,revision=revision+1,
        ordinal_frontier=NULL,ordinal_complete=false,leaf_progress=NULL,ordinal_membership_progress=NULL
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND revision=$3 AND state='ready'`,
        [prefix, record.scope_id, record.revision, JSON.stringify(retained)],
      );
    },
    async readLeafProgress(scopeId: string): Promise<ScopeLeafResume | null> {
      const result = await pool.query<{ leaf_progress: ScopeLeafResume | null }>(
        `SELECT leaf_progress FROM search.scope_preparation
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready'`,
        [prefix, scopeId],
      );
      return result.rows[0]?.leaf_progress ?? null;
    },
    async saveLeafProgress(scopeId: string, resume: ScopeLeafResume | null): Promise<void> {
      await pool.query(
        `UPDATE search.scope_preparation SET leaf_progress=$3
        WHERE partition_no=0 AND prefix=$1 AND scope_id=$2 AND state='ready'`,
        [prefix, scopeId, resume ? JSON.stringify(resume) : null],
      );
    },
    async ordinalState(
      scopeId: string,
      observation: IdentityScopeObservation,
    ): Promise<{
      frontier: NativeOrdinalKey | null;
      complete: boolean;
      membership: ScopeOrdinalMembershipProgress | null;
    }> {
      const result = await pool.query<{
        ordinal_frontier: NativeOrdinalKey | null;
        ordinal_complete: boolean;
        ordinal_membership_progress: ScopeOrdinalMembershipProgress | null;
      }>(
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
    ): Promise<void> {
      await pool.query(
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
    ): Promise<boolean> {
      return withConnection(pool, async (client) => {
        await client.query('BEGIN');
        try {
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
          if (updated.rowCount !== 1) {
            await client.query('ROLLBACK');
            return false;
          }
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
          await client.query('COMMIT');
          return true;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
    async ordinalPage(
      scopeId: string,
      cut: string,
      after: NativeOrdinalKey | null,
      limit: number,
    ): Promise<readonly Readonly<{ subject: string; after: NativeOrdinalKey }>[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) throw new RangeError('Invalid ordinal page');
      const result = await pool.query<{ subject: string; ordinal_key: string; member_id: string }>(
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
    async due(): Promise<void> {
      if (!work) return;
      await withConnection(pool, async (client) => {
        await client.query('BEGIN');
        try {
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
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    },
  };
}
