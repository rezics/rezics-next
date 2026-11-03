import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import { LifecycleDeniedError } from '../access/lifecycle-20261025094010-command.ts';
import {
  authoritativeTimeValue,
  commandTime,
  mintReadTime,
  noEffect,
  principalCommandIdentity,
  releaseOperationalTime,
} from '../command/command.ts';
import { runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { withConnection } from '../database/pool.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCommandAuthorization, AuthenticationError, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { WorkClient } from '../work/client.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, WORK_STEP_DEADLINE_MS } from './command-support.ts';
import {
  ArchiveValidationError,
  decodeLibraryArchive,
  LIBRARY_ARCHIVE_LIMITS,
  type ArchiveCoverage,
  type ArchiveRecord,
} from './library-archive.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import { createPersonalLabelCommands } from './label-commands.ts';
import { createLabelAssignmentCommands, type AssignmentReviewGuard } from './label-assignment-commands.ts';
import { normalizePersonalLabelName } from './label-store.ts';
import { hasEntryState, type LibraryProfilePin } from './profile.ts';
import { readLibraryProfileAnchor, readLibraryProfileSourceObservation } from './profile-source.ts';

export const LIBRARY_ARCHIVE_MERGE_LIMITS = {
  ...LIBRARY_ARCHIVE_LIMITS,
  page: 100,
  reviewItems: 20,
  applyItems: 20,
  cleanupItems: 100,
  lifetimeDays: 7,
} as const;

export type LibraryArchiveMergeDependencies = {
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  workClient: WorkClient | (() => Promise<WorkClient>);
  clock?: KernelClock;
};

export type ArchiveMergeReviewInput =
  | {
      ordinal: number;
      kind: 'entry';
      subjectId: string;
      action: 'create' | 'update' | 'preserve';
      stateId?: string;
    }
  | {
      ordinal: number;
      kind: 'label';
      target: { mode: 'existing'; labelId: string } | { mode: 'create' };
    }
  | {
      ordinal: number;
      kind: 'assignment';
      subjectId: string;
      action: 'assign' | 'preserve';
    };

type Action = 'library_entry:read' | 'library_entry:update';
type ItemStatus =
  | 'unresolved'
  | 'unsupported'
  | 'create'
  | 'already_equal'
  | 'current_conflict'
  | 'mapped'
  | 'preserved'
  | 'applying'
  | 'acknowledged';
type Upload = {
  upload_id: string;
  manifest: Record<string, unknown>;
  coverage: ArchiveCoverage[];
  row_count: number;
  record_bytes: number;
  created_at: string;
  expires_at: string;
  cancelled_at: string | null;
};
type Item = {
  ordinal: number;
  section: string;
  source_subject_id: string | null;
  source_label_id: string | null;
  record_json: string;
  status: ItemStatus;
  review: Record<string, unknown> | null;
  review_revision: number;
  native_command_kind: string | null;
  native_request_key: string | null;
  native_operands: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
};
type Effect = {
  kind: 'entry' | 'label' | 'assignment';
  key: string;
  operands: Record<string, unknown>;
};

const closed = { additionalProperties: false } as const;
const missing = () => new ProblemError('not_found');
const conflict = () => new ProblemError('conflict');
const isRoutedId = (value: unknown): value is string => typeof value === 'string' && routeOf(value) !== null;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const jsonObject = (value: unknown): Record<string, unknown> => object(value) ?? {};

function account(actor: Actor, action: Action): AccountActor {
  if (actor.kind !== 'account') throw new AuthenticationError(401, 'Bearer');
  if (routeOf(actor.accountId) === null || !actor.scopes.includes(action)) throw new ProblemError('forbidden');
  return actor;
}

function uploadState(upload: Upload, now: number) {
  if (now >= Date.parse(upload.expires_at)) return 'expired' as const;
  return upload.cancelled_at === null ? ('ready' as const) : ('cancelled' as const);
}

function uploadView(upload: Upload, now: number) {
  return {
    uploadId: upload.upload_id,
    createdAt: upload.created_at,
    expiresAt: upload.expires_at,
    state: uploadState(upload, now),
    rows: upload.row_count,
    recordBytes: upload.record_bytes,
    coverage: upload.coverage,
  };
}

function decodeRecord(item: Item): ArchiveRecord {
  return JSON.parse(item.record_json) as ArchiveRecord;
}

