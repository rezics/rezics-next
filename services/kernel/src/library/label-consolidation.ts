import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { systemClock, type KernelClock } from '../clock.ts';
import { readAccount } from '../access/account-data.ts';
import { shareAccount } from '../access/account-share.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  noEffect,
  releaseOperationalTime,
  runCommand,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  sameAccountRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { readStoredLabelAssignment, type PrivateLabelAssignment } from './label-assignment-lifecycle-store.ts';
import reservations from './label-assignment-reservations.sql';
import parents from './label-consolidation-parents.sql';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { readPersonalLabel } from './label-store.ts';
import { resolveSubject } from './subject-anchor.ts';
import { workStepDeadline } from './command-support.ts';

export const LABEL_CONSOLIDATION_LIMITS = Object.freeze({
  selection: 16,
  confirmationMinutes: 15,
  retainedPerOwner: 8,
});

export type LabelConsolidationSelection = { subjectId: string; assignmentId: string; revision: number };
type LabelSnapshot = { id: string; name: string; revision: number };
type AssignmentSnapshot = { id: string; revision: number; effective: boolean };
type EvidenceItem = {
  selected: LabelConsolidationSelection;
  source: AssignmentSnapshot;
  target: AssignmentSnapshot | null;
  outcome: 'movable' | 'already_on_target';
};
type Evidence = {
  selection: string;
  sourceLabel: LabelSnapshot;
  targetLabel: LabelSnapshot;
  items: EvidenceItem[];
};
type ItemStatus =
  | 'pending'
  | 'applying'
  | 'moved'
  | 'target_applied_source_retained'
  | 'capacity_limited'
  | 'changed'
  | 'inaccessible';
type ItemStage = 'target_pending' | 'target_started' | 'target_accepted' | 'source_started';
type Client = Pick<PoolClient, 'query'>;
type Plan = {
  confirmationId: string;
  sourceLabelId: string;
  targetLabelId: string;
  sourceLabelRevision: number;
  targetLabelRevision: number;
  selectionDigest: string;
  reviewEvidence: Evidence;
  itemCount: number;
  nextItem: number;
  status: 'active' | 'completed' | 'cancelled';
  expiresAt: string;
};
type PlanItem = {
  itemNo: number;
  subjectId: string;
  sourceAssignmentId: string;
  sourceRevision: number;
  targetAssignmentId: string | null;
  targetRevision: number | null;
  targetEffective: boolean | null;
  targetRequestKey: string;
  sourceRequestKey: string;
  status: ItemStatus;
  stage: ItemStage | null;
  targetResultId: string | null;
  targetResultRevision: number | null;
  targetUnchanged: boolean | null;
  sourceResultRevision: number | null;
};
export type LabelConsolidationResult = {
  confirmationId: string;
  sourceLabelId: string;
  targetLabelId: string;
  status: 'active' | 'completed' | 'cancelled';
  expiresAt: string;
  items: Array<{
    item: number;
    selected?: LabelConsolidationSelection;
    status: Exclude<ItemStatus, 'applying'> | 'processing';
    targetAssignment?: { id: string; revision: number };
    targetUnchanged?: boolean;
    sourceUnassignRevision?: number;
  }>;
};

const invalid = () => new ProblemError('invalid_request');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const CONFIRMATION_LIMIT_BYTES = 16_384;

function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw invalid();
  return value as Record<string, unknown>;
}

function id(value: unknown, routed = true): string {
  if (typeof value !== 'string' || !uuid.test(value) || (routed && routeOf(value) === null)) throw invalid();
  return value;
}

function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_646) throw invalid();
  return value;
}

function headRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 2_147_483_647) throw invalid();
  return value;
}

function label(value: unknown): LabelSnapshot {
  const input = object(value, ['id', 'name', 'revision']);
  if (typeof input.name !== 'string' || Array.from(input.name).length > 100) throw invalid();
  return { id: id(input.id), name: input.name, revision: headRevision(input.revision) };
}

function selection(value: unknown): LabelConsolidationSelection {
  const input = object(value, ['subjectId', 'assignmentId', 'revision']);
  return {
    subjectId: id(input.subjectId),
    assignmentId: id(input.assignmentId, false),
    revision: revision(input.revision),
  };
}

function assignment(value: unknown, nullable = false): AssignmentSnapshot | null {
  if (value === null && nullable) return null;
  const input = object(value, ['id', 'revision', 'effective']);
  if (typeof input.effective !== 'boolean') throw invalid();
  return { id: id(input.id, false), revision: headRevision(input.revision), effective: input.effective };
}

function evidence(value: unknown, sourceLabelId: string): Evidence {
  const input = object(value, ['selection', 'sourceLabel', 'targetLabel', 'items']);
  if (typeof input.selection !== 'string' || !digestPattern.test(input.selection) || !Array.isArray(input.items))
    throw invalid();
  const sourceLabel = label(input.sourceLabel),
    targetLabel = label(input.targetLabel);
  if (
    sourceLabel.id !== sourceLabelId ||
    targetLabel.id === sourceLabelId ||
    routeOf(targetLabel.id) !== routeOf(sourceLabelId) ||
    input.items.length < 1 ||
    input.items.length > LABEL_CONSOLIDATION_LIMITS.selection
  )
    throw invalid();
  const items = input.items.map((value): EvidenceItem => {
    const item = object(value, ['selected', 'source', 'target', 'outcome']);
    const selected = selection(item.selected),
      source = assignment(item.source) as AssignmentSnapshot,
      target = assignment(item.target, true);
    if (
      source.id !== selected.assignmentId ||
      source.revision !== selected.revision ||
      !source.effective ||
      (item.outcome !== 'movable' && item.outcome !== 'already_on_target') ||
      (item.outcome === 'movable' && target?.effective === true) ||
      (item.outcome === 'already_on_target' && target?.effective !== true)
    )
      throw invalid();
    return { selected, source, target, outcome: item.outcome };
  });
  if (new Set(items.map((item) => item.selected.subjectId)).size !== items.length) throw invalid();
  const result = { selection: input.selection, sourceLabel, targetLabel, items };
  if (Buffer.byteLength(JSON.stringify(result)) > CONFIRMATION_LIMIT_BYTES) throw invalid();
  return result;
}

