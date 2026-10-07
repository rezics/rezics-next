import { setTimeout, clearTimeout } from 'node:timers';
import type { Pool } from 'pg';
import { readCompositionHeader } from '../structure/graph.ts';
import { structureObjects } from '../structure/change.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { readProgressOrder } from './order.ts';

interface Scope { principal_issuer: string; principal_subject: string; structure: string }
interface IndexState { order_revision: string | null; ready: boolean; invalidations: string;
  reindex_cursor: { occurrence?: string; selection?: string } | null; reindex_invalidations: string | null }
export const PROGRESS_ORDER_PROJECTION_COST = { rows: 2, pages: 256, bytes: 16 * 1024 * 1024 } as const;

/** Background recovery owns bounded pages; user reads only the completed index.
 * A scope-prefix seek skips each reader's entire occurrence inventory. */
export class ProgressOrderProjection {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private after: Scope | undefined;
  private pending: Scope | undefined;
  private readonly requested: Scope[] = [];
  constructor(private readonly pool: Pool, private readonly env: WorkActivationEnvironment) {}
  start() {
    const tick = async () => {
      if (this.stopped || this.pool.ending || this.pool.ended) return;
      try { await this.step(); }
      catch { this.pending = undefined; } // A refused basis stays unavailable and retries on the next scope cycle.
      if (!this.stopped && !this.pool.ending && !this.pool.ended) {
        this.timer = setTimeout(() => { void tick(); }, 100);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => { void tick(); }, 100);
    this.timer.unref();
  }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); }
  request(principal: { issuer: string; subject: string }, structure: string) {
    const scope = { principal_issuer: principal.issuer, principal_subject: principal.subject, structure };
    const same = (other: Scope) => other.principal_issuer === scope.principal_issuer
      && other.principal_subject === scope.principal_subject && other.structure === structure;
    if (this.requested.length < 64 && !(this.pending && same(this.pending)) && !this.requested.some(same)) {
      this.requested.push(scope);
    }
  }

  async step(): Promise<void> {
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    this.pending ??= this.requested.shift();
    if (!this.pending) {
      const value = await this.pool.query<Scope>(`SELECT principal_issuer, principal_subject, structure
        FROM structure.progress ${this.after ? 'WHERE (principal_issuer,principal_subject,structure)>($1,$2,$3)' : ''}
        ORDER BY principal_issuer,principal_subject,structure,occurrence,selection_key LIMIT 1`,
      this.after ? [this.after.principal_issuer, this.after.principal_subject, this.after.structure] : []);
      const scope = value.rows[0];
      if (!scope) { this.after = undefined; return; }
      this.after = scope;
      this.pending = scope;
    }
    const scope = this.pending;
    const header = await readCompositionHeader(this.env, scope.structure);
    if (!header) { this.pending = undefined; return; }
    const identity = [scope.principal_issuer, scope.principal_subject, scope.structure];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='5s'");
      await client.query(`INSERT INTO structure.progress_reader VALUES ($1,$2,1)
        ON CONFLICT (principal_issuer,principal_subject) DO UPDATE SET version=structure.progress_reader.version`, identity.slice(0, 2));
      await client.query(`INSERT INTO structure.progress_scope
        (principal_issuer,principal_subject,structure,order_revision,ready,version)
        VALUES ($1,$2,$3,$4,false,1) ON CONFLICT DO NOTHING`, [...identity, header.head]);
      let state = (await client.query<IndexState>(`SELECT order_revision,ready,invalidations::text,
        reindex_cursor,reindex_invalidations::text FROM structure.progress_scope
        WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3 FOR UPDATE`, identity)).rows[0]!;
      if (state.ready && state.order_revision === header.head) {
        await client.query('COMMIT'); this.pending = undefined; return;
      }
      if (state.order_revision !== header.head || !state.reindex_cursor
        || state.invalidations !== state.reindex_invalidations) {
        await client.query(`UPDATE structure.progress_scope SET order_revision=$4,ready=false,
          reindex_cursor='{}',reindex_invalidations=invalidations
          WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3`, [...identity, header.head]);
        state = { ...state, order_revision: header.head, reindex_cursor: {}, reindex_invalidations: state.invalidations };
      }
      const cursor = state.reindex_cursor!;
      // Eligibility is derived from the current immutable Structure, never a
      // recovery filter. Limit the raw PK range before testing completion so
      // sparse histories and former extras both advance in bounded steps.
      const rows = (await client.query<{ occurrence: string; selection_key: string; completed: boolean }>(`SELECT occurrence,selection_key,completed
        FROM structure.progress WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3
          ${cursor.occurrence ? 'AND (occurrence,selection_key)>($4,$5)' : ''}
        ORDER BY occurrence,selection_key LIMIT ${PROGRESS_ORDER_PROJECTION_COST.rows + 1}`,
      [...identity, ...(cursor.occurrence ? [cursor.occurrence, cursor.selection ?? ''] : [])])).rows;
      const cache = new Map<string, Uint8Array>(), source = structureObjects(this.env);
      let bytes = 0;
      const objects: ImmutableObjects = { put: source.put.bind(source), get: async digest => {
        const existing = cache.get(digest); if (existing) return existing;
        if (cache.size >= PROGRESS_ORDER_PROJECTION_COST.pages) throw new Error('Progress order page budget exceeded');
        const value = await source.get(digest); bytes += value.length;
        if (bytes > PROGRESS_ORDER_PROJECTION_COST.bytes) throw new Error('Progress order byte budget exceeded');
        cache.set(digest, value); return value;
      } };
      const environment = Object.assign(Object.create(this.env) as WorkActivationEnvironment, { structureObjects: objects });
      const page = rows.slice(0, PROGRESS_ORDER_PROJECTION_COST.rows);
      for (const row of page) {
        if (!row.completed) continue;
        const order = await readProgressOrder(environment, header, row.occurrence);
        await client.query(`UPDATE structure.progress SET order_revision=$6,order_key=$7,resume_eligible=$8
          WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3 AND occurrence=$4 AND selection_key=$5`,
        [...identity, row.occurrence, row.selection_key, order?.revision ?? null, order?.key ?? null, order?.eligible ?? false]);
      }
      if ((await readCompositionHeader(this.env, scope.structure))?.head !== header.head) throw new Error('Progress order basis changed');
      await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
      const last = page.at(-1);
      const more = rows.length > PROGRESS_ORDER_PROJECTION_COST.rows;
      await client.query(`UPDATE structure.progress_scope SET
        ready=(NOT $4) AND (invalidations=reindex_invalidations),
        reindex_cursor=CASE WHEN $4 THEN $5::jsonb ELSE NULL END
        WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3`,
      [...identity, more, JSON.stringify(last ? { occurrence: last.occurrence, selection: last.selection_key } : {})]);
      await client.query('COMMIT');
      if (!more) this.pending = undefined;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}
