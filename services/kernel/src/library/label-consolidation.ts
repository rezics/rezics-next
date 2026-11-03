import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import {
  authoritativeTimeValue,
  mintReadTime,
  releaseOperationalTime,
  noEffect,
  type CommandOutcome,
} from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, sameAccountRoute } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { lockLabelAssignmentSubject } from './label-assignment-store.ts';
import { createLabelAssignmentCommands } from './label-assignment-commands.ts';
import { createLabelConsolidationReview } from './label-consolidation-review.ts';
import {
  assertConsolidationItem,
  consolidationDigest,
  consolidationSubject,
  type ConsolidationBinding,
  type ConsolidationEvidence,
  type ConsolidationGuard,
} from './label-consolidation-binding.ts';

export const LABEL_CONSOLIDATION_LIMITS = Object.freeze({
  selection: 16,
  lifetimeMs: 15 * 60_000,
  bytes: 32768,
  perOwner: 1,
});
type Dependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: KernelClock;
  onCommand?: (outcome: CommandOutcome<unknown>) => void;
};
type Client = Pick<PoolClient, 'query'>;
type Stored = { payload: ConsolidationBinding; expires_at: string };
export type LabelConsolidationResult = {
  id: string;
  digest: string;
  expiresAt: string;
  state: 'selected' | 'confirmed' | 'cancelled' | 'complete';
  evidence: ConsolidationEvidence;
  operations: { assignKey: string; unassignKey: string }[];
  items: {
    ordinal: number;
    status: 'pending' | 'unknown' | 'target_accepted' | 'moved';
    target?: { id: string; revision: number };
    sourceUndo?: { assignmentId: string; revision: number };
  }[];
};
const invalid = () => new ProblemError('invalid_request');
function owner(actor: Actor): AccountActor {
  if (
    actor.kind !== 'account' ||
    routeOf(actor.accountId) === null ||
    !actor.scopes.includes('library_entry:read') ||
    !actor.scopes.includes('library_entry:update')
  )
    throw new GrantDeniedError();
  return actor;
}
function principal(actor: AccountActor, binding: ConsolidationBinding) {
  if (binding.clientId !== actor.clientId || binding.requestedBy !== (actor.requestedBy ?? null))
    throw new LibraryConflictError();
}

