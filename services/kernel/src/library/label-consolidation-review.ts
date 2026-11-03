import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { mintReadTime, releaseOperationalTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { LibraryNotFoundError, sameAccountRoute, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import { LibraryConflictError } from './entries.ts';
import { readStoredLabelAssignment, type PrivateLabelAssignment } from './label-assignment-lifecycle-store.ts';
import reservations from './label-assignment-reservations.sql';
import parents from './label-consolidation-parents.sql';
import { readPersonalLabel } from './label-store.ts';
import { resolveSubject } from './subject-anchor.ts';

/** Independent of catalogue size, assignment history and deleted-parent cardinality. */
export const LABEL_CONSOLIDATION_REVIEW_LIMITS = Object.freeze({
  selection: 16,
  page: 4,
  requestBytes: 8192,
  responseBytes: 16384,
});
export type LabelConsolidationSelection = { subjectId: string; assignmentId: string; revision: number };
export type LabelConsolidationReviewInput = {
  targetLabelId: string;
  items: LabelConsolidationSelection[];
  limit?: number;
  cursor?: string;
};
type Label = { id: string; name: string; revision: number };
type Assignment = { id: string; revision: number; effective: boolean };
export type LabelConsolidationReviewItem = {
  selected: LabelConsolidationSelection;
  source: Assignment | null;
  target: Assignment | null;
  outcome: 'movable' | 'already_on_target' | 'missing' | 'changed' | 'inaccessible' | 'capacity_limited';
};
export type LabelConsolidationReview = {
  selection: string;
  sourceLabel: Label;
  targetLabel: Label;
  items: LabelConsolidationReviewItem[];
  next: string | null;
};
type Client = Pick<PoolClient, 'query'>;
const invalid = () => new ProblemError('invalid_request');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((k) => !fields.includes(k)))
    throw invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown, routed = true): string {
  if (typeof value !== 'string' || !uuid.test(value) || (routed && routeOf(value) === null)) throw invalid();
  return value;
}
function parse(value: unknown): LabelConsolidationReviewInput & { limit: number } {
  const input = object(value, ['targetLabelId', 'items', 'limit', 'cursor']);
  if (!Array.isArray(input.items) || !input.items.length || input.items.length > LABEL_CONSOLIDATION_REVIEW_LIMITS.selection)
    throw invalid();
  const items = input.items.map((value) => {
    const item = object(value, ['subjectId', 'assignmentId', 'revision']);
    if (typeof item.revision !== 'number' || !Number.isInteger(item.revision) || item.revision < 1 || item.revision > 2147483646)
      throw invalid();
    return { subjectId: id(item.subjectId), assignmentId: id(item.assignmentId, false), revision: item.revision };
  });
  // A selected set fact has one addressed identity. Never process a subject twice under two expected revisions.
  if (new Set(items.map((item) => item.subjectId)).size !== items.length) throw invalid();
  const limit = input.limit ?? LABEL_CONSOLIDATION_REVIEW_LIMITS.page;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > LABEL_CONSOLIDATION_REVIEW_LIMITS.page)
    throw invalid();
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length > 4096)) throw invalid();
  const parsed = { targetLabelId: id(input.targetLabelId), items, limit, ...(input.cursor === undefined ? {} : { cursor: input.cursor as string }) };
  if (Buffer.byteLength(JSON.stringify(parsed)) > LABEL_CONSOLIDATION_REVIEW_LIMITS.requestBytes) throw invalid();
  return parsed;
}
const visibleLabel = (label: Label): Label => ({ id: label.id, name: label.name, revision: label.revision });
const inaccessible = (selected: LabelConsolidationSelection): LabelConsolidationReviewItem => ({
  selected, source: null, target: null, outcome: 'inaccessible',
});
function assignment(row: Pick<PrivateLabelAssignment, 'id' | 'revision' | 'slotNo' | 'deletedAt'> | undefined | null): Assignment | null {
  if (!row) return null;
  if (row.id === null || (row.deletedAt === null && row.slotNo === null)) throw new ProblemError('index_not_ready');
  return { id: row.id, revision: row.revision, effective: row.deletedAt === null && row.slotNo !== null };
}