function observation(
  row: Pick<PrivateLabelAssignment, 'id' | 'revision' | 'slotNo' | 'deletedAt'> | null | undefined,
): AssignmentSnapshot | null {
  if (!row) return null;
  if (row.id === null || (row.deletedAt === null && row.slotNo === null)) throw new ProblemError('index_not_ready');
  return { id: row.id, revision: row.revision, effective: row.deletedAt === null && row.slotNo !== null };
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function actor(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}

function planRow(row: Record<string, unknown>): Plan {
  return {
    confirmationId: String(row.confirmationId),
    sourceLabelId: String(row.sourceLabelId),
    targetLabelId: String(row.targetLabelId),
    sourceLabelRevision: Number(row.sourceLabelRevision),
    targetLabelRevision: Number(row.targetLabelRevision),
    selectionDigest: String(row.selectionDigest),
    reviewEvidence: row.reviewEvidence as Evidence,
    itemCount: Number(row.itemCount),
    nextItem: Number(row.nextItem),
    status: row.status as Plan['status'],
    expiresAt: new Date(String(row.expiresAt)).toISOString(),
  };
}

function itemRow(row: Record<string, unknown>): PlanItem {
  return {
    itemNo: Number(row.itemNo),
    subjectId: String(row.subjectId),
    sourceAssignmentId: String(row.sourceAssignmentId),
    sourceRevision: Number(row.sourceRevision),
    targetAssignmentId: row.targetAssignmentId === null ? null : String(row.targetAssignmentId),
    targetRevision: row.targetRevision === null ? null : Number(row.targetRevision),
    targetEffective: row.targetEffective === null ? null : Boolean(row.targetEffective),
    targetRequestKey: String(row.targetRequestKey),
    sourceRequestKey: String(row.sourceRequestKey),
    status: row.status as ItemStatus,
    stage: row.stage === null ? null : (row.stage as ItemStage),
    targetResultId: row.targetResultId === null ? null : String(row.targetResultId),
    targetResultRevision: row.targetResultRevision === null ? null : Number(row.targetResultRevision),
    targetUnchanged: row.targetUnchanged === null ? null : Boolean(row.targetUnchanged),
    sourceResultRevision: row.sourceResultRevision === null ? null : Number(row.sourceResultRevision),
  };
}

const planColumns = `confirmation_id AS "confirmationId", source_label_id AS "sourceLabelId",
  target_label_id AS "targetLabelId", source_label_revision AS "sourceLabelRevision",
  target_label_revision AS "targetLabelRevision", selection_digest AS "selectionDigest",
  review_evidence AS "reviewEvidence", item_count AS "itemCount", next_item AS "nextItem",
  status, expires_at::text AS "expiresAt"`;
const itemColumns = `item_no AS "itemNo", subject_id AS "subjectId", source_assignment_id AS "sourceAssignmentId",
  source_revision AS "sourceRevision", target_assignment_id AS "targetAssignmentId",
  target_revision AS "targetRevision", target_effective AS "targetEffective",
  target_request_key AS "targetRequestKey", source_request_key AS "sourceRequestKey", status, stage,
  target_result_id AS "targetResultId", target_result_revision AS "targetResultRevision",
  target_unchanged AS "targetUnchanged", source_result_revision AS "sourceResultRevision"`;

/** Immutable per-selection bindings that replay only their original native assign/unassign receipts. */
export function createLabelConsolidationCommands(deps: {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: KernelClock;
}) {
  const { pool } = deps,
    clock = deps.clock ?? systemClock,
    runner = createLibraryCommandRunner({ pool, clock, access: deps.access }),
    assignmentCommands = createLabelAssignmentCommands(deps);

  const gate = (owner: AccountActor, action: 'library_entry:read' | 'library_entry:update', deadline: number) =>
    admitGroup({
      ...deps,
      access: () => deps.access,
      actor: owner,
      clock,
      deadline,
      group: 'personal_library',
      clientAction: action,
    });

  async function snapshot<T>(
    owner: AccountActor,
    deadline: number,
    body: (client: Client, route: number) => Promise<T>,
  ) {
    return withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline),
        route = routeOf(owner.accountId)!;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(client, route, owner.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(owner.authnEpoch) ||
          owner.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
        )
          throw new GrantDeniedError();
        const result = await body(client, route);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function currentTime(owner: AccountActor, deadline: number) {
    return snapshot(owner, deadline, (client) => mintReadTime(client, clock));
  }

  async function resolveSelection(
    owner: AccountActor,
    items: EvidenceItem[],
    time: Awaited<ReturnType<typeof currentTime>>,
    deadline: number,
  ) {
    for (const item of items) {
      const resolved = await withRequestDeadline(deadline, () =>
        resolveSubject(deps, owner, item.selected.subjectId, time),
      );
      if (resolved?.subjectId !== item.selected.subjectId) throw new LibraryConflictError();
    }
  }

  async function readPlan(
    client: Client,
    owner: AccountActor,
    sourceLabelId: string,
    confirmationId: string,
    at: string,
    lock = false,
  ): Promise<Plan | null> {
    const route = sameAccountRoute(owner.accountId, sourceLabelId);
    const row = await client.query<Record<string, unknown>>(
      `SELECT ${planColumns} FROM library.label_consolidation
       WHERE route=$1 AND account_id=$2 AND source_label_id=$3 AND consolidation_id=$4
         AND expires_at > $5::timestamptz ${lock ? 'FOR UPDATE' : ''}`,
      [route, owner.accountId, sourceLabelId, confirmationId, at],
    );
    return row.rows[0] ? planRow(row.rows[0]) : null;
  }

  async function readItems(
    client: Client,
    owner: AccountActor,
    sourceLabelId: string,
    confirmationId: string,
    lock = false,
  ) {
    const route = sameAccountRoute(owner.accountId, sourceLabelId);
    const rows = await client.query<Record<string, unknown>>(
      `SELECT ${itemColumns} FROM library.label_consolidation_item
       WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 ORDER BY item_no ${lock ? 'FOR UPDATE' : ''}`,
      [route, owner.accountId, confirmationId],
    );
    return rows.rows.map(itemRow);
  }

  async function reviewOutcome(
    client: Client,
    route: number,
    accountId: string,
    sourceLabelId: string,
    targetLabelId: string,
    item: EvidenceItem,
  ) {
    const tuple = { route, accountId, subjectId: item.selected.subjectId },
      source = observation(await readStoredLabelAssignment(client, { ...tuple, labelId: sourceLabelId })),
      rows = await reservations.run(
        { query: client.query.bind(client) },
        { route, account_id: accountId, subject_id: item.selected.subjectId, label_id: targetLabelId },
      ),
      target = observation(rows.find((row) => row.desired));
    let outcome: EvidenceItem['outcome'] | 'changed' | 'capacity_limited' | 'missing';
    if (!source) outcome = 'missing';
    else if (source.id !== item.selected.assignmentId || source.revision !== item.selected.revision)
      outcome = 'changed';
    else if (!source.effective) outcome = 'missing';
    else if (target?.effective) outcome = 'already_on_target';
    else {
      const reserved = rows.filter((row) => !row.desired),
        states = await parents.run(
          { query: client.query.bind(client) },
          { route, account_id: accountId, label_ids: reserved.map((row) => row.labelId) },
        );
      outcome = reserved.length < 32 || states.some((parent) => !parent.live) ? 'movable' : 'capacity_limited';
    }
    return { source, target, outcome };
  }

  async function confirm(ownerActor: Actor, sourceValue: string, value: unknown, key: string) {
    const owner = actor(ownerActor, 'library_entry:update');
    actor(ownerActor, 'library_entry:read');
    const sourceLabelId = id(sourceValue),
      evidenceValue = evidence(value, sourceLabelId),
      targetLabelId = evidenceValue.targetLabel.id;
    sameAccountRoute(owner.accountId, targetLabelId);
    const selectionHash = createHash('sha256')
      .update(
        JSON.stringify([
          owner.accountId,
          sourceLabelId,
          targetLabelId,
          evidenceValue.items.map((item) => item.selected),
        ]),
      )
      .digest('hex');
    if (selectionHash !== evidenceValue.selection) throw new LibraryConflictError();
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    await gate(owner, 'library_entry:read', deadline);
    const time = await currentTime(owner, deadline);
    try {
      await resolveSelection(owner, evidenceValue.items, time, deadline);
      return await runner.ownAccount(
        owner,
        {
          action: 'library_entry:update',
          kind: 'library_label.consolidation_confirm',
          requestKey: key,
          input: { sourceLabelId, evidence: evidenceValue },
        },
        async (tx, command) => {
          const route = sameAccountRoute(owner.accountId, sourceLabelId),
            source = await readPersonalLabel(tx, route, owner.accountId, sourceLabelId),
            target = await readPersonalLabel(tx, route, owner.accountId, targetLabelId);
          if (
            !source ||
            !target ||
            !same({ id: source.id, name: source.name, revision: source.revision }, evidenceValue.sourceLabel) ||
            !same({ id: target.id, name: target.name, revision: target.revision }, evidenceValue.targetLabel)
          )
            throw new LibraryConflictError();
          for (const item of evidenceValue.items) {
            const current = await reviewOutcome(tx, route, owner.accountId, sourceLabelId, targetLabelId, item);
            if (
              current.outcome !== item.outcome ||
              !same(current.source, item.source) ||
              !same(current.target, item.target)
            )
              throw new LibraryConflictError();
          }
          const now = authoritativeTimeValue(command.time),
            expiresAt = new Date(
              Date.parse(now) + LABEL_CONSOLIDATION_LIMITS.confirmationMinutes * 60_000,
            ).toISOString();
          const retained = await tx.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM library.label_consolidation
             WHERE route=$1 AND account_id=$2 AND expires_at > $3::timestamptz`,
            [route, owner.accountId, now],
          );
          if (Number(retained.rows[0]?.count ?? 0) >= LABEL_CONSOLIDATION_LIMITS.retainedPerOwner)
            throw new ProblemError('conflict');
          const confirmationId = randomUUID();
          await tx.query(
            `INSERT INTO library.label_consolidation
             (route,account_id,consolidation_id,source_label_id,target_label_id,source_label_revision,
              target_label_revision,selection_digest,review_evidence,item_count,next_item,status,created_at,
              updated_at,expires_at,transaction_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,0,'active',$11::timestamptz,$11::timestamptz,$12::timestamptz,$13)`,
            [
              route,
              owner.accountId,
              confirmationId,
              sourceLabelId,
              targetLabelId,
              source.revision,
              target.revision,
              evidenceValue.selection,
              JSON.stringify(evidenceValue),
              evidenceValue.items.length,
              now,
              expiresAt,
              command.transactionId,
            ],
          );
          for (let itemNo = 0; itemNo < evidenceValue.items.length; itemNo++) {
            const item = evidenceValue.items[itemNo]!;
            await tx.query(
              `INSERT INTO library.label_consolidation_item
               (route,account_id,consolidation_id,item_no,subject_id,source_assignment_id,source_revision,
                target_assignment_id,target_revision,target_effective,target_request_key,source_request_key,
                status,stage,created_at,updated_at,transaction_id)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending',NULL,$13::timestamptz,$13::timestamptz,$14)`,
              [
                route,
                owner.accountId,
                confirmationId,
                itemNo,
                item.selected.subjectId,
                item.selected.assignmentId,
                item.selected.revision,
                item.target?.id ?? null,
                item.target?.revision ?? null,
                item.target?.effective ?? null,
                randomUUID(),
                randomUUID(),
                now,
                command.transactionId,
              ],
            );
          }
          return noEffect({
            confirmationId,
            expiresAt,
            status: 'active' as const,
            itemCount: evidenceValue.items.length,
          });
        },
      );
    } finally {
      releaseOperationalTime(time);
    }
  }

  async function updateStage(
    owner: AccountActor,
    plan: Plan,
    item: PlanItem,
    stage: ItemStage,
    key: string,
    target?: { id: string; revision: number; unchanged: boolean },
  ) {
    return runner.ownAccount(
      owner,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_progress',
        requestKey: key,
        input: {
          sourceLabelId: plan.sourceLabelId,
          confirmationId: plan.confirmationId,
          item: item.itemNo,
          stage,
          target,
        },
      },
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, plan.sourceLabelId),
          currentPlan = await readPlan(
            tx,
            owner,
            plan.sourceLabelId,
            plan.confirmationId,
            authoritativeTimeValue(command.time),
            true,
          );
        if (!currentPlan) throw new LibraryNotFoundError();
        const currentItems = await readItems(tx, owner, plan.sourceLabelId, plan.confirmationId, true),
          current = currentItems[item.itemNo];
        if (!current) throw new LibraryNotFoundError();
        if (current.status !== 'applying' || current.stage === null) return noEffect({ updated: false });
        if (stage === 'target_started' && current.stage !== 'target_pending') return noEffect({ updated: false });
        if (stage === 'target_accepted' && current.stage !== 'target_started') return noEffect({ updated: false });
        if (stage === 'source_started' && current.stage !== 'target_accepted') return noEffect({ updated: false });
        if (stage === 'source_started' && currentPlan.status !== 'active') return noEffect({ updated: false });
        await tx.query(
          `UPDATE library.label_consolidation_item SET stage=$5,
             target_result_id=COALESCE($6::uuid,target_result_id),
             target_result_revision=COALESCE($7::integer,target_result_revision),
             target_unchanged=COALESCE($8::boolean,target_unchanged), updated_at=$9::timestamptz, transaction_id=$10
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=$4 AND status='applying'`,
          [
            route,
            owner.accountId,
            plan.confirmationId,
            item.itemNo,
            stage,
            target?.id ?? null,
            target?.revision ?? null,
            target?.unchanged ?? null,
            authoritativeTimeValue(command.time),
            command.transactionId,
          ],
        );
        return noEffect({ updated: true });
      },
    );
  }

  async function finishItem(
    owner: AccountActor,
    plan: Plan,
    item: PlanItem,
    status: Exclude<ItemStatus, 'pending' | 'applying'>,
    key: string,
    target?: { id: string; revision: number; unchanged: boolean },
    sourceRevision?: number,
  ) {
    return runner.ownAccount(
      owner,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_finish',
        requestKey: key,
        input: {
          sourceLabelId: plan.sourceLabelId,
          confirmationId: plan.confirmationId,
          item: item.itemNo,
          status,
          target,
          sourceRevision,
        },
      },
      async (tx, command) => {
        const route = sameAccountRoute(owner.accountId, plan.sourceLabelId),
          now = authoritativeTimeValue(command.time),
          currentPlan = await readPlan(tx, owner, plan.sourceLabelId, plan.confirmationId, now, true);
        if (!currentPlan) throw new LibraryNotFoundError();
        const currentItems = await readItems(tx, owner, plan.sourceLabelId, plan.confirmationId, true),
          current = currentItems[item.itemNo];
        if (!current) throw new LibraryNotFoundError();
        if (current.status !== 'applying') return noEffect({ status: current.status });
        await tx.query(
          `UPDATE library.label_consolidation_item SET status=$5,stage=NULL,
             target_result_id=COALESCE($6::uuid,target_result_id),
             target_result_revision=COALESCE($7::integer,target_result_revision),
             target_unchanged=COALESCE($8::boolean,target_unchanged),
             source_result_revision=$9,updated_at=$10::timestamptz,transaction_id=$11
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=$4 AND status='applying'`,
          [
            route,
            owner.accountId,
            plan.confirmationId,
            item.itemNo,
            status,
            target?.id ?? null,
            target?.revision ?? null,
            target?.unchanged ?? null,
            sourceRevision ?? null,
            now,
            command.transactionId,
          ],
        );
        const nextItem = Math.max(currentPlan.nextItem, item.itemNo + 1),
          complete = nextItem >= currentPlan.itemCount;
        await tx.query(
          `UPDATE library.label_consolidation SET next_item=$4,
             status=CASE WHEN status='active' AND $5::boolean THEN 'completed' ELSE status END,
             terminal_at=CASE WHEN status='active' AND $5::boolean THEN $6::timestamptz ELSE terminal_at END,
             updated_at=$6::timestamptz,transaction_id=$7
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3`,
          [route, owner.accountId, plan.confirmationId, nextItem, complete, now, command.transactionId],
        );
        return noEffect({ status, nextItem, complete });
      },
    );
  }

  async function currentBindings(
    owner: AccountActor,
    plan: Plan,
    item: PlanItem,
    time: Awaited<ReturnType<typeof currentTime>>,
    deadline: number,
  ) {
    const readable = await withRequestDeadline(deadline, () => resolveSubject(deps, owner, item.subjectId, time));
    if (readable?.subjectId !== item.subjectId) return 'inaccessible' as const;
    return snapshot(owner, deadline, async (client, route) => {
      const source = await readPersonalLabel(client, route, owner.accountId, plan.sourceLabelId),
        target = await readPersonalLabel(client, route, owner.accountId, plan.targetLabelId);
      if (
        !source ||
        !target ||
        source.revision !== plan.sourceLabelRevision ||
        target.revision !== plan.targetLabelRevision
      )
        return 'changed' as const;
      const tuple = { route, accountId: owner.accountId, subjectId: item.subjectId },
        currentSource = observation(await readStoredLabelAssignment(client, { ...tuple, labelId: plan.sourceLabelId })),
        targetRows = await reservations.run(
          { query: client.query.bind(client) },
          { route, account_id: owner.accountId, subject_id: item.subjectId, label_id: plan.targetLabelId },
        ),
        currentTarget = observation(targetRows.find((row) => row.desired)),
        expectedTarget =
          item.targetAssignmentId === null
            ? null
            : { id: item.targetAssignmentId, revision: item.targetRevision!, effective: item.targetEffective! };
      if (
        !currentSource ||
        currentSource.id !== item.sourceAssignmentId ||
        currentSource.revision !== item.sourceRevision ||
        !currentSource.effective ||
        !same(currentTarget, expectedTarget)
      )
        return 'changed' as const;
      return 'current' as const;
    });
  }

  async function finishKnown(
    owner: AccountActor,
    plan: Plan,
    item: PlanItem,
    status: Exclude<ItemStatus, 'pending' | 'applying' | 'moved' | 'target_applied_source_retained'>,
  ) {
    return finishItem(owner, plan, item, status, `${item.targetRequestKey}:finish`);
  }

  async function executeItem(owner: AccountActor, plan: Plan, itemNo: number) {
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const initial = await snapshot(owner, deadline, async (client) => ({
      plan: await readPlan(client, owner, plan.sourceLabelId, plan.confirmationId, clock().toISOString()),
      items: await readItems(client, owner, plan.sourceLabelId, plan.confirmationId),
    }));
    if (!initial.plan) throw new LibraryNotFoundError();
    const initialItem = initial.items[itemNo];
    if (!initialItem) throw new LibraryNotFoundError();
    let item = initialItem;
    if (item.status !== 'applying') return;
    const currentPlan = initial.plan;

    if (item.stage === 'target_pending') {
      const time = await currentTime(owner, deadline);
      try {
        const bindings = await currentBindings(owner, currentPlan, item, time, deadline);
        if (bindings !== 'current') {
          await finishKnown(owner, currentPlan, item, bindings);
          return;
        }
      } finally {
        releaseOperationalTime(time);
      }
      const started = await updateStage(owner, currentPlan, item, 'target_started', `${item.targetRequestKey}:start`);
      if (!started.value.updated) return;
      item = { ...item, stage: 'target_started' };
    }

    if (item.stage === 'target_started') {
      let assigned: { id: string; revision: number; unchanged: boolean };
      try {
        const outcome = await assignmentCommands.assignLabelForConsolidation(
          owner,
          currentPlan.targetLabelId,
          { subjectId: item.subjectId },
          currentPlan.targetLabelRevision,
          {
            labelId: currentPlan.sourceLabelId,
            assignmentId: item.sourceAssignmentId,
            revision: item.sourceRevision,
            labelRevision: currentPlan.sourceLabelRevision,
          },
          item.targetAssignmentId === null
            ? null
            : { id: item.targetAssignmentId, revision: item.targetRevision!, effective: item.targetEffective! },
          item.targetRequestKey,
        );
        assigned = {
          id: outcome.value.assignment.id,
          revision: outcome.value.assignment.revision,
          unchanged: outcome.value.unchanged,
        };
      } catch (error) {
        if (error instanceof GrantDeniedError || error instanceof LibraryNotFoundError) {
          await finishKnown(owner, currentPlan, item, 'inaccessible');
          return;
        }
        if (error instanceof LibraryConflictError) {
          await finishKnown(owner, currentPlan, item, 'changed');
          return;
        }
        if (error instanceof ProblemError && error.code === 'library_label_capacity') {
          await finishKnown(owner, currentPlan, item, 'capacity_limited');
          return;
        }
        throw error;
      }
      const accepted = await updateStage(
        owner,
        currentPlan,
        item,
        'target_accepted',
        `${item.targetRequestKey}:accepted`,
        assigned,
      );
      if (!accepted.value.updated) return;
      item = {
        ...item,
        stage: 'target_accepted',
        targetResultId: assigned.id,
        targetResultRevision: assigned.revision,
        targetUnchanged: assigned.unchanged,
      };
    }

    if (item.stage === 'target_accepted') {
      const time = await currentTime(owner, deadline);
      try {
        const readable = await withRequestDeadline(deadline, () => resolveSubject(deps, owner, item.subjectId, time));
        if (readable?.subjectId !== item.subjectId) {
          await finishItem(
            owner,
            currentPlan,
            item,
            'target_applied_source_retained',
            `${item.sourceRequestKey}:finish`,
            {
              id: item.targetResultId!,
              revision: item.targetResultRevision!,
              unchanged: item.targetUnchanged!,
            },
          );
          return;
        }
        const labels = await snapshot(owner, deadline, async (client, route) => {
          const source = await readPersonalLabel(client, route, owner.accountId, currentPlan.sourceLabelId),
            target = await readPersonalLabel(client, route, owner.accountId, currentPlan.targetLabelId),
            currentSource = observation(
              await readStoredLabelAssignment(client, {
                route,
                accountId: owner.accountId,
                subjectId: item.subjectId,
                labelId: currentPlan.sourceLabelId,
              }),
            ),
            currentTarget = observation(
              await readStoredLabelAssignment(client, {
                route,
                accountId: owner.accountId,
                subjectId: item.subjectId,
                labelId: currentPlan.targetLabelId,
              }),
            );
          return {
            usable:
              !!source &&
              !!target &&
              source.revision === currentPlan.sourceLabelRevision &&
              target.revision === currentPlan.targetLabelRevision &&
              currentSource?.id === item.sourceAssignmentId &&
              currentSource.revision === item.sourceRevision &&
              currentSource.effective &&
              currentTarget?.id === item.targetResultId &&
              currentTarget.revision === item.targetResultRevision &&
              currentTarget.effective,
          };
        });
        if (!labels.usable) {
          await finishItem(
            owner,
            currentPlan,
            item,
            'target_applied_source_retained',
            `${item.sourceRequestKey}:finish`,
            {
              id: item.targetResultId!,
              revision: item.targetResultRevision!,
              unchanged: item.targetUnchanged!,
            },
          );
          return;
        }
      } finally {
        releaseOperationalTime(time);
      }
      const started = await updateStage(owner, currentPlan, item, 'source_started', `${item.sourceRequestKey}:start`, {
        id: item.targetResultId!,
        revision: item.targetResultRevision!,
        unchanged: item.targetUnchanged!,
      });
      if (!started.value.updated) {
        await finishItem(
          owner,
          currentPlan,
          item,
          'target_applied_source_retained',
          `${item.sourceRequestKey}:finish`,
          {
            id: item.targetResultId!,
            revision: item.targetResultRevision!,
            unchanged: item.targetUnchanged!,
          },
        );
        return;
      }
      item = { ...item, stage: 'source_started' };
    }

    if (item.stage === 'source_started') {
      try {
        const outcome = await assignmentCommands.unassignLabelAtRevision(
          owner,
          currentPlan.sourceLabelId,
          { subjectId: item.subjectId, assignmentId: item.sourceAssignmentId, revision: item.sourceRevision },
          currentPlan.sourceLabelRevision,
          item.sourceRequestKey,
          {
            labelId: currentPlan.targetLabelId,
            assignmentId: item.targetResultId!,
            revision: item.targetResultRevision!,
            labelRevision: currentPlan.targetLabelRevision,
          },
        );
        await finishItem(
          owner,
          currentPlan,
          item,
          'moved',
          `${item.sourceRequestKey}:finish`,
          {
            id: item.targetResultId!,
            revision: item.targetResultRevision!,
            unchanged: item.targetUnchanged!,
          },
          outcome.value.revision,
        );
      } catch (error) {
        if (
          error instanceof GrantDeniedError ||
          error instanceof LibraryNotFoundError ||
          error instanceof LibraryConflictError
        ) {
          await finishItem(
            owner,
            currentPlan,
            item,
            'target_applied_source_retained',
            `${item.sourceRequestKey}:finish`,
            {
              id: item.targetResultId!,
              revision: item.targetResultRevision!,
              unchanged: item.targetUnchanged!,
            },
          );
          return;
        }
        throw error;
      }
    }
  }

  async function beginApply(ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string, key: string) {
    const owner = actor(ownerActor, 'library_entry:update'),
      sourceLabelId = id(sourceLabelIdValue),
      confirmationId = id(confirmationIdValue, false),
      deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    actor(ownerActor, 'library_entry:read');
    await gate(owner, 'library_entry:update', deadline);
    const operation = await runner.ownAccount(
      owner,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_apply',
        requestKey: key,
        input: { sourceLabelId, confirmationId },
      },
      async (tx, command) => {
        const now = authoritativeTimeValue(command.time),
          plan = await readPlan(tx, owner, sourceLabelId, confirmationId, now, true);
        if (!plan || plan.status !== 'active') throw new LibraryNotFoundError();
        const items = await readItems(tx, owner, sourceLabelId, confirmationId, true);
        if (plan.nextItem >= plan.itemCount) throw new LibraryConflictError();
        const current = items[plan.nextItem];
        if (!current || current.status !== 'pending') throw new LibraryConflictError();
        await tx.query(
          `UPDATE library.label_consolidation_item SET status='applying',stage='target_pending',
           updated_at=$5::timestamptz,transaction_id=$6
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND item_no=$4 AND status='pending'`,
          [
            sameAccountRoute(owner.accountId, sourceLabelId),
            owner.accountId,
            confirmationId,
            current.itemNo,
            now,
            command.transactionId,
          ],
        );
        return noEffect({ confirmationId, item: current.itemNo });
      },
    );
    return { operation, result: await runAndRead(owner, sourceLabelId, confirmationId, operation.value.item) };
  }

  async function beginRetry(
    ownerActor: Actor,
    sourceLabelIdValue: string,
    confirmationIdValue: string,
    itemNoValue: number,
    key: string,
  ) {
    const owner = actor(ownerActor, 'library_entry:update'),
      sourceLabelId = id(sourceLabelIdValue),
      confirmationId = id(confirmationIdValue, false),
      itemNo = itemNoValue,
      deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    actor(ownerActor, 'library_entry:read');
    if (!Number.isInteger(itemNo) || itemNo < 0 || itemNo >= LABEL_CONSOLIDATION_LIMITS.selection) throw invalid();
    await gate(owner, 'library_entry:update', deadline);
    const operation = await runner.ownAccount(
      owner,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_retry',
        requestKey: key,
        input: { sourceLabelId, confirmationId, item: itemNo },
      },
      async (tx, command) => {
        const plan = await readPlan(
            tx,
            owner,
            sourceLabelId,
            confirmationId,
            authoritativeTimeValue(command.time),
            true,
          ),
          item = (await readItems(tx, owner, sourceLabelId, confirmationId, true))[itemNo];
        if (!plan || !item || item.status !== 'applying') throw new LibraryConflictError();
        return noEffect({ confirmationId, item: itemNo });
      },
    );
    return { operation, result: await runAndRead(owner, sourceLabelId, confirmationId, itemNo) };
  }

  async function runAndRead(owner: AccountActor, sourceLabelId: string, confirmationId: string, itemNo: number) {
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS),
      current = await snapshot(owner, deadline, async (client) => ({
        plan: await readPlan(client, owner, sourceLabelId, confirmationId, clock().toISOString()),
        items: await readItems(client, owner, sourceLabelId, confirmationId),
      }));
    if (!current.plan) throw new LibraryNotFoundError();
    const item = current.items[itemNo];
    if (item?.status === 'applying') await executeItem(owner, current.plan, itemNo);
    return result(owner, sourceLabelId, confirmationId);
  }

  async function cancel(ownerActor: Actor, sourceLabelIdValue: string, confirmationIdValue: string, key: string) {
    const owner = actor(ownerActor, 'library_entry:update'),
      sourceLabelId = id(sourceLabelIdValue),
      confirmationId = id(confirmationIdValue, false),
      deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    actor(ownerActor, 'library_entry:read');
    await gate(owner, 'library_entry:update', deadline);
    const operation = await runner.ownAccount(
      owner,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_cancel',
        requestKey: key,
        input: { sourceLabelId, confirmationId },
      },
      async (tx, command) => {
        const now = authoritativeTimeValue(command.time),
          plan = await readPlan(tx, owner, sourceLabelId, confirmationId, now, true);
        if (!plan) throw new LibraryNotFoundError();
        if (plan.status !== 'active') return noEffect({ confirmationId, status: plan.status });
        await tx.query(
          `UPDATE library.label_consolidation_item SET status='pending',stage=NULL,
             updated_at=$4::timestamptz,transaction_id=$5
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND status='applying' AND stage='target_pending'`,
          [
            sameAccountRoute(owner.accountId, sourceLabelId),
            owner.accountId,
            confirmationId,
            now,
            command.transactionId,
          ],
        );
        await tx.query(
          `UPDATE library.label_consolidation SET status='cancelled',terminal_at=$4::timestamptz,
           updated_at=$4::timestamptz,transaction_id=$5
           WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND status='active'`,
          [
            sameAccountRoute(owner.accountId, sourceLabelId),
            owner.accountId,
            confirmationId,
            now,
            command.transactionId,
          ],
        );
        return noEffect({ confirmationId, status: 'cancelled' as const });
      },
    );
    return { operation, result: await result(owner, sourceLabelId, confirmationId) };
  }

  async function result(
    ownerActor: Actor,
    sourceLabelIdValue: string,
    confirmationIdValue: string,
  ): Promise<LabelConsolidationResult> {
    const owner = actor(ownerActor, 'library_entry:read'),
      sourceLabelId = id(sourceLabelIdValue),
      confirmationId = id(confirmationIdValue, false),
      deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    await gate(owner, 'library_entry:read', deadline);
    const time = await currentTime(owner, deadline);
    try {
      const at = authoritativeTimeValue(time);
      const before = await snapshot(owner, deadline, async (client) => ({
        plan: await readPlan(client, owner, sourceLabelId, confirmationId, at),
        items: await readItems(client, owner, sourceLabelId, confirmationId),
      }));
      if (!before.plan) throw new LibraryNotFoundError();
      const accessible = new Set<string>();
      for (const item of before.items) {
        const resolved = await withRequestDeadline(deadline, () => resolveSubject(deps, owner, item.subjectId, time));
        if (resolved?.subjectId === item.subjectId) accessible.add(item.subjectId);
      }
      return snapshot(owner, deadline, async (client) => {
        const plan = await readPlan(client, owner, sourceLabelId, confirmationId, at),
          items = await readItems(client, owner, sourceLabelId, confirmationId);
        if (!plan) throw new LibraryNotFoundError();
        return {
          confirmationId,
          sourceLabelId: plan.sourceLabelId,
          targetLabelId: plan.targetLabelId,
          status: plan.status,
          expiresAt: plan.expiresAt,
          items: items.map((item) => {
            if (!accessible.has(item.subjectId)) return { item: item.itemNo, status: 'inaccessible' as const };
            return {
              item: item.itemNo,
              selected: {
                subjectId: item.subjectId,
                assignmentId: item.sourceAssignmentId,
                revision: item.sourceRevision,
              },
              status: item.status === 'applying' ? ('processing' as const) : item.status,
              ...(item.targetResultId && item.targetResultRevision
                ? { targetAssignment: { id: item.targetResultId, revision: item.targetResultRevision } }
                : {}),
              ...(item.targetUnchanged === null ? {} : { targetUnchanged: item.targetUnchanged }),
              ...(item.sourceResultRevision === null ? {} : { sourceUnassignRevision: item.sourceResultRevision }),
            };
          }),
        };
      });
    } finally {
      releaseOperationalTime(time);
    }
  }

  return { confirm, apply: beginApply, retry: beginRetry, cancel, result };
}

