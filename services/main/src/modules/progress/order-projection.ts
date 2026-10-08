import { setTimeout, clearTimeout } from 'node:timers';
import type { Pool, PoolClient } from 'pg';
import { runWorkerTick } from '../../worker-tick.ts';
import { readCompositionHeader, type CompositionHeader } from '../structure/graph.ts';
import { structureObjects } from '../structure/change.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { memberAnchors, memberEnclosure, readResumeOrder, type MemberEnclosure } from '../reading-position/continuity.ts';
import { readIndexedProgressOrder } from './order.ts';
import { applyAnchors, type MemberAnchor } from './anchors.ts';

type AnchorCursor = { occurrence?: string; selection?: string };
interface AnchorScope { parent: string; revision: string | null; parent_revision: string | null; cursor: AnchorCursor | null }

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
      try { await runWorkerTick('main.progress-order.projection', () => this.step()); }
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
        // Ordered, so the earlier completions are next to be indexed on the
        // enclosing Structure. The scope stays pending until that is done.
        const prepared = await this.prepareAnchors(client, identity, header);
        await client.query('COMMIT');
        if (prepared) this.pending = undefined;
        return;
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
      const environment = this.boundedEnvironment();
      const page = rows.slice(0, PROGRESS_ORDER_PROJECTION_COST.rows);
      for (const row of page) {
        if (!row.completed) continue;
        const order = await readResumeOrder(environment, header, row.occurrence);
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
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  /** One page budget per step. Every immutable object a step reads is counted. */
  private boundedEnvironment(): WorkActivationEnvironment {
    const cache = new Map<string, Uint8Array>(), source = structureObjects(this.env);
    let bytes = 0;
    const objects: ImmutableObjects = { put: source.put.bind(source), get: async digest => {
      const existing = cache.get(digest); if (existing) return existing;
      if (cache.size >= PROGRESS_ORDER_PROJECTION_COST.pages) throw new Error('Progress order page budget exceeded');
      const value = await source.get(digest); bytes += value.length;
      if (bytes > PROGRESS_ORDER_PROJECTION_COST.bytes) throw new Error('Progress order byte budget exceeded');
      cache.set(digest, value); return value;
    } };
    return Object.assign(Object.create(this.env) as WorkActivationEnvironment, { structureObjects: objects });
  }

  /** Bring this Structure's anchors on each enclosing composition up to date,
   * one composition and one page per step. Earlier completions made before
   * the Work was attached, or before anchors existed, have no row there; a
   * changed head on either side leaves the existing ones keyed by an order
   * that no longer holds; a composition that lost the Work still holds rows
   * that must be withdrawn. Each (member, composition) pair records the heads
   * it prepared for and a cursor, so this resumes after a stop and restarts
   * when either head moves. Returns true once every pair is current. */
  private async prepareAnchors(client: PoolClient, identity: string[], header: CompositionHeader): Promise<boolean> {
    const enclosure = await memberEnclosure(this.env, header);
    const parents = enclosure.compositions.map(composition => composition.header.structure);
    const saved = new Map((await client.query<AnchorScope>(`SELECT parent,revision,parent_revision,cursor
      FROM structure.progress_anchor_scope WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3
        AND parent = ANY($4::text[])`, [...identity, parents])).rows.map(row => [row.parent, row]));
    const stale = (composition: MemberEnclosure['compositions'][number]) => {
      const row = saved.get(composition.header.structure);
      return !row || row.revision !== header.head || row.parent_revision !== composition.header.head || row.cursor !== null;
    };
    const target = enclosure.compositions.find(stale);
    if (target) {
      await this.anchorPage(client, identity, header, enclosure, target.header.structure, saved.get(target.header.structure),
        { revision: header.head, parentRevision: target.header.head }, false);
      return false;
    }
    // A composition that no longer holds the Work: withdraw what it indexed.
    const removed = (await client.query<AnchorScope>(`SELECT parent,revision,parent_revision,cursor
      FROM structure.progress_anchor_scope WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3
        AND parent <> '' AND parent <> ALL($4::text[]) ORDER BY parent LIMIT 1`, [...identity, parents])).rows[0];
    if (removed) {
      await this.anchorPage(client, identity, header, enclosure, removed.parent, removed, undefined, true);
      return false;
    }
    await this.reconcileOverflow(client, identity, enclosure);
    return true;
  }

  /** The overflow mark is present while the member is enclosed by more
   * compositions than it keeps anchors for and the reader has progress in it. */
  private async reconcileOverflow(client: PoolClient, identity: string[], enclosure: MemberEnclosure) {
    if (enclosure.overflow) {
      await client.query(`INSERT INTO structure.progress_anchor_scope (principal_issuer,principal_subject,structure,parent)
        SELECT $1,$2,$3,'' WHERE EXISTS (SELECT 1 FROM structure.progress WHERE principal_issuer=$1
          AND principal_subject=$2 AND structure=$3 AND completed LIMIT 1) ON CONFLICT DO NOTHING`, identity);
      return;
    }
    await client.query(`DELETE FROM structure.progress_anchor_scope
      WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3 AND parent=''`, identity);
  }

  /** One page of this member's rows, indexed on (or withdrawn from) one composition. */
  private async anchorPage(client: PoolClient, identity: string[], header: CompositionHeader, enclosure: MemberEnclosure,
    parent: string, saved: AnchorScope | undefined, basis: { revision: string; parentRevision: string } | undefined,
    withdraw: boolean): Promise<void> {
    const current = !!saved && saved.cursor !== null && (withdraw ? saved.revision === null
      : saved.revision === basis!.revision && saved.parent_revision === basis!.parentRevision);
    const cursor = current ? saved!.cursor! : {};
    if (!current) {
      await client.query(`INSERT INTO structure.progress_anchor_scope
        (principal_issuer,principal_subject,structure,parent,revision,parent_revision,cursor)
        VALUES ($1,$2,$3,$4,$5,$6,'{}'::jsonb)
        ON CONFLICT (principal_issuer,principal_subject,structure,parent)
        DO UPDATE SET revision=EXCLUDED.revision,parent_revision=EXCLUDED.parent_revision,cursor=EXCLUDED.cursor`,
      [...identity, parent, basis?.revision ?? null, basis?.parentRevision ?? null]);
    }
    const rows = (await client.query<{ occurrence: string; selection_key: string; completed: boolean }>(
      `SELECT occurrence,selection_key,completed FROM structure.progress
        WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3
          ${cursor.occurrence ? 'AND (occurrence,selection_key)>($4,$5)' : ''}
        ORDER BY occurrence,selection_key LIMIT ${PROGRESS_ORDER_PROJECTION_COST.rows + 1}`,
      [...identity, ...(cursor.occurrence ? [cursor.occurrence, cursor.selection ?? ''] : [])])).rows;
    const environment = this.boundedEnvironment();
    const page = rows.slice(0, PROGRESS_ORDER_PROJECTION_COST.rows);
    for (const row of page) {
      let anchors: MemberAnchor[];
      if (withdraw) anchors = [{ structure: parent, through: identity[2]!, order: null }];
      else {
        const local = row.completed ? await readIndexedProgressOrder(environment, header, row.occurrence) : undefined;
        // Another Structure's own anchor, not a completion placed here.
        if (local === null) continue;
        anchors = await memberAnchors(environment, header, enclosure, local);
      }
      await applyAnchors(client, { issuer: identity[0]!, subject: identity[1]! }, identity[2]!,
        row.occurrence, row.selection_key, row.completed, anchors, parent);
    }
    // Every head must be the one this page was derived from when it commits.
    // A withdrawal derives nothing from them.
    for (const [structure, head] of withdraw ? [] : [[identity[2]!, header.head],
      ...enclosure.compositions.map(composition => [composition.header.structure, composition.header.head] as const)]) {
      if ((await readCompositionHeader(this.env, structure))?.head !== head) throw new Error('Progress anchor basis changed');
    }
    await assertGraphAdmissionOpen(this.env.fuseki, this.env.lineage);
    const last = page.at(-1), more = rows.length > PROGRESS_ORDER_PROJECTION_COST.rows;
    const next = more && last ? JSON.stringify({ occurrence: last.occurrence, selection: last.selection_key }) : null;
    if (withdraw && !next) {
      await client.query(`DELETE FROM structure.progress_anchor_scope
        WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3 AND parent=$4`, [...identity, parent]);
      return;
    }
    await client.query(`UPDATE structure.progress_anchor_scope SET cursor=$5::jsonb
      WHERE principal_issuer=$1 AND principal_subject=$2 AND structure=$3 AND parent=$4`, [...identity, parent, next]);
  }
}
