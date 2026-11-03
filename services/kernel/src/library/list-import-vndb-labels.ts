import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CommandOutcome, CommandTransaction } from '../command/command.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { ProblemError } from '../http/problem.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import type { LabelCommandAdmission } from './label-command-admission.ts';
import { normalizePersonalLabelName } from './label-store.ts';
import { createVndbImport } from './list-import-vndb.ts';
import {
  VNDB_LABEL_LIMITS as limits, VNDB_STATE_LABELS, vndbLabelDigest as digest,
  type VndbLabelChoice, type VndbLabelItem, type VndbLabelMapping, type VndbLabelOperand,
  type VndbLabelPlan, type VndbLabelResult, type VndbLabelStatus, type LabelIdentity,
} from './list-import-vndb-label-model.ts';

type Config = Parameters<typeof createVndbImport>[0] & Parameters<typeof createLabelAssignmentCommands>[0];
type Client = Pick<PoolClient, 'query'>;
const invalid = () => new ProblemError('invalid_request');
const stale = () => new LibraryConflictError();
const tuple = (owner: AccountActor, id: string) => [requireRoute(owner.accountId), owner.accountId, id];
const terminal = (item: VndbLabelItem) => item.status !== 'ready' && !item.result?.retryable;
const publicItem = (item: VndbLabelItem) => ({ item: item.item_no, ...item.operand, status: item.status, result: item.result });