function commandKey(uploadId: string, ordinal: number, revision: number) {
  return `archive-merge-${uploadId.replaceAll('-', '')}-${ordinal}-${revision}`;
}

function keyForSection(section: string): 'entry' | 'label' | 'assignment' | null {
  if (section === 'entries') return 'entry';
  if (section === 'labels') return 'label';
  if (section === 'assignments') return 'assignment';
  return null;
}

function sameIdentity(left: string | null, right: unknown): left is string {
  return left !== null && left === right;
}

/** Private bounded archive retention. Effects are delegated to the installed Library command owners. */
export function createLibraryArchiveMerge(deps: LibraryArchiveMergeDependencies) {
  const clock = deps.clock ?? systemClock;
  const runner = createLibraryCommandRunner({ ...deps, clock });
  const entries = () => createEntryCommands({ pool: deps.pool, access: deps.access, tokens: deps.tokens, clock });
  const labels = () => createPersonalLabelCommands({ pool: deps.pool, tokens: deps.tokens, clock });
  const assignments = () =>
    createLabelAssignmentCommands({ pool: deps.pool, access: deps.access, tokens: deps.tokens, clock });

  async function operation<T>(
    actor: Actor,
    action: Action,
    signal: AbortSignal | undefined,
    body: (tx: OperationalTransaction, route: number, accountId: string, now: number) => Promise<T>,
  ) {
    const owner = account(actor, action);
    const route = routeOf(owner.accountId)!;
    const deadline = deadlineFor(5000);
    await admitGroup({
      pool: deps.pool,
      access: () => deps.access,
      actor,
      group: 'personal_library',
      clientAction: action,
      deadline,
      clock,
    });
    const authorization = await accessCommandAuthorization(
      deps.access,
      owner,
      action,
      { route, id: owner.accountId },
      { pool: deps.pool, deadline },
      () => new ProblemError('forbidden'),
    );
    try {
      return await runOperationalTransaction(
        deps.pool,
        {
          mode: 'request',
          ...principalCommandIdentity(owner),
          partition: partitionOf(route),
          kind: 'library.archive-merge',
          accounts: [owner.accountId],
          workClient: typeof deps.workClient === 'function' ? await deps.workClient() : deps.workClient,
          authorization,
          clock,
          deadline,
        },
        async (tx) => {
          signal?.throwIfAborted();
          const current = await readAccount(tx, route, owner.accountId);
          if (
            !current ||
            current.kind !== 'actor' ||
            current.state !== 'active' ||
            current.fenced ||
            !Number.isSafeInteger(owner.authnEpoch) ||
            owner.authnEpoch < 1 ||
            current.minimumAuthnEpoch > BigInt(owner.authnEpoch)
          )
            throw new ProblemError('forbidden');
          const time = commandTime(tx);
          if (!time) throw new ProblemError('dependency_unavailable');
          const result = await body(tx, route, owner.accountId, Date.parse(authoritativeTimeValue(time)));
          signal?.throwIfAborted();
          return result;
        },
      );
    } catch (error) {
      if (error instanceof LifecycleDeniedError) throw new ProblemError('forbidden');
      throw error;
    }
  }

  async function readUpload(
    tx: Pick<OperationalTransaction, 'query'>,
    route: number,
    accountId: string,
    id: string,
    lock = false,
  ): Promise<Upload> {
    if (routeOf(id) !== route) throw missing();
    const result = await tx.query<Upload>(
      `SELECT upload_id::text,manifest,coverage,row_count,record_bytes,created_at::text,expires_at::text,
        cancelled_at::text FROM library.library_archive_merge_upload
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 ${lock ? 'FOR UPDATE' : ''}`,
      [route, accountId, id],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }

  function requireLive(upload: Upload, now: number) {
    if (uploadState(upload, now) === 'expired') throw missing();
  }

  async function readItem(
    tx: Pick<OperationalTransaction, 'query'>,
    route: number,
    accountId: string,
    uploadId: string,
    ordinal: number,
    lock = false,
  ): Promise<Item> {
    const result = await tx.query<Item>(
      `SELECT ordinal,section,source_subject_id::text,source_label_id::text,record_json,status,review,
        review_revision,native_command_kind,native_request_key,native_operands,result
      FROM library.library_archive_merge_item
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 ${lock ? 'FOR UPDATE' : ''}`,
      [route, accountId, uploadId, ordinal],
    );
    if (!result.rows[0]) throw missing();
    return result.rows[0];
  }

  async function upload(actor: Actor, bytes: Uint8Array, requestKey: string, signal?: AbortSignal) {
    // Current account and exposure admission precede archive parsing and retention.
    await operation(actor, 'library_entry:update', signal, async () => undefined);
    let parsed;
    try {
      parsed = decodeLibraryArchive(bytes);
    } catch (error) {
      if (error instanceof ArchiveValidationError) throw new ProblemError('invalid_request');
      throw error;
    }
    const owner = account(actor, 'library_entry:update');
    const route = routeOf(owner.accountId)!;
    signal?.throwIfAborted();
    const result = await runner.ownAccount(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.archive-merge.upload',
        requestKey,
        input: { digest: createHash('sha256').update(bytes).digest('hex') },
      },
      async (tx, command) => {
        signal?.throwIfAborted();
        const uploadId = newId(route);
        const now = Date.parse(authoritativeTimeValue(command.time));
        const expiresAt = new Date(now + LIBRARY_ARCHIVE_MERGE_LIMITS.lifetimeDays * 86_400_000).toISOString();
        const inserted = await tx.query(
          `INSERT INTO library.library_archive_merge_upload
            (route,account_id,upload_id,manifest,coverage,row_count,record_bytes,created_at,expires_at)
          VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::timestamptz,$9::timestamptz)
          ON CONFLICT (route,account_id) DO NOTHING RETURNING upload_id`,
          [
            route,
            owner.accountId,
            uploadId,
            JSON.stringify(parsed.manifest),
            JSON.stringify(parsed.coverage),
            parsed.records.length,
            parsed.manifest.recordBytes,
            new Date(now).toISOString(),
            expiresAt,
          ],
        );
        if (!inserted.rowCount) throw conflict();
        const records = parsed.records.map((record, ordinal) => ({
          ordinal,
          section: record.section,
          source_subject_id:
            typeof record.subject_id === 'string' ? record.subject_id : null,
          source_label_id:
            record.section === 'labels'
              ? typeof record.label_id === 'string'
                ? record.label_id
                : null
              : record.section === 'assignments' && typeof record.label_id === 'string'
                ? record.label_id
                : null,
          evidence: JSON.stringify(record),
        }));
        await tx.query(
          `INSERT INTO library.library_archive_merge_item
            (route,account_id,upload_id,ordinal,section,source_subject_id,source_label_id,record_json,status)
          SELECT $1,$2,$3,r.ordinal,r.section,r.source_subject_id,r.source_label_id,r.evidence,
            CASE WHEN r.section IN ('entries','labels','assignments') THEN 'unresolved' ELSE 'unsupported' END
          FROM jsonb_to_recordset($4::jsonb) AS r(
            ordinal integer,section text,source_subject_id uuid,source_label_id uuid,evidence text)`,
          [route, owner.accountId, uploadId, JSON.stringify(records)],
        );
        signal?.throwIfAborted();
        // The receipt stores only the upload identity; archive values remain in the bounded private child table.
        return noEffect({ uploadId, expiresAt, rows: parsed.records.length });
      },
    );
    const value = await operation(actor, 'library_entry:update', signal, async (tx, r, accountId, now) =>
      uploadView(await readUpload(tx, r, accountId, result.value.uploadId), now),
    );
    return { ...result, value };
  }

  async function get(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor, 'library_entry:read', signal, async (tx, route, accountId, now) =>
      uploadView(await readUpload(tx, route, accountId, id), now),
    );
  }

  async function page(actor: Actor, id: string, after = -1, limit = 50, signal?: AbortSignal) {
    if (!Number.isInteger(after) || after < -1 || after >= LIBRARY_ARCHIVE_MERGE_LIMITS.records)
      throw new ProblemError('invalid_request');
    if (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_ARCHIVE_MERGE_LIMITS.page)
      throw new ProblemError('invalid_request');
    return operation(actor, 'library_entry:read', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id);
      requireLive(upload, now);
      const rows = await tx.query<Item>(
        `SELECT ordinal,section,source_subject_id::text,source_label_id::text,record_json,status,review,
          review_revision,native_command_kind,native_request_key,native_operands,result
        FROM library.library_archive_merge_item
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal>$4
        ORDER BY ordinal LIMIT $5`,
        [route, accountId, id, after, limit + 1],
      );
      const hasMore = rows.rows.length > limit;
      const visible = rows.rows.slice(0, limit);
      return {
        uploadId: id,
        state: uploadState(upload, now),
        coverage: upload.coverage,
        records: visible.map((item) => ({
          ordinal: item.ordinal,
          section: item.section,
          evidence: decodeRecord(item),
          status: item.status,
          review: item.review,
        })),
        next: hasMore ? visible.at(-1)!.ordinal : null,
      };
    });
  }

  async function results(actor: Actor, id: string, after = -1, limit = 50, signal?: AbortSignal) {
    if (!Number.isInteger(after) || after < -1 || after >= LIBRARY_ARCHIVE_MERGE_LIMITS.records)
      throw new ProblemError('invalid_request');
    if (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_ARCHIVE_MERGE_LIMITS.page)
      throw new ProblemError('invalid_request');
    return operation(actor, 'library_entry:read', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id);
      requireLive(upload, now);
      const rows = await tx.query<Item>(
        `SELECT ordinal,section,source_subject_id::text,source_label_id::text,record_json,status,review,
          review_revision,native_command_kind,native_request_key,native_operands,result
        FROM library.library_archive_merge_item
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal>$4
        ORDER BY ordinal LIMIT $5`,
        [route, accountId, id, after, limit + 1],
      );
      const hasMore = rows.rows.length > limit;
      const visible = rows.rows.slice(0, limit);
      return {
        uploadId: id,
        state: uploadState(upload, now),
        results: visible.map((item) => ({
          ordinal: item.ordinal,
          section: item.section,
          status: item.status,
          result: item.result,
        })),
        next: hasMore ? visible.at(-1)!.ordinal : null,
      };
    });
  }

  async function mapAssignmentLabel(
    actor: Actor,
    id: string,
    sourceLabelId: string | null,
    signal?: AbortSignal,
  ) {
    if (!sourceLabelId) return null;
    return operation(actor, 'library_entry:update', signal, async (tx, route, accountId) => {
      const result = await tx.query<{
        status: ItemStatus;
        review: Record<string, unknown> | null;
        result: Record<string, unknown> | null;
      }>(
        `SELECT status,review,result FROM library.library_archive_merge_item
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='labels' AND source_label_id=$4`,
        [route, accountId, id, sourceLabelId],
      );
      return result.rows[0] ?? null;
    });
  }

  async function identityTime<T>(body: (at: Awaited<ReturnType<typeof mintReadTime>>) => Promise<T>): Promise<T> {
    const time = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
    try {
      return await body(time);
    } finally {
      releaseOperationalTime(time);
    }
  }

  async function reviewOne(
    actor: Actor,
    id: string,
    item: Item,
    decision: ArchiveMergeReviewInput,
    signal?: AbortSignal,
  ): Promise<{ status: ItemStatus; review: Record<string, unknown> }> {
    const evidence = decodeRecord(item) as Record<string, unknown>;
    if (decision.kind !== item.section.slice(0, -1) && !(decision.kind === 'entry' && item.section === 'entries'))
      throw new ProblemError('invalid_request');

    if (decision.kind === 'entry') {
      if (!sameIdentity(item.source_subject_id, evidence.subject_id)) throw new ProblemError('invalid_request');
      if (decision.action === 'preserve')
        return identityTime(async (at) => {
          const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
          const anchor = await readLibraryProfileAnchor(
            { pool: deps.pool, access: deps.access, actor, at, deadline },
            decision.subjectId,
          );
          if (!anchor)
            return { status: 'unresolved', review: { requestedSubjectId: decision.subjectId, action: 'preserve' } };
          let current: Awaited<ReturnType<ReturnType<typeof createEntryCommands>['readEntry']>>;
          try {
            current = await entries().readEntry(actor, anchor.subjectId);
          } catch (error) {
            if (error instanceof LibraryNotFoundError)
              return {
                status: 'unresolved',
                review: { requestedSubjectId: decision.subjectId, targetSubjectId: anchor.subjectId, action: 'preserve' },
              };
            throw error;
          }
          return {
            status: 'preserved',
            review: {
              requestedSubjectId: decision.subjectId,
              targetSubjectId: anchor.subjectId,
              action: 'preserve',
              profile: { subjectId: anchor.subjectId, identityEpoch: anchor.identityEpoch.toString() },
              current: { state: current.state, revision: current.revision, incarnationId: current.incarnationId },
            },
          };
        });
      if (typeof decision.stateId !== 'string') throw new ProblemError('invalid_request');
      return identityTime(async (at) => {
        const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
        const observation = await readLibraryProfileSourceObservation(
          { pool: deps.pool, access: deps.access, actor, at, deadline },
          decision.subjectId,
        );
        if (!observation) {
          return {
            status: 'unresolved',
            review: { requestedSubjectId: decision.subjectId, targetStateId: decision.stateId, action: decision.action },
          };
        }
        const { source, anchor } = observation;
        const base = {
          requestedSubjectId: decision.subjectId,
          targetSubjectId: source.subjectId,
          targetStateId: decision.stateId,
          action: decision.action,
        };
        if (source.kind !== 'supported' || !hasEntryState(source.profile, decision.stateId))
          return { status: 'unsupported', review: base };
        let current: Awaited<ReturnType<ReturnType<typeof createEntryCommands>['readEntry']>> | null = null;
        try {
          current = await entries().readEntry(actor, source.subjectId);
        } catch (error) {
          if (!(error instanceof LibraryNotFoundError)) throw error;
        }
        const currentBinding = current
          ? {
              state: current.state,
              revision: current.revision,
              incarnationId: current.incarnationId,
            }
          : null;
        const status: ItemStatus =
          current === null
            ? decision.action === 'create'
              ? 'create'
              : 'current_conflict'
            : current.state === decision.stateId
              ? 'already_equal'
              : 'current_conflict';
        return {
          status,
          review: {
            ...base,
            profile: { subjectId: source.subjectId, identityEpoch: anchor.identityEpoch.toString(), pin: source.pin },
            current: currentBinding,
          },
        };
      });
    }

    if (decision.kind === 'label') {
      if (item.section !== 'labels') throw new ProblemError('invalid_request');
      if (decision.target.mode === 'create') {
        try {
          const name = normalizePersonalLabelName(evidence.normalized_name);
          return { status: 'create', review: { mode: 'create', name } };
        } catch {
          return { status: 'unsupported', review: { mode: 'create' } };
        }
      }
      if (!isRoutedId(decision.target.labelId)) throw new ProblemError('invalid_request');
      try {
        const label = await labels().readLabel(actor, decision.target.labelId);
        return {
          status: 'mapped',
          review: {
            mode: 'existing',
            labelId: label.id,
            revision: label.revision,
            name: label.name,
          },
        };
      } catch (error) {
        if (error instanceof LibraryNotFoundError) {
          return { status: 'unresolved', review: { mode: 'existing', labelId: decision.target.labelId } };
        }
        throw error;
      }
    }

    if (item.section !== 'assignments' || !sameIdentity(item.source_subject_id, evidence.subject_id))
      throw new ProblemError('invalid_request');
    return identityTime(async (at) => {
      const deadline = deadlineFor(WORK_STEP_DEADLINE_MS);
      const anchor = await readLibraryProfileAnchor(
        { pool: deps.pool, access: deps.access, actor, at, deadline },
        decision.subjectId,
      );
      if (!anchor)
        return {
          status: 'unresolved',
          review: { requestedSubjectId: decision.subjectId, action: decision.action },
        };
      const reviewBase = {
        requestedSubjectId: decision.subjectId,
        targetSubjectId: anchor.subjectId,
        identityEpoch: anchor.identityEpoch.toString(),
        action: decision.action,
      };
      const sourceLabel = await mapAssignmentLabel(actor, id, item.source_label_id, signal);
      const labelReview = sourceLabel?.review;
      let targetLabelId: string | null = null;
      let labelRevision: number | null = null;
      if (labelReview?.mode === 'existing') {
        targetLabelId = typeof labelReview.labelId === 'string' ? labelReview.labelId : null;
        labelRevision = typeof labelReview.revision === 'number' ? labelReview.revision : null;
      } else if (labelReview?.mode === 'create' && sourceLabel?.status === 'acknowledged') {
        const result = object(sourceLabel.result);
        targetLabelId = typeof result?.labelId === 'string' ? result.labelId : null;
        labelRevision = typeof result?.revision === 'number' ? result.revision : null;
      }
      if (!targetLabelId || labelRevision === null)
        return { status: 'unresolved', review: { ...reviewBase, sourceLabelId: item.source_label_id } };
      try {
        const label = await labels().readLabel(actor, targetLabelId);
        if (label.revision !== labelRevision)
          return {
            status: 'current_conflict',
            review: { ...reviewBase, labelId: targetLabelId, labelRevision },
          };
        const page = await assignments().listAssignments(actor, {
          labelId: targetLabelId,
          subjectId: anchor.subjectId,
          limit: 1,
        });
        return {
          status: page.assignments.length ? 'already_equal' : 'create',
          review: { ...reviewBase, labelId: targetLabelId, labelRevision },
        };
      } catch (error) {
        if (error instanceof LibraryNotFoundError)
          return {
            status: 'current_conflict',
            review: { ...reviewBase, labelId: targetLabelId, labelRevision },
          };
        throw error;
      }
    });
  }

  async function review(actor: Actor, id: string, decisions: readonly ArchiveMergeReviewInput[], signal?: AbortSignal) {
    if (
      decisions.length < 1 ||
      decisions.length > LIBRARY_ARCHIVE_MERGE_LIMITS.reviewItems ||
      new Set(decisions.map((decision) => decision.ordinal)).size !== decisions.length
    )
      throw new ProblemError('invalid_request');
    const current = await operation(actor, 'library_entry:update', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id);
      requireLive(upload, now);
      if (upload.cancelled_at !== null) throw conflict();
      return Promise.all(decisions.map((decision) => readItem(tx, route, accountId, id, decision.ordinal)));
    });
    const evaluated = await Promise.all(
      current.map((item, index) =>
        reviewOne(actor, id, item, decisions[index]!, signal).then((value) => ({
          ordinal: item.ordinal,
          expectedRevision: item.review_revision,
          ...value,
        })),
      ),
    );
    return operation(actor, 'library_entry:update', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id, true);
      requireLive(upload, now);
      if (upload.cancelled_at !== null) throw conflict();
      const saved = [];
      for (const item of evaluated) {
        const result = await tx.query(
          `UPDATE library.library_archive_merge_item
          SET status=$6,review=$7::jsonb,review_revision=review_revision+1,
            native_command_kind=NULL,native_request_key=NULL,native_operands=NULL,result=NULL
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND review_revision=$5
            AND status NOT IN ('applying','acknowledged') RETURNING ordinal,status,review_revision`,
          [route, accountId, id, item.ordinal, item.expectedRevision, item.status, JSON.stringify(item.review)],
        );
        if (!result.rows[0]) throw conflict();
        saved.push({ ordinal: item.ordinal, status: item.status });
      }
      return { uploadId: id, reviewed: saved };
    });
  }

  function effectable(item: Item): Effect | null {
    if (!item.review || item.result !== null) return null;
    const decision = item.review;
    if (item.status === 'create' && item.section === 'entries' && decision.action === 'create') {
      const profile = object(decision.profile);
      return {
        kind: 'entry',
        key: '',
        operands: {
          subjectId: decision.targetSubjectId,
          stateId: decision.targetStateId,
          incarnationId: null,
          revision: null,
          profile,
        },
      };
    }
    if (
      item.status === 'current_conflict' &&
      item.section === 'entries' &&
      decision.action === 'update' &&
      object(decision.current)
    ) {
      const profile = object(decision.profile);
      return {
        kind: 'entry',
        key: '',
        operands: {
          subjectId: decision.targetSubjectId,
          stateId: decision.targetStateId,
          revision: object(decision.current)!.revision,
          incarnationId: object(decision.current)!.incarnationId,
          profile,
        },
      };
    }
    if (item.status === 'create' && item.section === 'labels' && decision.mode === 'create')
      return {
        kind: 'label',
        key: '',
        operands: { name: decision.name },
      };
    if (item.status === 'create' && item.section === 'assignments' && decision.action === 'assign')
      return {
        kind: 'assignment',
        key: commandKey('', item.ordinal, item.review_revision),
        operands: {
          requestedSubjectId: decision.requestedSubjectId,
          subjectId: decision.targetSubjectId,
          identityEpoch: decision.identityEpoch,
          labelId: decision.labelId,
          labelRevision: decision.labelRevision,
        },
      };
    return null;
  }

  async function beginEffect(actor: Actor, id: string, ordinal: number, signal?: AbortSignal) {
    return operation(actor, 'library_entry:update', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id, true);
      requireLive(upload, now);
      const item = await readItem(tx, route, accountId, id, ordinal, true);
      if (item.status === 'acknowledged') return { mode: 'done' as const, status: item.status, result: item.result };
      if (item.status === 'applying') {
        if (!item.native_command_kind || !item.native_request_key || !item.native_operands)
          throw new Error('Archive merge applying row is missing its native command binding');
        return {
          mode: 'run' as const,
          effect: {
            kind: item.native_command_kind as Effect['kind'],
            key: item.native_request_key,
            operands: item.native_operands,
          },
        };
      }
      if (upload.cancelled_at !== null) throw conflict();
      if (item.status === 'mapped' || item.status === 'already_equal' || item.status === 'preserved')
        return { mode: 'done' as const, status: item.status, result: item.result };
      if (item.review?.action === 'preserve') {
        await tx.query(
          `UPDATE library.library_archive_merge_item SET status='preserved'
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
          [route, accountId, id, ordinal],
        );
        return { mode: 'done' as const, status: 'preserved' as const, result: null };
      }
      const proposed = effectable(item);
      if (!proposed) return { mode: 'done' as const, status: item.status, result: item.result };
      const key = commandKey(id, ordinal, item.review_revision);
      const binding = { ...proposed, key };
      const updated = await tx.query(
        `UPDATE library.library_archive_merge_item
        SET status='applying',native_command_kind=$5,native_request_key=$6,native_operands=$7::jsonb,result=NULL
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND status=$8
          AND review_revision=$9 RETURNING ordinal`,
        [route, accountId, id, ordinal, binding.kind, binding.key, JSON.stringify(binding.operands), item.status, item.review_revision],
      );
      if (!updated.rowCount) throw conflict();
      return { mode: 'run' as const, effect: binding };
    });
  }

  async function runEffect(actor: Actor, effect: Effect): Promise<Record<string, unknown>> {
    const owner = account(actor, 'library_entry:update');
    if (effect.kind === 'entry') {
      const profile = object(effect.operands.profile);
      if (!profile || typeof profile.subjectId !== 'string' || typeof profile.identityEpoch !== 'string')
        throw new Error('Archive merge entry binding is invalid');
      const guard = {
        subjectId: profile.subjectId,
        pin: profile.pin as LibraryProfilePin,
        epoch: profile.identityEpoch,
      };
      const input = {
        state: effect.operands.stateId,
        ...(typeof effect.operands.revision === 'number' ? { revision: effect.operands.revision } : {}),
        ...(typeof effect.operands.incarnationId === 'string'
          ? { incarnationId: effect.operands.incarnationId }
          : {}),
      };
      const result = await entries().putEntry(actor, String(effect.operands.subjectId), input, effect.key, guard);
      const entry = result.value.entry;
      return {
        effect: 'entry.put',
        created: result.value.created,
        subjectId: entry.subjectId,
        state: entry.state,
        revision: entry.revision,
        incarnationId: entry.incarnationId,
      };
    }
    if (effect.kind === 'label') {
      const result = await labels().createLabel(actor, { name: effect.operands.name }, effect.key);
      return { effect: 'label.create', labelId: result.value.label.id, revision: result.value.label.revision };
    }
    if (
      typeof effect.operands.requestedSubjectId !== 'string' ||
      typeof effect.operands.subjectId !== 'string' ||
      typeof effect.operands.identityEpoch !== 'string' ||
      typeof effect.operands.labelId !== 'string' ||
      typeof effect.operands.labelRevision !== 'number'
    )
      throw new Error('Archive merge assignment binding is invalid');
    const guard: AssignmentReviewGuard = {
      subjectId: effect.operands.subjectId,
      identityEpoch: effect.operands.identityEpoch,
      labelRevision: effect.operands.labelRevision,
    };
    const result = await assignments().assignLabel(
      owner,
      effect.operands.labelId,
      { subjectId: effect.operands.requestedSubjectId },
      effect.key,
      guard,
    );
    return {
      effect: 'label.assign',
      subjectId: effect.operands.subjectId,
      labelId: effect.operands.labelId,
      assignmentId: result.value.assignment.id,
      revision: result.value.assignment.revision,
    };
  }

  async function acknowledge(actor: Actor, id: string, ordinal: number, result: Record<string, unknown>) {
    return operation(actor, 'library_entry:update', undefined, async (tx, route, accountId) => {
      const upload = await readUpload(tx, route, accountId, id, true);
      const item = await readItem(tx, route, accountId, id, ordinal, true);
      if (item.status === 'acknowledged') return item.result;
      if (item.status !== 'applying') throw conflict();
      await tx.query(
        `UPDATE library.library_archive_merge_item SET status='acknowledged',result=$5::jsonb
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [route, accountId, id, ordinal, JSON.stringify(result)],
      );
      return result;
    });
  }

  async function refuse(actor: Actor, id: string, ordinal: number, status: 'current_conflict' | 'unsupported' | 'unresolved') {
    return operation(actor, 'library_entry:update', undefined, async (tx, route, accountId) => {
      await readUpload(tx, route, accountId, id, true);
      const item = await readItem(tx, route, accountId, id, ordinal, true);
      if (item.status !== 'applying') throw conflict();
      await tx.query(
        `UPDATE library.library_archive_merge_item SET status=$5,result=$6::jsonb
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [route, accountId, id, ordinal, status, JSON.stringify({ code: status })],
      );
      return { status, result: { code: status } };
    });
  }

  async function apply(actor: Actor, id: string, ordinals: readonly number[], signal?: AbortSignal) {
    if (
      ordinals.length < 1 ||
      ordinals.length > LIBRARY_ARCHIVE_MERGE_LIMITS.applyItems ||
      new Set(ordinals).size !== ordinals.length ||
      ordinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= LIBRARY_ARCHIVE_MERGE_LIMITS.records)
    )
      throw new ProblemError('invalid_request');
    const applied = [];
    for (const ordinal of ordinals) {
      signal?.throwIfAborted();
      const start = await beginEffect(actor, id, ordinal, signal);
      if (start.mode === 'done') {
        applied.push({ ordinal, status: start.status, result: start.result });
        continue;
      }
      try {
        const result = await runEffect(actor, start.effect);
        const acknowledged = await acknowledge(actor, id, ordinal, result);
        applied.push({ ordinal, status: 'acknowledged', result: acknowledged });
      } catch (error) {
        if (error instanceof LibraryConflictError) {
          applied.push({ ordinal, ...((await refuse(actor, id, ordinal, 'current_conflict')) as object) });
          continue;
        }
        if (error instanceof LibraryNotFoundError) {
          applied.push({ ordinal, ...((await refuse(actor, id, ordinal, 'unresolved')) as object) });
          continue;
        }
        if (
          error instanceof ProblemError &&
          (error.code === 'unsupported_library_profile' || error.code === 'library_label_capacity')
        ) {
          applied.push({ ordinal, ...((await refuse(actor, id, ordinal, 'unsupported')) as object) });
          continue;
        }
        throw error;
      }
    }
    return { uploadId: id, applied };
  }

  async function cancel(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor, 'library_entry:update', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id, true);
      if (uploadState(upload, now) !== 'expired' && upload.cancelled_at === null)
        await tx.query(
          `UPDATE library.library_archive_merge_upload SET cancelled_at=$4::timestamptz
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND cancelled_at IS NULL`,
          [route, accountId, id, new Date(now).toISOString()],
        );
      const current = await readUpload(tx, route, accountId, id);
      return uploadView(current, now);
    });
  }

  async function prune(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor, 'library_entry:update', signal, async (tx, route, accountId, now) => {
      const upload = await readUpload(tx, route, accountId, id, true);
      if (now < Date.parse(upload.expires_at)) throw conflict();
      const removed = await tx.query(
        `WITH keys AS MATERIALIZED (
          SELECT ordinal FROM library.library_archive_merge_item
          WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY ordinal LIMIT $4
        )
        DELETE FROM library.library_archive_merge_item item USING keys
        WHERE item.route=$1 AND item.account_id=$2 AND item.upload_id=$3 AND item.ordinal=keys.ordinal`,
        [route, accountId, id, LIBRARY_ARCHIVE_MERGE_LIMITS.cleanupItems],
      );
      const remaining = await tx.query(
        `SELECT 1 FROM library.library_archive_merge_item
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 LIMIT 1`,
        [route, accountId, id],
      );
      if (!remaining.rowCount)
        await tx.query(
          `DELETE FROM library.library_archive_merge_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
          [route, accountId, id],
        );
      return { uploadId: id, removed: removed.rowCount ?? 0, complete: !remaining.rowCount };
    });
  }

  return { upload, get, page, review, apply, results, cancel, prune };
}
