import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { settledContentPosition } from '../content-sequence.ts';
import type { MemberAnchoring } from './anchors.ts';
import type { ProgressOrder } from './order.ts';
import { PROJECTION_KEY_PREFIX, StaleStructureProgress, type ProgressWrite, type StructureProgressStore } from './store.ts';

/** Where the owner's completed-progress record for one target goes: the exact
 * Structure and occurrence plus the ancestor keys the order index takes. */
export interface CompletionPlan {
  structure: string;
  occurrence: string;
  order?: ProgressOrder;
  anchoring?: MemberAnchoring;
}

/** Graph resolution of source targets. `null` is a target this reader's record
 * cannot hold: missing, removed, unreadable or in no composition. The caller
 * cannot tell which, so nothing about the target is revealed. */
export interface CompletionPlanner {
  occurrence(occurrence: string): Promise<CompletionPlan | null>;
  /** The last placement of a finished Work, one reverse seek per level. */
  lastOf(work: string): Promise<CompletionPlan | null>;
}

/** What a source asks of the reader's record right now. */
export interface CompletionDemand { occurrences: string[]; lastOfWorks: string[] }
export interface CompletionSource {
  principal: VerifiedPrincipal;
  /** Stable identity of whatever records the finish, e.g. `session:<id>`. */
  source: string;
  /** Read inside the projection transaction, after its locks: the answer is
   * the source's committed state, whatever order concurrent commands ran in. */
  demand: (client: PoolClient) => Promise<CompletionDemand>;
}

const RETRIES = 3;
const digest = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
const targetKey = (plan: { structure: string; occurrence: string }) => `${plan.structure} ${plan.occurrence}`;

/** Ledger layout of a receipt key: prefix, source hash, target hash, kind, version. */
const SOURCE_AT = PROJECTION_KEY_PREFIX.length + 1;
const KIND_AT = SOURCE_AT + 48;

/** Projects the finish a Session or Library status records into the owner's
 * completed-progress record, so the one indexed resume range still answers
 * "how far has this reader read" without walking the series.
 *
 * The ledger is the progress receipt table itself: every projected write
 * carries a key `projection:<source><target><h|r><version>`, an `h`old or a
 * `r`elease, so a hold is "the newest receipt of this pair is a hold" and
 * needs no extra schema. A completion the reader recorded directly is any
 * receipt without the prefix; it outlives every hold made before it and is
 * never undone here. Each reconcile touches its sources' targets only: a
 * constant number of statements, whatever the length of the series. */
export class ProgressCompletionProjector {
  constructor(private readonly progress: StructureProgressStore, private readonly pool: Pool,
    private readonly planner: CompletionPlanner) {}