/** Scheduled native expiry cleanup. One ordered due-index page per owner partition; parent cascade removes <=16 items. */
export async function purgeExpiredLabelConsolidations(
  { pool, clock = systemClock }: { pool: Pool; clock?: KernelClock },
  { partition, limit, after }: { partition: number; limit: number; after: string | null },
) {
  if (!Number.isInteger(partition) || partition < 0 || partition >= 4096) throw new RangeError('Invalid partition');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid page limit');
  const deadline = workStepDeadline();
  type Cursor = {
    version: 1;
    partition: number;
    route: number;
    cutoff: string;
    last: { expiresAt: string; accountId: string; confirmationId: string } | null;
  };
  const decode = (value: string | null): Cursor => {
    if (value === null)
      return {
        version: 1,
        partition,
        route: partition * 16,
        cutoff: (clock?.() ?? systemClock()).toISOString(),
        last: null,
      };
    if (Buffer.byteLength(value) > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new TypeError('Invalid expiry cursor');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as Cursor;
    if (
      parsed?.version !== 1 ||
      parsed.partition !== partition ||
      !Number.isInteger(parsed.route) ||
      parsed.route < partition * 16 ||
      parsed.route >= (partition + 1) * 16 ||
      typeof parsed.cutoff !== 'string' ||
      !Number.isFinite(Date.parse(parsed.cutoff)) ||
      (parsed.last !== null &&
        (!parsed.last ||
          typeof parsed.last !== 'object' ||
          typeof parsed.last.expiresAt !== 'string' ||
          !Number.isFinite(Date.parse(parsed.last.expiresAt)) ||
          typeof parsed.last.accountId !== 'string' ||
          !uuid.test(parsed.last.accountId) ||
          routeOf(parsed.last.accountId) !== parsed.route ||
          typeof parsed.last.confirmationId !== 'string' ||
          !uuid.test(parsed.last.confirmationId)))
    )
      throw new TypeError('Invalid expiry cursor');
    return parsed;
  };
  const cursor = decode(after);
  let examined = 0,
    removed = 0;
  while (cursor.route < (partition + 1) * 16 && examined < limit && Date.now() < deadline - 100) {
    const requested = limit - examined;
    const page = await pool.query<{
      route: number;
      accountId: string;
      confirmationId: string;
      expiresAt: string;
    }>(
      `SELECT route,account_id AS "accountId",consolidation_id AS "confirmationId",expires_at::text AS "expiresAt"
       FROM library.label_consolidation
       WHERE route=$1 AND expires_at <= $2::timestamptz
         AND ($3::timestamptz IS NULL OR (expires_at,account_id,consolidation_id) > ($3::timestamptz,$4::uuid,$5::uuid))
       ORDER BY expires_at,account_id,consolidation_id LIMIT $6`,
      [
        cursor.route,
        cursor.cutoff,
        cursor.last?.expiresAt ?? null,
        cursor.last?.accountId ?? null,
        cursor.last?.confirmationId ?? null,
        requested,
      ],
    );
    if (page.rows.length === 0) {
      cursor.route++;
      cursor.last = null;
      continue;
    }
    let pageProcessed = 0;
    for (const row of page.rows) {
      examined++;
      pageProcessed++;
      cursor.last = {
        expiresAt: row.expiresAt,
        accountId: row.accountId,
        confirmationId: row.confirmationId,
      };
      try {
        const outcome = await runCommand(
          pool,
          {
            partition,
            deadline,
            clock,
            authorization: {
              action: 'library:label-retention-maintenance',
              resource: { route: row.route, id: row.accountId },
              denied: () => new LifecycleDeniedError(),
              async authorize(tx) {
                await shareAccount(tx, row.accountId);
                return 'execute';
              },
            },
          },
          async (tx, command) => {
            const deleted = await tx.query(
              `DELETE FROM library.label_consolidation
               WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND expires_at <= $4::timestamptz
               RETURNING consolidation_id`,
              [row.route, row.accountId, row.confirmationId, authoritativeTimeValue(command.time)],
            );
            return noEffect({ removed: deleted.rows.length > 0 });
          },
        );
        if (outcome.value.removed) removed++;
      } catch (error) {
        if (!(error instanceof LifecycleDeniedError)) throw error;
      }
      if (examined >= limit || Date.now() >= deadline - 100) break;
    }
    if (pageProcessed === page.rows.length && page.rows.length < requested) {
      cursor.route++;
      cursor.last = null;
    }
  }
  const next = cursor.route >= (partition + 1) * 16 ? null : Buffer.from(JSON.stringify(cursor)).toString('base64url');
  if (next && Buffer.byteLength(next) > 2048)
    throw new RangeError('Label consolidation expiry cursor exceeds its bound');
  return { examined, removed, next };
}
