import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import { shareAccount } from '../access/account-share.ts';
import { authoritativeTimeValue, noEffect, runCommand } from '../command/command.ts';
import type { CommandOutcome } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import type { AccountActor, Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { newId, routeOf } from '../route/route.ts';
import { EntryAnnotationReviewStoppedError, LibraryConflictError } from './entry-errors.ts';
import { LibraryNotFoundError, requireRoute, WORK_STEP_DEADLINE_MS, workStepDeadline } from './command-support.ts';
import {
  parsePersonalNote,
  parsePersonalPriority,
  parsePersonalRevision,
  type PersonalEntry,
} from './entry-personal-model.ts';
import type { Entry } from './entry-model.ts';

export const ENTRY_ANNOTATION_CORRECTION_LIMITS = Object.freeze({
  selection: 16,
  page: 4,
  requestBytes: 512 * 1024,
  responseBytes: 256 * 1024,
  activeReviewsPerOwner: 4,
  retainedReviewsPerOwner: 8,
  reviewMinutes: 15,
  resultMinutes: 15,
});

export type EntryAnnotationOperation<T> =
  | Readonly<{ op: 'preserve' }>
  | Readonly<{ op: 'clear' }>
  | Readonly<{ op: 'set'; value: T }>;
export type EntryAnnotationCorrectionSelection = Readonly<{
  subjectId: string;
  incarnationId: string;
  currentRevision: number;
  note: EntryAnnotationOperation<string>;
  priority: EntryAnnotationOperation<number>;
}>;
export type EntryAnnotationCorrectionCurrent = Readonly<{
  annotationRevision: number;
  note: string | null;
  priority: number | null;
}>;
export type EntryAnnotationCorrectionItem = Readonly<{
  selected: Readonly<{ subjectId: string; incarnationId: string; currentRevision: number }>;
  eligibility: 'ready' | 'stale' | 'unavailable';
  current: EntryAnnotationCorrectionCurrent | null;
  operation: Readonly<{ note: EntryAnnotationOperation<string>; priority: EntryAnnotationOperation<number> }> | null;
  outcome: 'accepted' | 'unchanged' | 'stale' | 'unavailable' | 'not-started';
}>;
export type EntryAnnotationCorrectionPage = Readonly<{
  reviewId: string;
  epoch: string;
  state: 'open' | 'confirmed' | 'cancelled' | 'expired';
  createdAt: string;
  expiresAt: string;
  total: number;
  page: number;
  pageCount: number;
  nextPage: number | null;
  items: readonly EntryAnnotationCorrectionItem[];
}>;
export type EntryAnnotationCorrectionCommands = {
  readEntry(actor: Actor, subjectId: string): Promise<Entry>;
  readPersonalEntry(actor: Actor, subjectId: string): Promise<PersonalEntry>;
  saveAnnotations(
    actor: Actor,
    subjectId: string,
    input: unknown,
    requestKey: string,
  ): Promise<CommandOutcome<PersonalEntry>>;
};
type Dependencies = { pool: Pool; clock?: KernelClock; entries: () => EntryAnnotationCorrectionCommands };
type QueryClient = Pick<PoolClient, 'query'>;
type Operation<T> = EntryAnnotationOperation<T>;
type ParsedSelection = EntryAnnotationCorrectionSelection;
type HeaderRow = {
  reviewId: string;
  epoch: string;
  state: 'open' | 'confirmed' | 'cancelled' | 'expired';
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  purgeAfter: string;
};
type ItemRow = {
  position: number;
  subjectId: string;
  incarnationId: string;
  entryRevision: number;
  annotationRevision: number | null;
  noteOp: 'preserve' | 'clear' | 'set';
  noteValue: string | null;
  priorityOp: 'preserve' | 'clear' | 'set';
  priorityValue: number | null;
  previewState: 'ready' | 'stale' | 'unavailable';
  outcome: EntryAnnotationCorrectionItem['outcome'] | null;
  requestId: string;
};
type Current = { entry: Entry; personal: PersonalEntry | null };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = () => new TypeError('Invalid selected annotation correction');

function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const fields = Object.keys(value);
  if (
    required.some((field) => !fields.includes(field)) ||
    fields.some((field) => !required.includes(field) && !optional.includes(field))
  )
    throw invalid();
  return value as Record<string, unknown>;
}