/** Finite owner-local composition. All fact effects remain the original native commands and receipts. */
export function createLabelConsolidation(deps: Dependencies) {
  const clock = deps.clock ?? systemClock;
  const runner = createLibraryCommandRunner(deps);
  const native = createLabelAssignmentCommands(deps);
  const review = createLabelConsolidationReview(deps);
  async function gate(actor: AccountActor) {
    await admitGroup({
      ...deps,
      access: () => deps.access,
      actor,
      clock,
      deadline: deadlineFor(5000),
      group: 'personal_library',
      clientAction: 'library_entry:read',
    });
  }
  async function snapshot<T>(actor: AccountActor, body: (tx: Client) => Promise<T>) {
    return withConnection(deps.pool, async (tx) => {
      await tx.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(tx, routeOf(actor.accountId)!, actor.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(actor.authnEpoch) ||
          actor.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(actor.authnEpoch)
        )
          throw new GrantDeniedError();
        const result = await body(tx);
        await tx.query('COMMIT');
        return result;
      } catch (error) {
        await tx.query('ROLLBACK');
        throw error;
      }
    });
  }
  async function load(tx: Client, actor: AccountActor, id: string, time: string, lock = false): Promise<Stored> {
    sameAccountRoute(actor.accountId, id);
    const row = (
      await tx.query<Stored>(
        `SELECT payload,expires_at::text FROM library.label_consolidation
       WHERE route=$1 AND account_id=$2 AND consolidation_id=$3 AND expires_at>$4::timestamptz${lock ? ' FOR UPDATE' : ''}`,
        [routeOf(actor.accountId), actor.accountId, id, time],
      )
    ).rows[0];
    if (!row) throw new LibraryNotFoundError();
    principal(actor, row.payload);
    return row;
  }
  async function read(actor: AccountActor, id: string) {
    await gate(actor);
    return snapshot(actor, async (tx) => {
      const time = await mintReadTime(tx, clock);
      try {
        return await load(tx, actor, id, authoritativeTimeValue(time));
      } finally {
        releaseOperationalTime(time);
      }
    });
  }
  async function save(tx: Client, actor: AccountActor, binding: ConsolidationBinding) {
    const encoded = JSON.stringify(binding);
    if (Buffer.byteLength(encoded) > LABEL_CONSOLIDATION_LIMITS.bytes) throw invalid();
    await tx.query(
      'UPDATE library.label_consolidation SET payload=$4::jsonb WHERE route=$1 AND account_id=$2 AND consolidation_id=$3',
      [routeOf(actor.accountId), actor.accountId, binding.id, encoded],
    );
  }
  function guard(
    binding: ConsolidationBinding,
    ordinal: number,
    phase: ConsolidationGuard['phase'],
    target?: ConsolidationGuard['target'],
    receiptOnly = false,
  ): ConsolidationGuard {
    return {
      id: binding.id,
      digest: binding.digest,
      ordinal,
      phase,
      binding,
      ...(target ? { target } : {}),
      receiptOnly,
    };
  }
  async function change(
    actor: AccountActor,
    id: string,
    kind: string,
    key: string,
    input: unknown,
    body: (binding: ConsolidationBinding) => void,
  ) {
    await gate(actor);
    const outcome = await runner.ownAccount(
      actor,
      {
        action: 'library_entry:update',
        kind: `library_label.consolidation_${kind}`,
        requestKey: key,
        input: { id, input },
      },
      async (tx, command) => {
        const row = await load(tx, actor, id, authoritativeTimeValue(command.time), true);
        body(row.payload);
        await save(tx, actor, row.payload);
        return noEffect({ id });
      },
    );
    deps.onCommand?.(outcome);
    return outcome;
  }

  async function select(actor: Actor, sourceLabelId: string, evidence: ConsolidationEvidence, key: string) {
    const account = owner(actor);
    if (
      !evidence ||
      !Array.isArray(evidence.items) ||
      !evidence.items.length ||
      evidence.items.length > 16 ||
      Buffer.byteLength(JSON.stringify(evidence)) > LABEL_CONSOLIDATION_LIMITS.bytes ||
      evidence.sourceLabel?.id !== sourceLabelId ||
      !evidence.targetLabel?.id
    )
      throw invalid();
    const items = evidence.items.map((i) => i.selected);
    await gate(account);
    const selected = await runner.ownAccountPrepared(
      account,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_select',
        requestKey: key,
        input: { sourceLabelId, evidence },
        async prepare(attempt) {
          try {
            const observed: ConsolidationEvidence = {
              sourceLabel: evidence.sourceLabel,
              targetLabel: evidence.targetLabel,
              items: [],
            };
            let cursor: string | undefined;
            do {
              const page = await review(account, sourceLabelId, {
                targetLabelId: evidence.targetLabel.id,
                items,
                limit: 4,
                ...(cursor ? { cursor } : {}),
              });
              observed.sourceLabel = page.sourceLabel;
              observed.targetLabel = page.targetLabel;
              observed.items.push(...page.items);
              cursor = page.next ?? undefined;
            } while (cursor);
            if (
              consolidationDigest(observed) !== consolidationDigest(evidence) ||
              observed.items.some((i) => i.outcome !== 'movable' && i.outcome !== 'already_on_target')
            )
              throw new LibraryConflictError();
            const subjects: string[] = [];
            for (const item of items)
              subjects.push(await consolidationSubject(deps, account, item.subjectId, attempt.time));
            return { subjects };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if (prepared.error !== undefined) throw prepared.error;
        const route = routeOf(account.accountId)!;
        const id = newId(route);
        const binding: ConsolidationBinding = {
          id,
          clientId: account.clientId,
          requestedBy: account.requestedBy ?? null,
          evidence,
          digest: '',
          confirmed: false,
          cancelled: false,
          items: evidence.items.map((item, i) => ({
            evidence: item,
            subject: prepared.subjects![i]!,
            assignKey: randomUUID(),
            unassignKey: randomUUID(),
          })),
        };
        binding.digest = consolidationDigest([id, binding.clientId, binding.requestedBy, evidence, binding.items]);
        // Acquire every subject guard before the first parent lock, in the native canonical order.
        for (const subjectId of items.map((i) => i.subjectId).sort())
          await lockLabelAssignmentSubject(tx, { route, accountId: account.accountId, subjectId });
        for (let ordinal = 0; ordinal < binding.items.length; ordinal++)
          await assertConsolidationItem(tx, account, binding, ordinal, 'assign');
        const expiresAt = new Date(
          Date.parse(authoritativeTimeValue(command.time)) + LABEL_CONSOLIDATION_LIMITS.lifetimeMs,
        ).toISOString();
        const inserted = await tx.query(
          `INSERT INTO library.label_consolidation(route,account_id,consolidation_id,expires_at,payload)
         VALUES($1,$2,$3,$4::timestamptz,$5::jsonb) ON CONFLICT(route,account_id) DO NOTHING RETURNING consolidation_id`,
          [route, account.accountId, id, expiresAt, JSON.stringify(binding)],
        );
        if (!inserted.rowCount) throw new LibraryConflictError();
        return noEffect({ id, digest: binding.digest, expiresAt });
      },
    );
    deps.onCommand?.(selected);
    // Original receipts never recreate a selection erased or expired after its capture.
    await read(account, selected.value.id);
    return selected;
  }

  async function confirm(actor: Actor, id: string, digest: string, key: string) {
    const account = owner(actor),
      row = await read(account, id),
      binding = row.payload;
    if (digest !== binding.digest) throw new LibraryConflictError();
    await gate(account);
    const confirmed = await runner.ownAccountPrepared(
      account,
      {
        action: 'library_entry:update',
        kind: 'library_label.consolidation_confirm',
        requestKey: key,
        input: { id, digest },
        async prepare(attempt) {
          try {
            for (const item of binding.items)
              if (
                (await consolidationSubject(deps, account, item.evidence.selected.subjectId, attempt.time)) !==
                item.subject
              )
                throw new LibraryConflictError();
            return {};
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if (prepared.error !== undefined) throw prepared.error;
        const current = (await load(tx, account, id, authoritativeTimeValue(command.time), true)).payload;
        if (current.cancelled || current.digest !== digest) throw new LibraryConflictError();
        for (const subjectId of current.items.map((i) => i.evidence.selected.subjectId).sort())
          await lockLabelAssignmentSubject(tx, {
            route: routeOf(account.accountId)!,
            accountId: account.accountId,
            subjectId,
          });
        for (let ordinal = 0; ordinal < current.items.length; ordinal++)
          await assertConsolidationItem(tx, account, current, ordinal, 'assign');
        current.confirmed = true;
        await save(tx, account, current);
        return noEffect({ id, digest, confirmed: true as const });
      },
    );
    deps.onCommand?.(confirmed);
    return confirmed;
  }

  async function record(
    actor: AccountActor,
    binding: ConsolidationBinding,
    ordinal: number,
    phase: 'assign' | 'unassign',
    value: { id: string; revision: number } | number,
  ) {
    const item = binding.items[ordinal]!;
    return change(
      actor,
      binding.id,
      `${phase}_result`,
      (phase === 'assign' ? item.assignKey : item.unassignKey) + ':result',
      { ordinal, value },
      (current) => {
        if (current.digest !== binding.digest) throw new LibraryConflictError();
        const selected = current.items[ordinal]!;
        if (phase === 'assign') selected.target = value as { id: string; revision: number };
        else selected.removedRevision = value as number;
      },
    );
  }

  /** Receipt-only calls may recover accepted partial results after cancellation; their fresh bodies always fail. */
  async function recover(account: AccountActor, binding: ConsolidationBinding) {
    for (let ordinal = 0; ordinal < binding.items.length; ordinal++) {
      const item = binding.items[ordinal]!;
      if (!item.started || item.removedRevision !== undefined) continue;
      if (!item.target) {
        try {
          const outcome = await native.assignLabel(
            account,
            binding.evidence.targetLabel.id,
            { subjectId: item.evidence.selected.subjectId },
            item.assignKey,
            undefined,
            guard(binding, ordinal, 'assign', undefined, true),
          );
          deps.onCommand?.(outcome);
          await record(account, binding, ordinal, 'assign', outcome.value.assignment);
          item.target = outcome.value.assignment;
        } catch (error) {
          if (!(error instanceof LibraryConflictError)) throw error;
        }
      }
      if (item.target) {
        try {
          const outcome = await native.unassignLabel(
            account,
            binding.evidence.sourceLabel.id,
            item.evidence.selected,
            item.unassignKey,
            guard(binding, ordinal, 'unassign', item.target, true),
          );
          deps.onCommand?.(outcome);
          await record(account, binding, ordinal, 'unassign', outcome.value.revision);
          item.removedRevision = outcome.value.revision;
        } catch (error) {
          if (!(error instanceof LibraryConflictError)) throw error;
        }
      }
    }
  }
  function resultOf(row: Stored): LabelConsolidationResult {
    const b = row.payload;
    return {
      id: b.id,
      digest: b.digest,
      expiresAt: new Date(row.expires_at).toISOString(),
      state: b.cancelled
        ? 'cancelled'
        : b.items.every((i) => i.removedRevision !== undefined)
          ? 'complete'
          : b.confirmed
            ? 'confirmed'
            : 'selected',
      evidence: b.evidence,
      operations: b.items.map((i) => ({ assignKey: i.assignKey, unassignKey: i.unassignKey })),
      items: b.items.map((item, ordinal) => ({
        ordinal,
        status:
          item.removedRevision !== undefined
            ? 'moved'
            : item.target
              ? 'target_accepted'
              : item.started
                ? 'unknown'
                : 'pending',
        ...(item.target ? { target: item.target } : {}),
        ...(item.removedRevision === undefined
          ? {}
          : { sourceUndo: { assignmentId: item.evidence.selected.assignmentId, revision: item.removedRevision } }),
      })),
    };
  }
  async function result(actor: Actor, id: string) {
    const account = owner(actor),
      row = await read(account, id);
    await recover(account, row.payload);
    // Re-admit every selected Subject before exposing retained assignment evidence or original receipts.
    const time = await snapshot(account, (tx) => mintReadTime(tx, clock));
    try {
      for (const item of row.payload.items)
        await consolidationSubject(deps, account, item.evidence.selected.subjectId, time);
    } finally {
      releaseOperationalTime(time);
    }
    await gate(account);
    return resultOf(await read(account, id));
  }
  async function apply(actor: Actor, id: string, ordinal: number, signal?: AbortSignal) {
    const account = owner(actor);
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 16) throw invalid();
    const row = await read(account, id),
      binding = row.payload,
      item = binding.items[ordinal];
    if (!item || !binding.confirmed) throw new LibraryConflictError();
    if (binding.cancelled || item.removedRevision !== undefined) return result(actor, id);
    signal?.throwIfAborted();
    await change(account, id, 'start', item.assignKey + ':start', { ordinal, digest: binding.digest }, (current) => {
      if (
        current.cancelled ||
        !current.confirmed ||
        current.digest !== binding.digest ||
        current.items.slice(0, ordinal).some((i) => i.removedRevision === undefined)
      )
        throw new LibraryConflictError();
      current.items[ordinal]!.started = true;
    });
    signal?.throwIfAborted();
    const assigned = await native.assignLabel(
      account,
      binding.evidence.targetLabel.id,
      { subjectId: item.evidence.selected.subjectId },
      item.assignKey,
      undefined,
      guard(binding, ordinal, 'assign'),
    );
    deps.onCommand?.(assigned);
    await record(account, binding, ordinal, 'assign', assigned.value.assignment);
    signal?.throwIfAborted();
    const removed = await native.unassignLabel(
      account,
      binding.evidence.sourceLabel.id,
      item.evidence.selected,
      item.unassignKey,
      guard(binding, ordinal, 'unassign', assigned.value.assignment),
    );
    deps.onCommand?.(removed);
    await record(account, binding, ordinal, 'unassign', removed.value.revision);
    return result(actor, id);
  }
  async function cancel(actor: Actor, id: string, key: string) {
    const account = owner(actor);
    await change(account, id, 'cancel', key, {}, (current) => {
      current.cancelled = true;
    });
    return result(actor, id);
  }
  async function remove(actor: Actor, id: string, key: string) {
    const account = owner(actor);
    await gate(account);
    const outcome = await runner.ownAccount(
      account,
      { action: 'library_entry:update', kind: 'library_label.consolidation_remove', requestKey: key, input: { id } },
      async (tx) => {
        sameAccountRoute(account.accountId, id);
        await tx.query(
          'DELETE FROM library.label_consolidation WHERE route=$1 AND account_id=$2 AND consolidation_id=$3',
          [routeOf(account.accountId), account.accountId, id],
        );
        return noEffect({ deleted: true as const });
      },
    );
    deps.onCommand?.(outcome);
    return outcome;
  }
  return { select, confirm, apply, result, cancel, remove };
}