/** A bounded consent over the installed producer; native label commands own every effect and receipt. */
export function createVndbLabelAdoption(config: Config) {
  const { pool } = config, source = createVndbImport(config), runner = createLibraryCommandRunner(config);
  const labels = createPersonalLabelCommands(config), assignments = createLabelAssignmentCommands(config);
  function owner(actor: Actor): AccountActor {
    if (actor.kind !== 'account' || !actor.scopes.includes('library_entry:read')) throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  }
  async function authorized(actor: Actor) {
    owner(actor);
    return source.authorized(actor);
  }
  function mutation<T>(actor: Actor, kind: string, key: string, input: unknown,
    body: (tx: CommandTransaction, account: AccountActor) => Promise<T>) {
    const account = owner(actor);
    return runner.ownAccount(actor, { action: 'library_entry:update', kind: `library.vndb.labels.${kind}`, requestKey: key, input },
      async (tx) => ({ value: await body(tx, account), events: [] }));
  }
  async function readPlan(client: Client, account: AccountActor, id: string, lock = false) {
    const found = await client.query<VndbLabelPlan>(
      `SELECT preview_id,state,expires_at,mappings,item_count FROM library.vndb_label_adoption
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND expires_at>clock_timestamp() ${lock ? 'FOR UPDATE' : ''}`,
      tuple(account, id));
    if (!found.rows[0]) throw new LibraryNotFoundError();
    return found.rows[0];
  }
  async function readItems(client: Client, account: AccountActor, id: string, after: number) {
    return (await client.query<VndbLabelItem>(
      `SELECT item_no,operand,status,result FROM library.vndb_label_adoption_item
       WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND item_no>$4 ORDER BY item_no LIMIT 9`,
      [...tuple(account, id), after])).rows;
  }
  async function page(actor: Actor, id: string, after = -1) {
    await authorized(actor);
    if (!Number.isInteger(after) || after < -1 || after >= limits.items) throw invalid();
    const account = owner(actor), plan = await readPlan(pool, account, id);
    const rows = await readItems(pool, account, id, after), items = rows.slice(0, limits.page);
    await authorized(actor);
    // Recheck physical evidence after work; erasure/deletion never grants receipt-based read authority.
    const current = await readPlan(pool, account, id);
    if (current.preview_id !== plan.preview_id) throw stale();
    return { uploadId: id, previewId: plan.preview_id, state: current.state, expiresAt: plan.expires_at.toISOString(),
      mappings: plan.mappings, total: plan.item_count, items: items.map(publicItem),
      next: rows.length > limits.page ? items.at(-1)!.item_no : null, limits };
  }
  async function mapping(account: AccountActor, choice: VndbLabelChoice['mappings'][number]): Promise<VndbLabelMapping> {
    const item: VndbLabelMapping = { ...choice, label: null, admission: 'ready', reason: null };
    if (VNDB_STATE_LABELS.has(choice.source)) return { ...item, admission: 'unsupported', reason: 'state-label' };
    if ('name' in choice.target) {
      let name: string;
      try { name = normalizePersonalLabelName(choice.target.name); } catch { throw invalid(); }
      // The exact reviewed spelling is the native operand; never infer an existing identity from a name.
      if (name !== choice.target.name) throw invalid();
      const collision = await pool.query(
        `SELECT label_id FROM library.personal_label WHERE route=$1 AND account_id=$2 AND normalized_name=$3 AND deleted_at IS NULL`,
        [requireRoute(account.accountId), account.accountId, name]);
      if (collision.rows.length) return { ...item, admission: 'refused', reason: 'name-occupied' };
    } else {
      const label = await pool.query<LabelIdentity>(
        `SELECT label_id AS id,revision FROM library.personal_label
         WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL`,
        [requireRoute(account.accountId), account.accountId, choice.target.labelId]);
      if (label.rows[0]?.revision !== choice.target.revision)
        return { ...item, admission: 'refused', reason: 'label-unavailable' };
      item.label = label.rows[0];
    }
    return item;
  }
  async function review(actor: Actor, id: string, choice: VndbLabelChoice, key: string) {
    await authorized(actor);
    const account = owner(actor);
    if (!choice.rows.length || choice.rows.length > limits.rows || !choice.mappings.length || choice.mappings.length > limits.mappings ||
        Buffer.byteLength(JSON.stringify(choice)) > limits.selectionBytes ||
        new Set(choice.rows.map(r => r.ordinal)).size !== choice.rows.length ||
        new Set(choice.mappings.map(m => m.source)).size !== choice.mappings.length ||
        choice.mappings.some(m => !m.source || Buffer.byteLength(m.source) > limits.sourceNameBytes)) throw invalid();
    const mappings: VndbLabelMapping[] = [];
    for (const m of choice.mappings) mappings.push(await mapping(account, m));
    const operands: { operand: VndbLabelOperand; status: VndbLabelStatus; result: VndbLabelResult | null }[] = [];
    const subjects = new Set<string>(), used = new Set<number>();
    let expiresAt = Infinity;
    for (const selected of choice.rows) {
      const retained = await source.retainedRow(actor, id, selected.ordinal);
      const decision = retained.decision;
      if (retained.state !== 'active' || !decision || decision.reviewId !== selected.reviewId) throw stale();
      expiresAt = Math.min(expiresAt, retained.expires_at.getTime());
      const subjectId = retained.target?.targetId ?? null;
      if (subjectId && subjects.has(subjectId)) throw invalid();
      if (subjectId) subjects.add(subjectId);
      const eligible = retained.row.kind === 'vn' && retained.row.identifier?.provider === 'vndb' && subjectId &&
        decision.targetId === subjectId && decision.guard?.source === retained.target?.source &&
        !['ambiguous', 'unavailable', 'unsupported'].includes(retained.matching.status) &&
        (retained.matching.status !== 'matched' || retained.matching.candidates[0] === subjectId);
      const slots = subjectId ? await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count FROM (
           SELECT label_id FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3
           AND slot_no IS NOT NULL ORDER BY assignment_id LIMIT 32
         ) a JOIN library.personal_label l ON l.route=$1 AND l.account_id=$2 AND l.label_id=a.label_id AND l.deleted_at IS NULL`,
        [requireRoute(account.accountId), account.accountId, subjectId]) : null;
      const full = slots?.rows[0]?.count === 32;
      const targets = new Set<string>();
      for (let index = 0; index < mappings.length; index++) {
        const m = mappings[index]!;
        if (!retained.row.labels.includes(m.source)) continue;
        used.add(index);
        const identity = digest(m.target);
        // Two source names may deliberately map to one target; one unique Subject/target effect suffices.
        if (m.admission === 'ready') {
          if (targets.has(identity)) continue;
          targets.add(identity);
        }
        const status = m.admission === 'ready' ? eligible ? 'ready' : 'stale' : m.admission;
        let baseline: VndbLabelOperand['assignment'] = null;
        let result: VndbLabelResult | null = status === 'ready' ? null : {
          reason: m.reason ?? 'source-review-unavailable', retryable: false, label: m.label, assignment: null,
        };
        if (status === 'ready' && m.label) {
          const existing = await pool.query<NonNullable<VndbLabelOperand['assignment']>>(
            `SELECT assignment_id AS id,revision,deleted_at IS NULL AND slot_no IS NOT NULL AS effective FROM library.label_assignment
             WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4 AND assignment_id IS NOT NULL`,
            [requireRoute(account.accountId), account.accountId, subjectId, m.label.id]);
          baseline = existing.rows[0] ?? null;
          if (baseline?.effective) result = { reason: 'already-present', retryable: false, label: m.label,
            assignment: { id: baseline.id, revision: baseline.revision } };
        }
        if (status === 'ready' && !result && full)
          result = { reason: 'assignment-capacity', retryable: false, label: m.label, assignment: null };
        operands.push({ operand: { ordinal: selected.ordinal, reviewId: selected.reviewId, sourceDigest: digest(retained.row),
          subjectId, source: retained.target?.source ?? null, mapping: index, assignment: baseline }, status, result });
      }
    }
    if (used.size !== mappings.length || !operands.length || operands.length > limits.items) throw invalid();
    for (const m of mappings) {
      const first = operands.find(i => i.status === 'ready' && digest(mappings[i.operand.mapping]!.target) === digest(m.target));
      if (first) m.creator = first.operand;
    }
    if (Buffer.byteLength(JSON.stringify(mappings)) > limits.selectionBytes ||
        operands.some(i => Buffer.byteLength(JSON.stringify(i.operand)) > 4096)) throw invalid();
    const proposed = randomUUID();
    const result = await mutation(actor, 'review', key, { id, choice }, async (tx, a) => {
      // Parent-first ordering matches native dispatch and producer cancel/delete/review.
      const active = await tx.query(
        `SELECT upload_id FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3
         AND state='active' AND expires_at>clock_timestamp() FOR UPDATE`, tuple(a, id));
      if (!active.rows[0]) throw stale();
      const encoded = await tx.query<{ oversized: boolean }>(
        `SELECT octet_length($1::jsonb::text)>16384 OR EXISTS(
           SELECT 1 FROM jsonb_array_elements($2::jsonb) o WHERE octet_length(o::text)>4096
         ) AS oversized`, [JSON.stringify(mappings), JSON.stringify(operands.map(i => i.operand))]);
      if (encoded.rows[0]?.oversized) throw invalid();
      for (const selected of choice.rows) {
        const found = await tx.query<{ review_id: string }>(
          `SELECT decisions->$4->>'reviewId' AS review_id FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
          [...tuple(a, id), String(selected.ordinal)]);
        if (found.rows[0]?.review_id !== selected.reviewId) throw stale();
      }
      const old = await tx.query<{ state: string }>(
        'SELECT state FROM library.vndb_label_adoption WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE', tuple(a, id));
      if (old.rows[0] && old.rows[0].state !== 'reviewed') throw stale();
      await tx.query('DELETE FROM library.vndb_label_adoption WHERE route=$1 AND account_id=$2 AND upload_id=$3', tuple(a, id));
      await tx.query(
        `INSERT INTO library.vndb_label_adoption(route,account_id,upload_id,preview_id,state,expires_at,mappings,item_count)
         VALUES($1,$2,$3,$4,'reviewed',$5,$6::jsonb,$7)`,
        [...tuple(a, id), proposed, new Date(expiresAt), JSON.stringify(mappings), operands.length]);
      for (let n = 0; n < operands.length; n++) {
        const item = operands[n]!;
        await tx.query(
          `INSERT INTO library.vndb_label_adoption_item(route,account_id,upload_id,item_no,operand,status,result)
           VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
          [...tuple(a, id), n, JSON.stringify(item.operand), item.status, JSON.stringify(item.result)]);
      }
      return { previewId: proposed, total: operands.length, expiresAt: new Date(expiresAt).toISOString() };
    });
    // An old review receipt cannot reinstall a superseded consent.
    const current = await readPlan(pool, account, id);
    if (current.preview_id !== result.value.previewId) throw stale();
    await authorized(actor);
    return result;
  }
  async function currentOperand(actor: Actor, id: string, operand: VndbLabelOperand) {
    const current = await source.retainedRow(actor, id, operand.ordinal);
    if (current.state !== 'active' || current.decision?.reviewId !== operand.reviewId ||
        digest(current.row) !== operand.sourceDigest || !operand.subjectId ||
        current.decision.targetId !== operand.subjectId || current.target?.targetId !== operand.subjectId ||
        current.target.source !== operand.source ||
        ['ambiguous', 'unavailable', 'unsupported'].includes(current.matching.status) ||
        (current.matching.status === 'matched' && current.matching.candidates[0] !== operand.subjectId)) throw stale();
  }
  function admission(actor: Actor, id: string, plan: VndbLabelPlan, operands: VndbLabelOperand[], label: LabelIdentity | null): LabelCommandAdmission {
    const input = { uploadId: id, previewId: plan.preview_id, operands, label };
    return { input, async prepare() {
      // Defer business failures until after native receipt lookup (including creation replay).
      let failure: unknown;
      try { for (const operand of operands) await currentOperand(actor, id, operand); } catch (error) { failure = error; }
      return async (tx) => {
        if (failure !== undefined) throw failure;
        const a = owner(actor);
        for (const operand of operands) {
          const found = await tx.query<{ state: string; row: unknown; review_id: string; target_id: string }>(
            `SELECT state,rows->$4::integer AS row,decisions->$5::text->>'reviewId' AS review_id,
             decisions->$5::text->>'targetId' AS target_id FROM library.vndb_import
             WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND expires_at>clock_timestamp() FOR SHARE`,
            [...tuple(a, id), operand.ordinal, String(operand.ordinal)]);
          const retained = found.rows[0];
          if (!retained || retained.state !== 'active' || retained.review_id !== operand.reviewId ||
              retained.target_id !== operand.subjectId || digest(retained.row) !== operand.sourceDigest) throw stale();
        }
        const locked = await readPlan(tx, a, id);
        if (locked.preview_id !== plan.preview_id || locked.state !== 'applying') throw stale();
        if (label) {
          const current = await tx.query<{ revision: number }>(
            `SELECT revision FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`,
            [requireRoute(a.accountId), a.accountId, label.id]);
          if (current.rows[0]?.revision !== label.revision) throw stale();
        }
      };
    } };
  }
  async function finish(actor: Actor, id: string, plan: VndbLabelPlan, item: VndbLabelItem, status: VndbLabelStatus, result: VndbLabelResult) {
    // Unknown failures have no native acknowledgement. Repeated retry attempts keep the same operands/key.
    return mutation(actor, 'result', `${plan.preview_id}:${item.item_no}:${digest([status, result])}`, { id, previewId: plan.preview_id, item: item.item_no, status, result },
      async (tx, a) => {
        const current = await readPlan(tx, a, id, true);
        if (current.preview_id !== plan.preview_id) throw stale();
        await tx.query(
          `UPDATE library.vndb_label_adoption_item SET status=$5,result=$6::jsonb
           WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND item_no=$4
           AND status NOT IN ('applied','already_present')`, [...tuple(a, id), item.item_no, status, JSON.stringify(result)]);
        return { item: item.item_no, status };
      });
  }
  async function apply(actor: Actor, id: string, previewId: string, selected: number[], record: (outcome: CommandOutcome<unknown>) => void, signal?: AbortSignal) {
    await authorized(actor);
    if (!selected.length || selected.length > limits.page || new Set(selected).size !== selected.length ||
        selected.some(n => !Number.isInteger(n) || n < 0 || n >= limits.items)) throw invalid();
    const account = owner(actor), deadline = Date.now() + limits.applyMs;
    const outcomes: ReturnType<typeof publicItem>[] = [];
    const initial = await readPlan(pool, account, id);
    if (initial.preview_id !== previewId) throw stale();
    if (initial.state === 'cancelled') return { uploadId: id, previewId, outcomes, stopped: 'cancelled' as const };
    const begun = await mutation(actor, 'start', `${previewId}:start`, { id, previewId }, async (tx, a) => {
      const found = await tx.query(
        `SELECT upload_id FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR SHARE`, tuple(a, id));
      if (!found.rows[0]) throw stale();
      const plan = await readPlan(tx, a, id, true);
      if (plan.preview_id !== previewId || plan.state === 'cancelled') throw stale();
      await tx.query("UPDATE library.vndb_label_adoption SET state='applying' WHERE route=$1 AND account_id=$2 AND upload_id=$3", tuple(a, id));
      return { previewId };
    });
    record(begun);
    let stopped: 'cancelled' | 'deadline' | null = null;
    for (const n of selected) {
      if (signal?.aborted || Date.now() >= deadline) { stopped = signal?.aborted ? 'cancelled' : 'deadline'; break; }
      const plan = await readPlan(pool, account, id);
      if (plan.preview_id !== previewId) throw stale();
      if (plan.state === 'cancelled') { stopped = 'cancelled'; break; }
      const item = (await readItems(pool, account, id, n - 1))[0];
      if (!item || item.item_no !== n) throw invalid();
      if (terminal(item)) { outcomes.push(publicItem(item)); continue; }
      const mapping = plan.mappings[item.operand.mapping]!;
      let label = mapping.label, status: VndbLabelStatus = 'refused';
      let result: VndbLabelResult = { reason: null, retryable: false, label, assignment: null };
      try {
        if (!label) {
          if (!('name' in mapping.target)) throw stale();
          // A mapping creates at most one identity. Its original key and consent remain unchanged on retry.
          if (!mapping.creator) throw stale();
          const creationKey = digest(mapping.target);
          const created = await labels.createLabel(actor, { name: mapping.target.name }, `${previewId}:create:${creationKey}`,
            admission(actor, id, plan, [mapping.creator], null));
          record(created);
          label = created.value.label;
          const acknowledged = label;
          record(await mutation(actor, 'created', `${previewId}:created:${creationKey}`, { id, previewId, target: mapping.target, label }, async (tx, a) => {
            const current = await readPlan(tx, a, id, true);
            if (current.preview_id !== previewId) throw stale();
            for (let index = 0; index < current.mappings.length; index++) {
              if (digest(current.mappings[index]!.target) !== creationKey) continue;
              await tx.query(
                `UPDATE library.vndb_label_adoption SET mappings=jsonb_set(mappings,ARRAY[$4::text,'label'],$5::jsonb)
                 WHERE route=$1 AND account_id=$2 AND upload_id=$3`, [...tuple(a, id), String(index), JSON.stringify(acknowledged)]);
            }
            return { label: acknowledged };
          }));
        }
        result.label = label;
        const assigned = await assignments.assignReviewedLabel(actor, label.id, { subjectId: item.operand.subjectId! },
          label.revision, item.operand.assignment, `${previewId}:assign:${n}`, admission(actor, id, plan, [item.operand], label));
        record(assigned);
        status = assigned.value.unchanged ? 'already_present' : 'applied';
        result.assignment = assigned.value.assignment;
      } catch (error) {
        if (error instanceof GrantDeniedError) throw error;
        if (error instanceof LibraryConflictError || error instanceof LibraryNotFoundError) { status = 'stale'; result.reason = 'review-changed'; }
        else if (error instanceof ProblemError && error.code === 'library_label_capacity') result.reason = 'assignment-capacity';
        else { result.reason = 'native-unavailable'; result.retryable = true; }
      }
      record(await finish(actor, id, plan, item, status, result));
      const saved = (await readItems(pool, account, id, n - 1))[0]!;
      outcomes.push(publicItem(saved));
    }
    await authorized(actor);
    await readPlan(pool, account, id);
    return { uploadId: id, previewId, outcomes, stopped };
  }
  async function cancel(actor: Actor, id: string, previewId: string, key: string) {
    await authorized(actor);
    return mutation(actor, 'cancel', key, { id, previewId }, async (tx, a) => {
      // This exclusive parent lock orders cancellation against every fresh native admission.
      await tx.query('SELECT upload_id FROM library.vndb_import WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE', tuple(a, id));
      const plan = await readPlan(tx, a, id, true);
      if (plan.preview_id !== previewId) throw stale();
      await tx.query("UPDATE library.vndb_label_adoption SET state='cancelled' WHERE route=$1 AND account_id=$2 AND upload_id=$3", tuple(a, id));
      return { previewId, state: 'cancelled' as const };
    });
  }
  return { review, page, apply, cancel };
}