  async reconcile(input: CompletionSource): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try { return await this.reconcileOnce(input); }
      catch (error) { if (!(error instanceof StaleStructureProgress) || attempt >= RETRIES) throw error; }
    }
  }

  private async plan(demand: CompletionDemand) {
    const plans = new Map<string, CompletionPlan>();
    for (const occurrence of demand.occurrences) {
      const plan = await this.planner.occurrence(occurrence);
      if (plan) plans.set(targetKey(plan), plan);
    }
    for (const work of demand.lastOfWorks) {
      const plan = await this.planner.lastOf(work);
      if (plan) plans.set(targetKey(plan), plan);
    }
    return plans;
  }

  private async reconcileOnce(input: CompletionSource) {
    const { principal } = input;
    const sourceHash = digest(input.source);
    const operations: string[] = [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN; SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '5s'");
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify(['progress-completion-source', principal.issuer, principal.subject, sourceHash])]);
      const plans = await this.plan(await input.demand(client));
      const held = await this.heldBy(client, principal, sourceHash);
      // One order for every lock, so two sources over the same targets queue
      // instead of deadlocking.
      const involved = [...new Set([...plans.keys(), ...held.map(targetKey)])].sort();
      for (const key of involved) {
        const [structure, occurrence] = key.split(' ') as [string, string];
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [JSON.stringify(['structure-progress-chapter', principal.issuer, principal.subject, structure, occurrence])]);
      }
      // A release replans nothing it does not need: the occurrence may be gone.
      for (const target of held) {
        if (plans.has(targetKey(target))) continue;
        const operation = await this.release(client, principal, sourceHash, target,
          await this.planner.occurrence(target.occurrence));
        if (operation) operations.push(operation);
      }
      for (const plan of [...plans.values()].sort((a, b) => targetKey(a) < targetKey(b) ? -1 : 1)) {
        const operation = await this.hold(client, principal, sourceHash, plan);
        if (operation) operations.push(operation);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new StaleStructureProgress('progress changed concurrently');
      }
      throw error;
    } finally { client.release(); }
    for (const operation of operations) await settledContentPosition(this.pool, operation);
  }

  /** Targets this source holds: the newest receipt of each pair is a hold that
   * no direct write has superseded. One range over the source's key prefix;
   * its keys are lowercase hex then `h`/`r` and digits, all below `z`. */
  private async heldBy(client: PoolClient, principal: VerifiedPrincipal, sourceHash: string) {
    const prefix = `${PROJECTION_KEY_PREFIX}${sourceHash}`;
    const rows = await client.query<{ structure: string; occurrence: string }>(`
      SELECT structure, occurrence FROM (
        SELECT DISTINCT ON (structure, occurrence) structure, occurrence, idempotency_key, created_at
        FROM structure.progress_command
        WHERE principal_issuer = $1 AND principal_subject = $2
          AND idempotency_key >= $3 AND idempotency_key < $4 AND starts_with(idempotency_key, $3)
        ORDER BY structure, occurrence, created_at DESC, result_version DESC) latest
      WHERE substr(idempotency_key, ${KIND_AT}, 1) = 'h'
        AND created_at > coalesce((SELECT max(c.created_at) FROM structure.progress_command c
          WHERE c.principal_issuer = $1 AND c.principal_subject = $2
            AND c.structure = latest.structure AND c.occurrence = latest.occurrence
            AND NOT starts_with(c.idempotency_key, $5)), '-infinity')
      LIMIT 17`,
    [principal.issuer, principal.subject, prefix, `${prefix}z`, PROJECTION_KEY_PREFIX]);
    return rows.rows;
  }

  /** Every source that currently holds this target, from receipts on that one
   * occurrence alone. */
  private async holders(client: PoolClient, principal: VerifiedPrincipal, target: { structure: string; occurrence: string }) {
    const rows = await client.query<{ source: string }>(`
      SELECT substr(idempotency_key, ${SOURCE_AT}, 24) AS source FROM (
        SELECT DISTINCT ON (substr(idempotency_key, ${SOURCE_AT}, 48)) idempotency_key, created_at
        FROM structure.progress_command
        WHERE principal_issuer = $1 AND principal_subject = $2 AND structure = $3 AND occurrence = $4
          AND starts_with(idempotency_key, $5)
        ORDER BY substr(idempotency_key, ${SOURCE_AT}, 48), created_at DESC, result_version DESC) latest
      WHERE substr(idempotency_key, ${KIND_AT}, 1) = 'h'
        AND created_at > coalesce((SELECT max(c.created_at) FROM structure.progress_command c
          WHERE c.principal_issuer = $1 AND c.principal_subject = $2 AND c.structure = $3 AND c.occurrence = $4
            AND NOT starts_with(c.idempotency_key, $5)), '-infinity')`,
    [principal.issuer, principal.subject, target.structure, target.occurrence, PROJECTION_KEY_PREFIX]);
    return rows.rows.map(row => row.source);
  }

  private async cells(client: PoolClient, principal: VerifiedPrincipal, target: { structure: string; occurrence: string }) {
    const rows = await client.query<{ selection_key: string; completed: boolean; position: string | null;
      version: string; order_revision: string | null; order_key: string | null; resume_eligible: boolean | null }>(`
      SELECT selection_key, completed, position, version::text AS version, order_revision, order_key, resume_eligible
      FROM structure.progress WHERE principal_issuer = $1 AND principal_subject = $2
        AND structure = $3 AND occurrence = $4 LIMIT 17`,
    [principal.issuer, principal.subject, target.structure, target.occurrence]);
    const cell = rows.rows.find(row => row.selection_key === '');
    return { cell, version: Number(cell?.version ?? 0),
      // A completed revision selection is the reader's own, whoever else holds.
      selected: rows.rows.some(row => row.selection_key !== '' && row.completed) };
  }

  private command(principal: VerifiedPrincipal, plan: { structure: string; occurrence: string }, sourceHash: string,
    kind: 'h' | 'r', version: number, change: Pick<ProgressWrite, 'completed' | 'position' | 'order' | 'anchoring'>): ProgressWrite {
    return { principal, structure: plan.structure, occurrence: plan.occurrence, ...change,
      expectedVersion: version,
      idempotencyKey: `${PROJECTION_KEY_PREFIX}${sourceHash}${digest(plan.structure, plan.occurrence)}${kind}${version + 1}` };
  }

  private async hold(client: PoolClient, principal: VerifiedPrincipal, sourceHash: string, plan: CompletionPlan) {
    const holders = await this.holders(client, principal, plan);
    if (holders.includes(sourceHash)) return null;
    const { cell, version, selected } = await this.cells(client, principal, plan);
    // The reader's own completion already says it: nothing to hold or undo.
    if (selected || cell?.completed && !holders.length) return null;
    const written = await this.progress.writeWithin(client, this.command(principal, plan, sourceHash, 'h', version, {
      completed: true, position: cell?.position ?? null, order: plan.order, anchoring: plan.anchoring }));
    return written.operation;
  }

  private async release(client: PoolClient, principal: VerifiedPrincipal, sourceHash: string,
    target: { structure: string; occurrence: string }, plan: CompletionPlan | null) {
    const holders = await this.holders(client, principal, target);
    if (!holders.includes(sourceHash)) return null;
    const { cell, version, selected } = await this.cells(client, principal, target);
    if (!cell) return null;
    if (holders.length > 1 || selected) {
      // Another hold or the reader still stands on it: record the release and
      // keep the completion exactly as it is, order keys and anchors included.
      const order = cell.order_revision && cell.order_key
        ? { revision: cell.order_revision, key: cell.order_key, eligible: cell.resume_eligible ?? true } : undefined;
      const written = await this.progress.writeWithin(client, this.command(principal, target, sourceHash, 'r', version, {
        completed: true, position: cell.position, order }));
      return written.operation;
    }
    // The anchors are withdrawn with the completion; an occurrence no longer
    // placed leaves them to the background pass.
    const anchoring: MemberAnchoring | undefined = !plan?.anchoring || plan.anchoring.unknown ? { unknown: true }
      : { overflow: plan.anchoring.overflow, anchors: plan.anchoring.anchors.map(anchor => ({ ...anchor, order: null })) };
    const written = await this.progress.writeWithin(client, this.command(principal, target, sourceHash, 'r', version, {
      completed: false, position: null, order: plan?.order, anchoring }));
    return written.operation;
  }
}

const projectors = new WeakMap<Pool, ProgressCompletionProjector>();
/** One projector per Content pool, like the other cross-owner hooks: every
 * store on the pool reaches it without being wired to each other. */
export function configureProgressCompletion(pool: Pool, projector: ProgressCompletionProjector) {
  projectors.set(pool, projector);
}
export function progressCompletion(pool: Pool): ProgressCompletionProjector | undefined {
  return projectors.get(pool);
}