function routedId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value) || routeOf(value) === null) throw invalid();
  return value;
}

function operation<T>(value: unknown, parse: (value: unknown) => T): Operation<T> {
  const input = object(value, ['op'], ['value']);
  if (input.op === 'preserve' && Object.keys(input).length === 1) return { op: 'preserve' };
  if (input.op === 'clear' && Object.keys(input).length === 1) return { op: 'clear' };
  if (input.op === 'set' && Object.keys(input).length === 2) return { op: 'set', value: parse(input.value) };
  throw invalid();
}

function parse(value: unknown): ParsedSelection[] {
  const input = object(value, ['items']);
  if (
    !Array.isArray(input.items) ||
    input.items.length < 1 ||
    input.items.length > ENTRY_ANNOTATION_CORRECTION_LIMITS.selection
  )
    throw invalid();
  const items = input.items.map((value) => {
    const item = object(value, ['subjectId', 'incarnationId', 'currentRevision', 'note', 'priority']);
    const currentRevision = parsePersonalRevision(item.currentRevision, false);
    return {
      subjectId: routedId(item.subjectId),
      incarnationId: routedId(item.incarnationId),
      currentRevision,
      note: operation(item.note, parsePersonalNote),
      priority: operation(item.priority, parsePersonalPriority),
    };
  });
  if (new Set(items.map((item) => item.subjectId)).size !== items.length) throw invalid();
  if (Buffer.byteLength(JSON.stringify({ items })) > ENTRY_ANNOTATION_CORRECTION_LIMITS.requestBytes) throw invalid();
  return items;
}

function requireOwner(
  actor: Actor,
  action: 'library_entry:read' | 'library_entry:update',
  alsoRead = false,
): AccountActor {
  if (
    actor.kind !== 'account' ||
    !actor.scopes.includes(action) ||
    (alsoRead && !actor.scopes.includes('library_entry:read'))
  )
    throw new GrantDeniedError();
  requireRoute(actor.accountId);
  return actor;
}

async function activeAccount(client: QueryClient, owner: AccountActor, route: number): Promise<void> {
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
}

async function lockActiveOwner(client: QueryClient, owner: AccountActor, route: number): Promise<void> {
  const locked = await client.query(
    'SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2 FOR UPDATE',
    [route, owner.accountId],
  );
  if (locked.rowCount !== 1) throw new GrantDeniedError();
  await activeAccount(client, owner, route);
}

function nowOf(clock?: KernelClock): Date {
  const now = (clock ?? systemClock)();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid review clock');
  return now;
}

function header(row: Record<string, unknown>): HeaderRow {
  return {
    reviewId: String(row.reviewId),
    epoch: String(row.epoch),
    state: row.state as HeaderRow['state'],
    itemCount: Number(row.itemCount),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    expiresAt: new Date(String(row.expiresAt)).toISOString(),
    purgeAfter: new Date(String(row.purgeAfter)).toISOString(),
  };
}

function item(row: Record<string, unknown>): ItemRow {
  return {
    position: Number(row.position),
    subjectId: String(row.subjectId),
    incarnationId: String(row.incarnationId),
    entryRevision: Number(row.entryRevision),
    annotationRevision: row.annotationRevision === null ? null : Number(row.annotationRevision),
    noteOp: row.noteOp as ItemRow['noteOp'],
    noteValue: row.noteValue === null ? null : String(row.noteValue),
    priorityOp: row.priorityOp as ItemRow['priorityOp'],
    priorityValue: row.priorityValue === null ? null : Number(row.priorityValue),
    previewState: row.previewState as ItemRow['previewState'],
    outcome: (row.outcome === null ? null : String(row.outcome)) as ItemRow['outcome'],
    requestId: String(row.requestId),
  };
}

function operationFrom<T>(op: 'preserve' | 'clear' | 'set', value: T | null): Operation<T> {
  return op === 'set' ? { op, value: value as T } : { op };
}

function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value)) > ENTRY_ANNOTATION_CORRECTION_LIMITS.responseBytes)
    throw new Error('Selected annotation correction response exceeds its byte ceiling');
  return value;
}

export class EntryAnnotationCorrectionConflictError extends Error {
  constructor(readonly reason: 'epoch' | 'expired') {
    super('Selected annotation correction review is no longer current');
    this.name = 'EntryAnnotationCorrectionConflictError';
  }
}