/** Pure supplied-ID inspection. A review is advisory, never permission to execute a later write. */
export function createLabelConsolidationReview(deps: { pool: Pool; access: Access; tokens: KeyRing; clock?: KernelClock }) {
  const clock = deps.clock ?? systemClock;
  async function snapshot<T>(actor: AccountActor, deadline: number, body: (client: Client, route: number) => Promise<T>) {
    return withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline), route = routeOf(actor.accountId)!;
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(client, route, actor.accountId);
        if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced ||
            !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 || current.minimumAuthnEpoch > BigInt(actor.authnEpoch))
          throw new GrantDeniedError();
        const value = await body(client, route);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  return async function review(actor: Actor, sourceLabelId: string, value: LabelConsolidationReviewInput): Promise<LabelConsolidationReview> {
    if (actor.kind !== 'account' || routeOf(actor.accountId) === null ||
        !actor.scopes.includes('library_entry:read') || !actor.scopes.includes('library_entry:update')) throw new GrantDeniedError();
    const sourceId = id(sourceLabelId), input = parse(value);
    if (sourceId === input.targetLabelId) throw invalid();
    const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
    const gate = () => admitGroup({ ...deps, access: () => deps.access, actor, clock, deadline,
      group: 'personal_library', clientAction: 'library_entry:read' });
    async function labels(client: Client, route: number) {
      sameAccountRoute(actor.accountId, sourceId);
      sameAccountRoute(actor.accountId, input.targetLabelId);
      const source = await readPersonalLabel(client, route, actor.accountId, sourceId);
      const target = await readPersonalLabel(client, route, actor.accountId, input.targetLabelId);
      if (!source || !target) throw new LibraryNotFoundError();
      return { sourceLabel: visibleLabel(source), targetLabel: visibleLabel(target) };
    }
    // Authenticate the owner before private parent probes, cursors or Subject inspection.
    await snapshot(actor, deadline, async () => {});
    await gate();
    const selection = createHash('sha256').update(JSON.stringify([actor.accountId, sourceId, input.targetLabelId, input.items])).digest('hex');
    const binding = { route: 'library_label.consolidation_review', viewer: actor.accountId,
      query: { selection, limit: input.limit } };
    const page = await snapshot(actor, deadline, async (client, route) => {
      const current = await labels(client, route);
      const partition = await readPartition(client, partitionOf(route));
      if (!partition) throw new Error('Missing owner partition');
      let offset = 0;
      if (input.cursor !== undefined) {
        const cursor = await decodeListCursor(deps.tokens, binding, input.cursor, clock());
        if (!cursor.ok || cursor.after.length !== 2 || typeof cursor.after[0] !== 'number' || !Number.isInteger(cursor.after[0]) ||
            cursor.after[0] < 1 || cursor.after[0] >= input.items.length || typeof cursor.after[1] !== 'string')
          throw new ProblemError('invalid_cursor');
        if (cursor.epoch !== partition.epoch || cursor.after[1] !== partition.position.toString()) throw new ProblemError('stale_cursor');
        offset = cursor.after[0];
      }
      return { ...current, offset, epoch: partition.epoch, position: partition.position.toString(), time: await mintReadTime(client, clock) };
    });
    try {
      const selected = input.items.slice(page.offset, page.offset + input.limit);
      // Release the owner checkout before native Subject authority acquires its own partition readers.
      const readable = new Set<string>();
      for (const item of selected) {
        const resolved = await withRequestDeadline(deadline, () => resolveSubject(deps, actor, item.subjectId, page.time));
        if (resolved?.subjectId === item.subjectId) readable.add(item.subjectId);
      }
      const result = await snapshot(actor, deadline, async (client, route) => {
        const current = await labels(client, route);
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.epoch !== page.epoch || partition.position.toString() !== page.position)
          throw new ProblemError('stale_cursor');
        const items: LabelConsolidationReviewItem[] = [];
        for (const item of selected) {
          if (!readable.has(item.subjectId)) { items.push(inaccessible(item)); continue; }
          const tuple = { route, accountId: actor.accountId, subjectId: item.subjectId };
          const source = assignment(await readStoredLabelAssignment(client, { ...tuple, labelId: sourceId }));
          const rows = await reservations.run({ query: client.query.bind(client) }, {
            route, account_id: actor.accountId, subject_id: item.subjectId, label_id: input.targetLabelId,
          });
          const target = assignment(rows.find((row) => row.desired));
          let outcome: LabelConsolidationReviewItem['outcome'];
          if (!source) outcome = 'missing';
          else if (source.id !== item.assignmentId || source.revision !== item.revision) outcome = 'changed';
          else if (!source.effective) outcome = 'missing';
          else if (target?.effective) outcome = 'already_on_target';
          else {
            const reserved = rows.filter((row) => !row.desired);
            const states = await parents.run({ query: client.query.bind(client) }, {
              route, account_id: actor.accountId, label_ids: reserved.map((row) => row.labelId),
            });
            // Native assign can reuse at most ONE reservation whose parent is actually deleted.
            // An absent parent is not a reclaim witness, and reads never reclaim or renew expiry.
            const canAssign = reserved.length < 32 || states.some((parent) => !parent.live);
            outcome = canAssign ? 'movable' : 'capacity_limited';
          }
          items.push({ selected: item, source, target, outcome });
        }
        const offset = page.offset + selected.length;
        return { ...current, selection, items, next: offset < input.items.length
          ? await encodeListCursor(deps.tokens, binding, { epoch: page.epoch, after: [offset, page.position] }, clock()) : null };
      });
      await gate();
      for (let i = 0; i < result.items.length; i++) {
        const item = result.items[i]!;
        if (item.outcome === 'inaccessible') continue;
        const resolved = await withRequestDeadline(deadline, () => resolveSubject(deps, actor, item.selected.subjectId, page.time));
        if (resolved?.subjectId !== item.selected.subjectId) result.items[i] = inaccessible(item.selected);
      }
      await snapshot(actor, deadline, async (client, route) => {
        const current = await labels(client, route);
        if (current.sourceLabel.revision !== result.sourceLabel.revision || current.targetLabel.revision !== result.targetLabel.revision)
          throw new LibraryConflictError();
      });
      if (Buffer.byteLength(JSON.stringify(result)) > LABEL_CONSOLIDATION_REVIEW_LIMITS.responseBytes)
        throw new Error('Consolidation review exceeded its encoded response bound');
      return result;
    } finally {
      releaseOperationalTime(page.time);
    }
  };
}