export class EntryAnnotationCorrectionLimitError extends Error {
  constructor() {
    super('Selected annotation correction review capacity is full');
    this.name = 'EntryAnnotationCorrectionLimitError';
  }
}

export function createEntryAnnotationCorrectionCommands(dependencies: Dependencies) {
  const { pool, clock } = dependencies;

  async function current(
    actor: Actor,
    selected: Pick<ParsedSelection, 'subjectId' | 'incarnationId'>,
  ): Promise<Current | null> {
    try {
      const entry = await dependencies.entries().readEntry(actor, selected.subjectId);
      if (entry.subjectId !== selected.subjectId) return null;
      if (entry.incarnationId !== selected.incarnationId) return { entry, personal: null };
      const personal = await dependencies.entries().readPersonalEntry(actor, selected.subjectId);
      return { entry, personal };
    } catch (error) {
      if (error instanceof LibraryNotFoundError || error instanceof GrantDeniedError) return null;
      throw error;
    }
  }

  async function insertReview(actor: Actor, selections: ParsedSelection[]) {
    const owner = requireOwner(actor, 'library_entry:update', true);
    const route = requireRoute(owner.accountId);
    if (selections.some((selected) => routeOf(selected.incarnationId) !== route)) throw invalid();
    const now = nowOf(clock);
    const nowText = now.toISOString();
    const expires = new Date(now.getTime() + ENTRY_ANNOTATION_CORRECTION_LIMITS.reviewMinutes * 60_000).toISOString();
    const purgeAfter = new Date(
      now.getTime() +
        (ENTRY_ANNOTATION_CORRECTION_LIMITS.reviewMinutes + ENTRY_ANNOTATION_CORRECTION_LIMITS.resultMinutes) * 60_000,
    ).toISOString();
    const snapshots = await Promise.all(
      selections.map(async (selected) => ({ selected, current: await current(actor, selected) })),
    );
    const reviewId = newId(route),
      epoch = newId(route);
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await lockActiveOwner(client, owner, route);
        await client.query(
          `DELETE FROM library.entry_annotation_review
           WHERE route=$1 AND account_id=$2 AND review_id IN (
             SELECT review_id FROM library.entry_annotation_review
             WHERE route=$1 AND account_id=$2 AND purge_after<=$3::timestamptz
             ORDER BY purge_after,review_id LIMIT $4
           )`,
          [route, owner.accountId, nowText, ENTRY_ANNOTATION_CORRECTION_LIMITS.retainedReviewsPerOwner],
        );
        const retained = await client.query<{ reviewId: string }>(
          `SELECT review_id AS "reviewId" FROM library.entry_annotation_review
           WHERE route=$1 AND account_id=$2 ORDER BY purge_after,review_id LIMIT $3`,
          [route, owner.accountId, ENTRY_ANNOTATION_CORRECTION_LIMITS.retainedReviewsPerOwner + 1],
        );
        const active = await client.query<{ reviewId: string }>(
          `SELECT review_id AS "reviewId" FROM library.entry_annotation_review
           WHERE route=$1 AND account_id=$2 AND state='open' AND expires_at>$3::timestamptz
           ORDER BY expires_at,review_id LIMIT $4`,
          [route, owner.accountId, nowText, ENTRY_ANNOTATION_CORRECTION_LIMITS.activeReviewsPerOwner + 1],
        );
        if (
          retained.rows.length >= ENTRY_ANNOTATION_CORRECTION_LIMITS.retainedReviewsPerOwner ||
          active.rows.length >= ENTRY_ANNOTATION_CORRECTION_LIMITS.activeReviewsPerOwner
        )
          throw new EntryAnnotationCorrectionLimitError();
        await client.query(
          `INSERT INTO library.entry_annotation_review
            (route,account_id,review_id,epoch,state,item_count,created_at,expires_at,purge_after)
           VALUES($1,$2,$3,$4,'open',$5,$6::timestamptz,$7::timestamptz,$8::timestamptz)`,
          [route, owner.accountId, reviewId, epoch, selections.length, nowText, expires, purgeAfter],
        );
        for (const [position, { selected, current: snapshot }] of snapshots.entries()) {
          const previewState = snapshot
            ? snapshot.entry.incarnationId === selected.incarnationId &&
              snapshot.entry.revision === selected.currentRevision
              ? 'ready'
              : 'stale'
            : 'unavailable';
          await client.query(
            `INSERT INTO library.entry_annotation_review_item
              (route,account_id,review_id,position,subject_id,entry_incarnation_id,entry_revision,
               annotation_revision,note_op,note_value,priority_op,priority_value,preview_state,outcome,request_id)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $13='stale' THEN 'stale' WHEN $13='unavailable' THEN 'unavailable' ELSE NULL END,$14)`,
            [
              route,
              owner.accountId,
              reviewId,
              position,
              selected.subjectId,
              selected.incarnationId,
              selected.currentRevision,
              snapshot?.personal?.annotationRevision ?? null,
              selected.note.op,
              selected.note.op === 'set' ? selected.note.value : null,
              selected.priority.op,
              selected.priority.op === 'set' ? selected.priority.value : null,
              previewState,
              newId(route),
            ],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    return readPage(actor, reviewId, 0);
  }

  async function readHeader(actor: Actor, reviewId: string): Promise<HeaderRow> {
    const owner = requireOwner(actor, 'library_entry:read');
    const route = requireRoute(owner.accountId);
    const id = routedId(reviewId);
    const nowText = nowOf(clock).toISOString();
    return withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await activeAccount(client, owner, route);
        const selected = await client.query<Record<string, unknown>>(
          `SELECT review_id AS "reviewId",epoch,state,item_count AS "itemCount",
             created_at::text AS "createdAt",expires_at::text AS "expiresAt",purge_after::text AS "purgeAfter"
           FROM library.entry_annotation_review
           WHERE route=$1 AND account_id=$2 AND review_id=$3 FOR UPDATE`,
          [route, owner.accountId, id],
        );
        const row = selected.rows[0];
        if (!row) throw new LibraryNotFoundError();
        const value = header(row);
        if (value.state === 'open' && Date.parse(value.expiresAt) <= Date.parse(nowText)) {
          await client.query(
            `UPDATE library.entry_annotation_review SET state='expired'
             WHERE route=$1 AND account_id=$2 AND review_id=$3 AND state='open'`,
            [route, owner.accountId, id],
          );
          await client.query(
            `UPDATE library.entry_annotation_review_item SET outcome='not-started'
             WHERE route=$1 AND account_id=$2 AND review_id=$3 AND outcome IS NULL`,
            [route, owner.accountId, id],
          );
          value.state = 'expired';
        }
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function readPage(actor: Actor, reviewId: string, page: number): Promise<EntryAnnotationCorrectionPage> {
    const owner = requireOwner(actor, 'library_entry:read');
    const id = routedId(reviewId);
    if (
      !Number.isInteger(page) ||
      page < 0 ||
      page >= ENTRY_ANNOTATION_CORRECTION_LIMITS.selection / ENTRY_ANNOTATION_CORRECTION_LIMITS.page
    )
      throw invalid();
    const review = await readHeader(actor, id);
    const route = requireRoute(owner.accountId);
    const pageCount = Math.ceil(review.itemCount / ENTRY_ANNOTATION_CORRECTION_LIMITS.page);
    if (page >= pageCount) throw invalid();
    const rows = await withConnection(pool, async (client) => {
      await activeAccount(client, owner, route);
      const result = await client.query<Record<string, unknown>>(
        `SELECT position,subject_id AS "subjectId",entry_incarnation_id AS "incarnationId",
           entry_revision AS "entryRevision",annotation_revision AS "annotationRevision",
           note_op AS "noteOp",note_value AS "noteValue",priority_op AS "priorityOp",priority_value AS "priorityValue",
           preview_state AS "previewState",outcome,request_id AS "requestId"
         FROM library.entry_annotation_review_item
         WHERE route=$1 AND account_id=$2 AND review_id=$3 AND position >= $4 AND position < $5
         ORDER BY position LIMIT $6`,
        [
          route,
          owner.accountId,
          id,
          page * ENTRY_ANNOTATION_CORRECTION_LIMITS.page,
          (page + 1) * ENTRY_ANNOTATION_CORRECTION_LIMITS.page,
          ENTRY_ANNOTATION_CORRECTION_LIMITS.page,
        ],
      );
      return result.rows.map(item);
    });
    const expectedCount = Math.min(
      ENTRY_ANNOTATION_CORRECTION_LIMITS.page,
      review.itemCount - page * ENTRY_ANNOTATION_CORRECTION_LIMITS.page,
    );
    if (rows.length !== expectedCount) throw new LibraryNotFoundError();
    const outputs: EntryAnnotationCorrectionItem[] = [];
    for (const selected of rows) {
      if (selected.previewState === 'unavailable') {
        outputs.push({
          selected: {
            subjectId: selected.subjectId,
            incarnationId: selected.incarnationId,
            currentRevision: selected.entryRevision,
          },
          eligibility: 'unavailable',
          current: null,
          operation: null,
          outcome: selected.outcome ?? 'unavailable',
        });
        continue;
      }
      const snapshot = await current(actor, selected);
      if (!snapshot) {
        outputs.push({
          selected: {
            subjectId: selected.subjectId,
            incarnationId: selected.incarnationId,
            currentRevision: selected.entryRevision,
          },
          eligibility: 'unavailable',
          current: null,
          operation: null,
          outcome: selected.outcome ?? 'unavailable',
        });
        continue;
      }
      if (!snapshot.personal) {
        outputs.push({
          selected: {
            subjectId: selected.subjectId,
            incarnationId: selected.incarnationId,
            currentRevision: selected.entryRevision,
          },
          eligibility: 'stale',
          current: null,
          operation: null,
          outcome: selected.outcome ?? 'not-started',
        });
        continue;
      }
      const guardMatches =
        snapshot.entry.subjectId === selected.subjectId &&
        snapshot.entry.incarnationId === selected.incarnationId &&
        snapshot.entry.revision === selected.entryRevision &&
        snapshot.personal.annotationRevision === selected.annotationRevision;
      const eligibility =
        selected.outcome === 'stale'
          ? 'stale'
          : selected.outcome === 'unavailable'
            ? 'unavailable'
            : selected.previewState === 'stale' || (selected.outcome === null && !guardMatches)
              ? 'stale'
              : 'ready';
      outputs.push({
        selected: {
          subjectId: selected.subjectId,
          incarnationId: selected.incarnationId,
          currentRevision: selected.entryRevision,
        },
        eligibility,
        current: {
          annotationRevision: snapshot.personal.annotationRevision,
          note: snapshot.personal.note,
          priority: snapshot.personal.priority,
        },
        operation: {
          note: operationFrom(selected.noteOp, selected.noteValue),
          priority: operationFrom(selected.priorityOp, selected.priorityValue),
        },
        outcome: selected.outcome ?? 'not-started',
      });
    }
    return bounded({
      reviewId: review.reviewId,
      epoch: review.epoch,
      state: review.state,
      createdAt: review.createdAt,
      expiresAt: review.expiresAt,
      total: review.itemCount,
      page,
      pageCount,
      nextPage: page + 1 < pageCount ? page + 1 : null,
      items: outputs,
    });
  }

  async function recordOutcome(
    actor: Actor,
    reviewId: string,
    position: number,
    outcome: EntryAnnotationCorrectionItem['outcome'],
  ) {
    const owner = requireOwner(actor, 'library_entry:update', true);
    const route = requireRoute(owner.accountId);
    await withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await activeAccount(client, owner, route);
        await client.query(
          `UPDATE library.entry_annotation_review_item SET outcome=$5
           WHERE route=$1 AND account_id=$2 AND review_id=$3 AND position=$4
             AND (outcome IS NULL OR (outcome='not-started' AND $5<>'not-started'))`,
          [route, owner.accountId, reviewId, position, outcome],
        );
        await client.query(
          `UPDATE library.entry_annotation_review SET state='confirmed'
           WHERE route=$1 AND account_id=$2 AND review_id=$3 AND state='open'
             AND NOT EXISTS (
               SELECT 1 FROM library.entry_annotation_review_item
               WHERE route=$1 AND account_id=$2 AND review_id=$3 AND outcome IS NULL
             )`,
          [route, owner.accountId, reviewId],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function confirmItem(actor: Actor, reviewId: string, epoch: string, position: number) {
    const owner = requireOwner(actor, 'library_entry:update', true);
    const id = routedId(reviewId);
    if (!Number.isInteger(position) || position < 0 || position >= ENTRY_ANNOTATION_CORRECTION_LIMITS.selection)
      throw invalid();
    const review = await readHeader(actor, id);
    if (review.epoch !== routedId(epoch)) throw new EntryAnnotationCorrectionConflictError('epoch');
    if (position >= review.itemCount) throw invalid();
    const route = requireRoute(owner.accountId);
    const found = await withConnection(pool, async (client) => {
      await activeAccount(client, owner, route);
      const result = await client.query<Record<string, unknown>>(
        `SELECT position,subject_id AS "subjectId",entry_incarnation_id AS "incarnationId",
           entry_revision AS "entryRevision",annotation_revision AS "annotationRevision",
           note_op AS "noteOp",note_value AS "noteValue",priority_op AS "priorityOp",priority_value AS "priorityValue",
           preview_state AS "previewState",outcome,request_id AS "requestId"
         FROM library.entry_annotation_review_item
         WHERE route=$1 AND account_id=$2 AND review_id=$3 AND position=$4`,
        [route, owner.accountId, id, position],
      );
      return result.rows[0] ? item(result.rows[0]) : null;
    });
    if (!found) throw new LibraryNotFoundError();
    if (found.outcome !== null)
      return {
        page: await readPage(actor, id, Math.floor(position / ENTRY_ANNOTATION_CORRECTION_LIMITS.page)),
      };
    if (review.state !== 'open') {
      if (review.state === 'expired') throw new EntryAnnotationCorrectionConflictError('expired');
      return {
        page: await readPage(actor, id, Math.floor(position / ENTRY_ANNOTATION_CORRECTION_LIMITS.page)),
      };
    }
    if (found.previewState !== 'ready') {
      await recordOutcome(actor, id, position, found.previewState === 'unavailable' ? 'unavailable' : 'stale');
      return {
        page: await readPage(actor, id, Math.floor(position / ENTRY_ANNOTATION_CORRECTION_LIMITS.page)),
      };
    }
    let outcome: EntryAnnotationCorrectionItem['outcome'];
    let commandOutcome: CommandOutcome<PersonalEntry> | undefined;
    try {
      if (found.annotationRevision === null) throw new LibraryConflictError();
      commandOutcome = await dependencies.entries().saveAnnotations(
        actor,
        found.subjectId,
        {
          revision: found.annotationRevision,
          entryGuard: {
            incarnationId: found.incarnationId,
            currentRevision: found.entryRevision,
            reviewGuard: { reviewId: id, epoch: review.epoch, position },
          },
          note: operationInput(found.noteOp, found.noteValue),
          priority: operationInput(found.priorityOp, found.priorityValue),
        },
        found.requestId,
      );
      outcome = commandOutcome.value.annotationRevision > found.annotationRevision ? 'accepted' : 'unchanged';
    } catch (error) {
      if (error instanceof LibraryConflictError) outcome = 'stale';
      else if (error instanceof EntryAnnotationReviewStoppedError) outcome = 'not-started';
      else if (error instanceof LibraryNotFoundError || error instanceof GrantDeniedError) outcome = 'unavailable';
      else throw error;
    }
    await recordOutcome(actor, id, position, outcome);
    return {
      page: await readPage(actor, id, Math.floor(position / ENTRY_ANNOTATION_CORRECTION_LIMITS.page)),
      ...(commandOutcome === undefined ? {} : { commandOutcome }),
    };
  }

  async function cancel(actor: Actor, reviewId: string, epoch: string) {
    const owner = requireOwner(actor, 'library_entry:update', true);
    const id = routedId(reviewId);
    const review = await readHeader(actor, id);
    if (review.epoch !== routedId(epoch)) throw new EntryAnnotationCorrectionConflictError('epoch');
    if (review.state === 'open') {
      const route = requireRoute(owner.accountId);
      await withConnection(pool, async (client) => {
        await client.query('BEGIN');
        try {
          await activeAccount(client, owner, route);
          await client.query(
            `UPDATE library.entry_annotation_review SET state='cancelled'
             WHERE route=$1 AND account_id=$2 AND review_id=$3 AND state='open'`,
            [route, owner.accountId, id],
          );
          await client.query(
            `UPDATE library.entry_annotation_review_item SET outcome='not-started'
             WHERE route=$1 AND account_id=$2 AND review_id=$3 AND outcome IS NULL`,
            [route, owner.accountId, id],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    }
    const latest = await readHeader(actor, id);
    return { reviewId: latest.reviewId, epoch: latest.epoch, state: latest.state, expiresAt: latest.expiresAt };
  }

  return {
    create: (actor: Actor, input: unknown) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => insertReview(actor, parse(input))),
    readPage: (actor: Actor, reviewId: string, page = 0) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => readPage(actor, reviewId, page)),
    confirmItem: (actor: Actor, reviewId: string, epoch: string, position: number) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => confirmItem(actor, reviewId, epoch, position)),
    cancel: (actor: Actor, reviewId: string, epoch: string) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => cancel(actor, reviewId, epoch)),
  };
}

function operationInput<T>(op: 'preserve' | 'clear' | 'set', value: T | null) {
  return op === 'set' ? { op, value } : { op: op === 'preserve' ? 'unchanged' : 'clear' };
}

/** Scheduled cleanup is keyed by the review expiry index, independent of owner History. */
export async function purgeExpiredEntryAnnotationReviews(
  { pool, clock }: { pool: Pool; clock?: KernelClock },
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
    last: { purgeAfter: string; accountId: string; reviewId: string } | null;
  };
  const decode = (value: string | null): Cursor => {
    if (value === null)
      return {
        version: 1,
        partition,
        route: partition * 16,
        cutoff: nowOf(clock).toISOString(),
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
          typeof parsed.last.purgeAfter !== 'string' ||
          !Number.isFinite(Date.parse(parsed.last.purgeAfter)) ||
          typeof parsed.last.accountId !== 'string' ||
          !uuid.test(parsed.last.accountId) ||
          routeOf(parsed.last.accountId) !== parsed.route ||
          typeof parsed.last.reviewId !== 'string' ||
          !uuid.test(parsed.last.reviewId) ||
          routeOf(parsed.last.reviewId) !== parsed.route))
    )
      throw new TypeError('Invalid expiry cursor');
    return parsed;
  };
  const cursor = decode(after);
  let examined = 0,
    removed = 0;
  while (cursor.route < (partition + 1) * 16 && examined < limit && Date.now() < deadline - 100) {
    const requested = limit - examined;
    const rows = await pool.query<{ route: number; accountId: string; reviewId: string; purgeAfter: string }>(
      `SELECT route,account_id AS "accountId",review_id AS "reviewId",purge_after::text AS "purgeAfter"
       FROM library.entry_annotation_review
       WHERE route=$1 AND purge_after <= $2::timestamptz
         AND ($3::timestamptz IS NULL OR (purge_after,account_id,review_id) > ($3::timestamptz,$4::uuid,$5::uuid))
       ORDER BY purge_after,account_id,review_id LIMIT $6`,
      [
        cursor.route,
        cursor.cutoff,
        cursor.last?.purgeAfter ?? null,
        cursor.last?.accountId ?? null,
        cursor.last?.reviewId ?? null,
        requested,
      ],
    );
    if (!rows.rows.length) {
      cursor.route++;
      cursor.last = null;
      continue;
    }
    let pageProcessed = 0;
    for (const row of rows.rows) {
      examined++;
      pageProcessed++;
      cursor.last = { purgeAfter: row.purgeAfter, accountId: row.accountId, reviewId: row.reviewId };
      try {
        const outcome = await runCommand(
          pool,
          {
            partition,
            deadline,
            clock,
            authorization: {
              action: 'library:entry-annotation-review-retention-maintenance',
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
              `DELETE FROM library.entry_annotation_review
               WHERE route=$1 AND account_id=$2 AND review_id=$3 AND purge_after <= $4::timestamptz
               RETURNING review_id`,
              [row.route, row.accountId, row.reviewId, authoritativeTimeValue(command.time)],
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
    if (pageProcessed === rows.rows.length && rows.rows.length < requested) {
      cursor.route++;
      cursor.last = null;
    }
  }
  const next = cursor.route >= (partition + 1) * 16 ? null : Buffer.from(JSON.stringify(cursor)).toString('base64url');
  if (next && Buffer.byteLength(next) > 2048) throw new RangeError('Review expiry cursor exceeds its bound');
  return { examined, removed, next };
}
