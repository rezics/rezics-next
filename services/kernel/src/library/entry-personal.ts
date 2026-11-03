import type { Pool, PoolClient } from 'pg';
import canonicalize from 'canonicalize';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue, noEffect, type AuthoritativeTime } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import type { Access, AccountActor, Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { newId } from '../route/route.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  requireRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import { resolveSubject } from './subject-anchor.ts';
import { EntryAnnotationReviewStoppedError, LibraryConflictError } from './entry-errors.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import {
  MAX_SOURCE_OBSERVATIONS,
  applyFieldChange,
  parseConfirmation,
  parseFieldChange,
  parsePersonalNote,
  parsePersonalPriority,
  parsePersonalRevision,
  parsePrivacyChange,
  parsePrivacyValue,
  parseProviderKey,
  parseProviderRecordId,
  parseTimestampChange,
  parseTimestampValue,
  type PersonalEntry,
  type PersonalEntryObservation,
  type PrivacyFact,
  type TimestampFact,
  type TimestampValue,
} from './entry-personal-model.ts';

type Dependencies = { pool: Pool; access: Access; clock?: KernelClock };
type QueryClient = Pick<PoolClient, 'query'>;
type PrivacyColumns = { privacyStatus: string; privacyMeaning: string | null; privacySourceValue: string | null };
type TimestampColumns = { status: string; value: string | null; precision: string | null; zone: string | null };
type ObservationRow = {
  provider: string;
  recordId: string;
  revision: number;
  privacyStatus: string;
  privacyMeaning: string | null;
  privacySourceValue: string | null;
  sourceCreatedStatus: string;
  sourceCreatedValue: string | null;
  sourceCreatedPrecision: string | null;
  sourceCreatedZone: string | null;
  sourceUpdatedStatus: string;
  sourceUpdatedValue: string | null;
  sourceUpdatedPrecision: string | null;
  sourceUpdatedZone: string | null;
  recordedAt: string;
};

function owner(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || !actor.scopes.includes(action)) throw new GrantDeniedError();
  requireRoute(actor.accountId);
  return actor;
}

function closed(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`Invalid ${label}`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key)))
    throw new TypeError(`Invalid ${label}`);
  return record;
}

function parseAnnotationInput(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Invalid personal annotation input');
  const fields = Object.keys(value);
  if (
    !['revision', 'note', 'priority'].every((field) => fields.includes(field)) ||
    fields.some((field) => !['revision', 'note', 'priority', 'entryGuard'].includes(field))
  )
    throw new TypeError('Invalid personal annotation input');
  const input = value as Record<string, unknown>;
  const note = parseFieldChange(input.note, parsePersonalNote);
  const priority = parseFieldChange(input.priority, parsePersonalPriority);
  let entryGuard:
    | {
        incarnationId: string;
        currentRevision: number;
        reviewGuard?: { reviewId: string; epoch: string; position: number };
        profileGuard?: {
          subjectId: string;
          identityEpoch: string;
          acceptingType: string;
          requestedSubjectId: string | null;
          component: Record<string, unknown>;
          pin: Record<string, unknown>;
        };
      }
    | undefined;
  if (input.entryGuard !== undefined) {
    if (typeof input.entryGuard !== 'object' || input.entryGuard === null || Array.isArray(input.entryGuard))
      throw new TypeError('Invalid entry guard');
    const guardFields = Object.keys(input.entryGuard);
    if (
      !['incarnationId', 'currentRevision'].every((field) => guardFields.includes(field)) ||
      guardFields.some((field) => !['incarnationId', 'currentRevision', 'reviewGuard', 'profileGuard'].includes(field))
    )
      throw new TypeError('Invalid entry guard');
    const guard = input.entryGuard as Record<string, unknown>;
    if (
      typeof guard.incarnationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guard.incarnationId)
    )
      throw new TypeError('Invalid entry guard');
    entryGuard = {
      incarnationId: guard.incarnationId,
      currentRevision: parsePersonalRevision(guard.currentRevision, false),
    };
    if (guard.profileGuard !== undefined) {
      if (typeof guard.profileGuard !== 'object' || guard.profileGuard === null || Array.isArray(guard.profileGuard))
        throw new TypeError('Invalid profile guard');
      const profile = guard.profileGuard as Record<string, unknown>;
      if (
        Object.keys(profile).length !== 6 ||
        !Object.hasOwn(profile, 'subjectId') ||
        !Object.hasOwn(profile, 'identityEpoch') ||
        !Object.hasOwn(profile, 'acceptingType') ||
        !Object.hasOwn(profile, 'requestedSubjectId') ||
        !Object.hasOwn(profile, 'component') ||
        !Object.hasOwn(profile, 'pin') ||
        typeof profile.subjectId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.subjectId) ||
        typeof profile.identityEpoch !== 'string' ||
        !/^\d+$/.test(profile.identityEpoch) ||
        typeof profile.acceptingType !== 'string' ||
        (profile.requestedSubjectId !== null &&
          (typeof profile.requestedSubjectId !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profile.requestedSubjectId))) ||
        !profile.component ||
        typeof profile.component !== 'object' ||
        Array.isArray(profile.component) ||
        !profile.pin ||
        typeof profile.pin !== 'object' ||
        Array.isArray(profile.pin)
      )
        throw new TypeError('Invalid profile guard');
      entryGuard.profileGuard = {
        subjectId: profile.subjectId,
        identityEpoch: profile.identityEpoch,
        acceptingType: profile.acceptingType,
        requestedSubjectId: profile.requestedSubjectId as string | null,
        component: profile.component as Record<string, unknown>,
        pin: profile.pin as Record<string, unknown>,
      };
    }
    if (guard.reviewGuard !== undefined) {
      const review = closed(guard.reviewGuard, ['reviewId', 'epoch', 'position'], 'review guard');
      if (
        typeof review.reviewId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(review.reviewId) ||
        typeof review.epoch !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(review.epoch) ||
        !Number.isInteger(review.position) ||
        Number(review.position) < 0 ||
        Number(review.position) >= 16
      )
        throw new TypeError('Invalid review guard');
      entryGuard.reviewGuard = {
        reviewId: review.reviewId,
        epoch: review.epoch,
        position: Number(review.position),
      };
    }
  }
  if (note.op === 'unchanged' && priority.op === 'unchanged' && !entryGuard)
    throw new TypeError('Personal annotation has no changes');
  return { revision: parsePersonalRevision(input.revision), note, priority, ...(entryGuard ? { entryGuard } : {}) };
}

function parseObservationInput(value: unknown) {
  const input = closed(
    value,
    ['provider', 'recordId', 'confirmReviewed', 'privacy', 'sourceCreated', 'sourceUpdated'],
    'source observation input',
  );
  return {
    provider: parseProviderKey(input.provider),
    recordId: parseProviderRecordId(input.recordId),
    confirmReviewed: parseConfirmation(input.confirmReviewed),
    privacy: parsePrivacyValue(input.privacy),
    sourceCreated: parseTimestampValue(input.sourceCreated),
    sourceUpdated: parseTimestampValue(input.sourceUpdated),
  };
}

function parseObservationCorrection(value: unknown) {
  const input = closed(
    value,
    ['provider', 'recordId', 'revision', 'confirmReviewed', 'privacy', 'sourceCreated', 'sourceUpdated'],
    'source observation correction',
  );
  const privacy = parsePrivacyChange(input.privacy);
  const sourceCreated = parseTimestampChange(input.sourceCreated);
  const sourceUpdated = parseTimestampChange(input.sourceUpdated);
  if (privacy.op === 'unchanged' && sourceCreated.op === 'unchanged' && sourceUpdated.op === 'unchanged')
    throw new TypeError('Source observation has no changes');
  return {
    provider: parseProviderKey(input.provider),
    recordId: parseProviderRecordId(input.recordId),
    revision: parsePersonalRevision(input.revision, false),
    confirmReviewed: parseConfirmation(input.confirmReviewed),
    privacy,
    sourceCreated,
    sourceUpdated,
  };
}

function timestampColumns(value: TimestampFact): TimestampColumns {
  if (value.status === 'known')
    return { status: value.status, value: value.value, precision: value.precision, zone: value.zone };
  if (value.status === 'unknown')
    return { status: value.status, value: value.sourceValue ?? null, precision: null, zone: null };
  return { status: value.status, value: null, precision: null, zone: null };
}

function privacyColumns(value: PrivacyFact): PrivacyColumns {
  return {
    privacyStatus: value.status,
    privacyMeaning: value.status === 'known' ? value.meaning : null,
    privacySourceValue: value.status === 'unknown' ? (value.sourceValue ?? null) : null,
  };
}

function decodePrivacy(status: string, meaning: string | null, sourceValue: string | null): PrivacyFact {
  if (status === 'known' && (meaning === 'private' || meaning === 'source_visible') && sourceValue === null)
    return { status, meaning };
  if (status === 'unknown' && meaning === null) return { status, ...(sourceValue === null ? {} : { sourceValue }) };
  if ((status === 'absent' || status === 'cleared') && meaning === null && sourceValue === null) return { status };
  throw new Error('Invalid stored personal entry privacy');
}

function decodeTimestamp(value: TimestampColumns): TimestampFact {
  if (value.status === 'known') {
    if (
      value.value === null ||
      !['year', 'month', 'day', 'minute', 'second', 'fraction'].includes(value.precision ?? '') ||
      !['utc', 'offset', 'unknown'].includes(value.zone ?? '')
    )
      throw new Error('Invalid stored personal entry timestamp');
    return {
      status: 'known',
      value: value.value,
      precision: value.precision as Extract<TimestampValue, { status: 'known' }>['precision'],
      zone: value.zone as Extract<TimestampValue, { status: 'known' }>['zone'],
    };
  }
  if (value.status === 'unknown' && value.precision === null && value.zone === null)
    return { status: 'unknown', ...(value.value === null ? {} : { sourceValue: value.value }) };
  if (
    (value.status === 'absent' || value.status === 'cleared') &&
    value.value === null &&
    value.precision === null &&
    value.zone === null
  )
    return { status: value.status as 'absent' | 'unknown' | 'cleared' };
  throw new Error('Invalid stored personal entry timestamp');
}

function observation(row: ObservationRow): PersonalEntryObservation {
  return {
    provider: row.provider,
    recordId: row.recordId,
    revision: row.revision,
    privacy: decodePrivacy(row.privacyStatus, row.privacyMeaning, row.privacySourceValue),
    sourceCreated: decodeTimestamp({
      status: row.sourceCreatedStatus,
      value: row.sourceCreatedValue,
      precision: row.sourceCreatedPrecision,
      zone: row.sourceCreatedZone,
    }),
    sourceUpdated: decodeTimestamp({
      status: row.sourceUpdatedStatus,
      value: row.sourceUpdatedValue,
      precision: row.sourceUpdatedPrecision,
      zone: row.sourceUpdatedZone,
    }),
    recordedAt: row.recordedAt,
  };
}

async function readPersonal(
  client: QueryClient,
  route: number,
  accountId: string,
  subjectId: string,
): Promise<PersonalEntry> {
  const parent = await client.query<{
    annotationRevision: number;
    note: string | null;
    priority: number | null;
    annotationUpdatedAt: string | null;
  }>(
    `SELECT annotation_revision AS "annotationRevision", note, priority,
      CASE WHEN annotation_updated_at IS NULL THEN NULL ELSE
        to_char(annotation_updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "annotationUpdatedAt"
     FROM library.entry_personal_fact WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [route, accountId, subjectId],
  );
  const facts = await client.query<ObservationRow>(
    `SELECT provider, record_id AS "recordId", revision, privacy_status AS "privacyStatus",
      privacy_meaning AS "privacyMeaning", privacy_source_value AS "privacySourceValue",
      source_created_status AS "sourceCreatedStatus",
      source_created_value AS "sourceCreatedValue", source_created_precision AS "sourceCreatedPrecision",
      source_created_zone AS "sourceCreatedZone", source_updated_status AS "sourceUpdatedStatus",
      source_updated_value AS "sourceUpdatedValue", source_updated_precision AS "sourceUpdatedPrecision",
      source_updated_zone AS "sourceUpdatedZone",
      to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"
     FROM library.entry_source_observation WHERE route=$1 AND account_id=$2 AND subject_id=$3
     ORDER BY provider COLLATE "C", record_id COLLATE "C" LIMIT $4`,
    [route, accountId, subjectId, MAX_SOURCE_OBSERVATIONS],
  );
  const row = parent.rows[0];
  return {
    subjectId,
    annotationRevision: row?.annotationRevision ?? 0,
    note: row?.note ?? null,
    priority: row?.priority ?? null,
    annotationUpdatedAt: row?.annotationUpdatedAt ?? null,
    sourceObservations: facts.rows.map(observation),
  };
}

async function resolveCanonicalSubject(
  dependencies: Dependencies,
  actor: AccountActor,
  subjectId: string,
  at?: AuthoritativeTime,
) {
  const resolved = await resolveSubject({ pool: dependencies.pool, access: dependencies.access }, actor, subjectId, at);
  if (!resolved || resolved.subjectId !== subjectId) throw new LibraryNotFoundError();
  return resolved.subjectId;
}

function event(type: string, accountId: string, subjectId: string, data: Record<string, string> = {}) {
  return { type, subject: accountId, data: { subjectId, ...data } };
}

function newFactId(route: number, subjectId: string): string {
  const id = newId(route);
  return id === subjectId ? newId(route) : id;
}

export function createEntryPersonalCommands(dependencies: Dependencies) {
  const { pool, access, clock } = dependencies;
  const runner = createLibraryCommandRunner({ pool, ...(clock === undefined ? {} : { clock }) });

  async function readPersonalEntry(actor: Actor, subjectId: string): Promise<PersonalEntry> {
    const account = owner(actor, 'library_entry:read');
    requireRoute(subjectId);
    const canonical = await resolveCanonicalSubject(dependencies, account, subjectId);
    return withConnection(pool, async (client) => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const current = await readAccount(client, requireRoute(account.accountId), account.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(account.authnEpoch) ||
          account.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(account.authnEpoch)
        )
          throw new GrantDeniedError();
        const value = await readPersonal(client, requireRoute(account.accountId), account.accountId, canonical);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async function saveAnnotations(actor: Actor, subjectId: string, input: unknown, requestKey: string) {
    const account = owner(actor, 'library_entry:update');
    requireRoute(subjectId);
    const parsed = parseAnnotationInput(input);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.entry.annotations.put',
        requestKey,
        input: { subjectId, ...parsed },
        async prepare(attempt) {
          try {
            return { subjectId: await resolveCanonicalSubject(dependencies, account, subjectId, attempt.time) };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const route = requireRoute(account.accountId);
        const time = authoritativeTimeValue(command.time);
        if (parsed.entryGuard?.reviewGuard) {
          const reviewGuard = parsed.entryGuard.reviewGuard;
          const bound = await tx.query<{
            epoch: string;
            state: string;
            expired: boolean;
            subjectId: string;
            incarnationId: string;
            entryRevision: number;
            annotationRevision: number | null;
            noteOp: string;
            noteValue: string | null;
            priorityOp: string;
            priorityValue: number | null;
            outcome: string | null;
            requestId: string;
          }>(
            `SELECT h.epoch,h.state,h.expires_at <= $6::timestamptz AS expired,
               i.subject_id AS "subjectId",i.entry_incarnation_id AS "incarnationId",
               i.entry_revision AS "entryRevision",i.annotation_revision AS "annotationRevision",
               i.note_op AS "noteOp",i.note_value AS "noteValue",i.priority_op AS "priorityOp",
               i.priority_value AS "priorityValue",i.outcome,i.request_id AS "requestId"
             FROM library.entry_annotation_review AS h
             JOIN library.entry_annotation_review_item AS i
               ON i.route=h.route AND i.account_id=h.account_id AND i.review_id=h.review_id
             WHERE h.route=$1 AND h.account_id=$2 AND h.review_id=$3 AND h.epoch=$4
               AND i.position=$5
             FOR SHARE OF h,i`,
            [route, account.accountId, reviewGuard.reviewId, reviewGuard.epoch, reviewGuard.position, time],
          );
          const row = bound.rows[0];
          if (row && (row.state !== 'open' || row.expired))
            throw new EntryAnnotationReviewStoppedError(row.expired ? 'expired' : 'cancelled');
          const noteOp = parsed.note.op === 'unchanged' ? 'preserve' : parsed.note.op;
          const priorityOp = parsed.priority.op === 'unchanged' ? 'preserve' : parsed.priority.op;
          if (
            !row ||
            row.subjectId !== prepared.subjectId ||
            row.incarnationId !== parsed.entryGuard.incarnationId ||
            row.entryRevision !== parsed.entryGuard.currentRevision ||
            row.annotationRevision !== parsed.revision ||
            row.noteOp !== noteOp ||
            row.noteValue !== (parsed.note.op === 'set' ? parsed.note.value : null) ||
            row.priorityOp !== priorityOp ||
            row.priorityValue !== (parsed.priority.op === 'set' ? parsed.priority.value : null) ||
            row.requestId !== requestKey ||
            row.outcome !== null
          )
            throw new LibraryConflictError();
        }
        if (parsed.entryGuard) {
          const entry = await tx.query<{ incarnationId: string | null; revision: number }>(
            `SELECT incarnation_id AS "incarnationId",revision FROM library.entry
             WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE`,
            [route, account.accountId, prepared.subjectId],
          );
          const currentEntry = entry.rows[0];
          if (
            !currentEntry ||
            currentEntry.incarnationId !== parsed.entryGuard.incarnationId ||
            currentEntry.revision !== parsed.entryGuard.currentRevision
          )
            throw new LibraryConflictError();
          const profileGuard = parsed.entryGuard.profileGuard;
          if (profileGuard) {
            const observation = await readLibraryProfileSourceObservation(
              {
                pool,
                access,
                actor: account,
                at: command.time,
                deadline: deadlineFor(WORK_STEP_DEADLINE_MS),
              },
              profileGuard.subjectId,
            );
            if (!observation || observation.source?.kind !== 'supported')
              throw new ProblemError('unsupported_library_profile');
            if (
              observation.source.subjectId !== prepared.subjectId ||
              observation.anchor.identityEpoch.toString() !== profileGuard.identityEpoch ||
              observation.anchor.acceptingType !== profileGuard.acceptingType ||
              observation.anchor.requestedSubjectId !== profileGuard.requestedSubjectId ||
              canonicalize(observation.anchor.component) !== canonicalize(profileGuard.component) ||
              canonicalize(observation.source.pin) !== canonicalize(profileGuard.pin)
            )
              throw new LibraryConflictError();
          }
        } else {
          // Existing entries serialize annotation no-op checks with other addressed writes.
          await tx.query(
            `SELECT subject_id FROM library.entry
             WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE`,
            [route, account.accountId, prepared.subjectId],
          );
          await tx.query(
            `INSERT INTO library.entry_personal_fact
              (route,account_id,subject_id,fact_id,annotation_revision,note,priority,annotation_updated_at,
               annotation_transaction_id,created_at,updated_at,transaction_id)
             VALUES($1,$2,$3,$4,0,NULL,NULL,NULL,NULL,$5,$5,$6) ON CONFLICT DO NOTHING`,
            [
              route,
              account.accountId,
              prepared.subjectId,
              newFactId(route, prepared.subjectId),
              time,
              command.transactionId,
            ],
          );
        }
        let current = await tx.query<{ revision: number; note: string | null; priority: number | null }>(
          `SELECT annotation_revision AS revision,note,priority FROM library.entry_personal_fact
           WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE`,
          [route, account.accountId, prepared.subjectId],
        );
        let before = current.rows[0] ?? { revision: 0, note: null, priority: null };
        if (before.revision !== parsed.revision) throw new LibraryConflictError();
        if (before.revision >= 2_147_483_646) throw new LibraryConflictError();
        const note = applyFieldChange(before.note, parsed.note);
        const priority = applyFieldChange(before.priority, parsed.priority);
        if (parsed.entryGuard && note === before.note && priority === before.priority)
          return noEffect(await readPersonal(tx, route, account.accountId, prepared.subjectId));
        if (parsed.entryGuard && current.rows.length === 0) {
          await tx.query(
            `INSERT INTO library.entry_personal_fact
              (route,account_id,subject_id,fact_id,annotation_revision,note,priority,annotation_updated_at,
               annotation_transaction_id,created_at,updated_at,transaction_id)
             VALUES($1,$2,$3,$4,0,NULL,NULL,NULL,NULL,$5,$5,$6) ON CONFLICT DO NOTHING`,
            [
              route,
              account.accountId,
              prepared.subjectId,
              newFactId(route, prepared.subjectId),
              time,
              command.transactionId,
            ],
          );
          current = await tx.query<{ revision: number; note: string | null; priority: number | null }>(
            `SELECT annotation_revision AS revision,note,priority FROM library.entry_personal_fact
             WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE`,
            [route, account.accountId, prepared.subjectId],
          );
          before = current.rows[0] ?? before;
          if (before.revision !== parsed.revision) throw new LibraryConflictError();
        }
        const updated = await tx.query(
          `UPDATE library.entry_personal_fact SET annotation_revision=annotation_revision+1,note=$4,priority=$5,
             annotation_updated_at=$6,annotation_transaction_id=$7,updated_at=$6,transaction_id=$7
           WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND annotation_revision=$8
           RETURNING subject_id`,
          [route, account.accountId, prepared.subjectId, note, priority, time, command.transactionId, parsed.revision],
        );
        if (updated.rowCount !== 1) throw new LibraryConflictError();
        if (parsed.entryGuard?.reviewGuard) {
          const review = parsed.entryGuard.reviewGuard;
          const item = await tx.query(
            `UPDATE library.entry_annotation_review_item SET outcome='accepted'
             WHERE route=$1 AND account_id=$2 AND review_id=$3 AND position=$4 AND outcome IS NULL`,
            [route, account.accountId, review.reviewId, review.position],
          );
          if (item.rowCount !== 1) throw new LibraryConflictError();
        }
        return {
          value: await readPersonal(tx, route, account.accountId, prepared.subjectId),
          events: [event('com.rezics.library.entry.annotations.updated.v1', account.accountId, prepared.subjectId)],
        };
      },
    );
  }

  async function admitSourceObservation(actor: Actor, subjectId: string, input: unknown, requestKey: string) {
    const account = owner(actor, 'library_entry:update');
    requireRoute(subjectId);
    const parsed = parseObservationInput(input);
    const privacy = privacyColumns(parsed.privacy);
    const created = timestampColumns(parsed.sourceCreated);
    const updated = timestampColumns(parsed.sourceUpdated);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.entry.source-observation.admit',
        requestKey,
        input: { subjectId, ...parsed },
        async prepare(attempt) {
          try {
            return { subjectId: await resolveCanonicalSubject(dependencies, account, subjectId, attempt.time) };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const route = requireRoute(account.accountId);
        const time = authoritativeTimeValue(command.time);
        await tx.query(
          `INSERT INTO library.entry_personal_fact
            (route,account_id,subject_id,fact_id,annotation_revision,note,priority,annotation_updated_at,
             annotation_transaction_id,created_at,updated_at,transaction_id)
           VALUES($1,$2,$3,$4,0,NULL,NULL,NULL,NULL,$5,$5,$6) ON CONFLICT DO NOTHING`,
          [
            route,
            account.accountId,
            prepared.subjectId,
            newFactId(route, prepared.subjectId),
            time,
            command.transactionId,
          ],
        );
        await tx.query(
          'SELECT 1 FROM library.entry_personal_fact WHERE route=$1 AND account_id=$2 AND subject_id=$3 FOR UPDATE',
          [route, account.accountId, prepared.subjectId],
        );
        const count = await tx.query<{ total: string }>(
          'SELECT count(*)::text AS total FROM library.entry_source_observation WHERE route=$1 AND account_id=$2 AND subject_id=$3',
          [route, account.accountId, prepared.subjectId],
        );
        if (Number(count.rows[0]?.total ?? '0') >= MAX_SOURCE_OBSERVATIONS)
          throw new TypeError('Source observation limit reached');
        const inserted = await tx.query(
          `INSERT INTO library.entry_source_observation
            (route,account_id,subject_id,provider,record_id,revision,privacy_status,privacy_meaning,privacy_source_value,
             source_created_status,source_created_value,source_created_precision,source_created_zone,
             source_updated_status,source_updated_value,source_updated_precision,source_updated_zone,
             created_at,updated_at,transaction_id)
           VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17,$18)
           ON CONFLICT DO NOTHING RETURNING provider`,
          [
            route,
            account.accountId,
            prepared.subjectId,
            parsed.provider,
            parsed.recordId,
            privacy.privacyStatus,
            privacy.privacyMeaning,
            privacy.privacySourceValue,
            created.status,
            created.value,
            created.precision,
            created.zone,
            updated.status,
            updated.value,
            updated.precision,
            updated.zone,
            time,
            command.transactionId,
          ],
        );
        if (inserted.rowCount !== 1) throw new LibraryConflictError();
        await tx.query(
          `UPDATE library.entry_personal_fact SET updated_at=$4,transaction_id=$5
           WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
          [route, account.accountId, prepared.subjectId, time, command.transactionId],
        );
        const value = await readPersonal(tx, route, account.accountId, prepared.subjectId);
        const sourceObservation = value.sourceObservations.find(
          (item) => item.provider === parsed.provider && item.recordId === parsed.recordId,
        );
        if (!sourceObservation) throw new Error('Admitted source observation is missing');
        return {
          value: { sourceObservation },
          events: [
            event('com.rezics.library.entry.source-observation.admitted.v1', account.accountId, prepared.subjectId),
          ],
        };
      },
    );
  }

  async function correctSourceObservation(actor: Actor, subjectId: string, input: unknown, requestKey: string) {
    const account = owner(actor, 'library_entry:update');
    requireRoute(subjectId);
    const parsed = parseObservationCorrection(input);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.entry.source-observation.correct',
        requestKey,
        input: { subjectId, ...parsed },
        async prepare(attempt) {
          try {
            return { subjectId: await resolveCanonicalSubject(dependencies, account, subjectId, attempt.time) };
          } catch (error) {
            return { error };
          }
        },
      },
      async (tx, command, prepared) => {
        if ('error' in prepared) throw prepared.error;
        const route = requireRoute(account.accountId);
        const current = await tx.query<ObservationRow>(
          `SELECT provider,record_id AS "recordId",revision,privacy_status AS "privacyStatus",
            privacy_meaning AS "privacyMeaning",privacy_source_value AS "privacySourceValue",
            source_created_status AS "sourceCreatedStatus",
            source_created_value AS "sourceCreatedValue",source_created_precision AS "sourceCreatedPrecision",
            source_created_zone AS "sourceCreatedZone",source_updated_status AS "sourceUpdatedStatus",
            source_updated_value AS "sourceUpdatedValue",source_updated_precision AS "sourceUpdatedPrecision",
            source_updated_zone AS "sourceUpdatedZone",
            to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"
           FROM library.entry_source_observation WHERE route=$1 AND account_id=$2 AND subject_id=$3
             AND provider=$4 AND record_id=$5 FOR UPDATE`,
          [route, account.accountId, prepared.subjectId, parsed.provider, parsed.recordId],
        );
        const row = current.rows[0];
        if (!row) throw new LibraryNotFoundError();
        if (row.revision !== parsed.revision) throw new LibraryConflictError();
        if (row.revision >= 2_147_483_646) throw new LibraryConflictError();
        const currentValue = observation(row);
        const privacy =
          parsed.privacy.op === 'unchanged'
            ? currentValue.privacy
            : parsed.privacy.op === 'clear'
              ? { status: 'cleared' as const }
              : parsed.privacy.value;
        const sourceCreated =
          parsed.sourceCreated.op === 'unchanged'
            ? currentValue.sourceCreated
            : parsed.sourceCreated.op === 'clear'
              ? { status: 'cleared' as const }
              : parsed.sourceCreated.value;
        const sourceUpdated =
          parsed.sourceUpdated.op === 'unchanged'
            ? currentValue.sourceUpdated
            : parsed.sourceUpdated.op === 'clear'
              ? { status: 'cleared' as const }
              : parsed.sourceUpdated.value;
        const privacyValues = privacyColumns(privacy);
        const createdValues = timestampColumns(sourceCreated);
        const updatedValues = timestampColumns(sourceUpdated);
        const time = authoritativeTimeValue(command.time);
        const changed = await tx.query(
          `UPDATE library.entry_source_observation SET revision=revision+1,privacy_status=$6,privacy_meaning=$7,
             privacy_source_value=$8,source_created_status=$9,source_created_value=$10,source_created_precision=$11,source_created_zone=$12,
             source_updated_status=$13,source_updated_value=$14,source_updated_precision=$15,source_updated_zone=$16,
             updated_at=$17,transaction_id=$18
           WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND provider=$4 AND record_id=$5 AND revision=$19
             RETURNING provider`,
          [
            route,
            account.accountId,
            prepared.subjectId,
            parsed.provider,
            parsed.recordId,
            privacyValues.privacyStatus,
            privacyValues.privacyMeaning,
            privacyValues.privacySourceValue,
            createdValues.status,
            createdValues.value,
            createdValues.precision,
            createdValues.zone,
            updatedValues.status,
            updatedValues.value,
            updatedValues.precision,
            updatedValues.zone,
            time,
            command.transactionId,
            parsed.revision,
          ],
        );
        if (changed.rowCount !== 1) throw new LibraryConflictError();
        await tx.query(
          `UPDATE library.entry_personal_fact SET updated_at=$4,transaction_id=$5
           WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
          [route, account.accountId, prepared.subjectId, time, command.transactionId],
        );
        const value = await readPersonal(tx, route, account.accountId, prepared.subjectId);
        const sourceObservation = value.sourceObservations.find(
          (item) => item.provider === parsed.provider && item.recordId === parsed.recordId,
        );
        if (!sourceObservation) throw new Error('Corrected source observation is missing');
        return {
          value: { sourceObservation },
          events: [
            event('com.rezics.library.entry.source-observation.corrected.v1', account.accountId, prepared.subjectId),
          ],
        };
      },
    );
  }

  return {
    readPersonalEntry,
    saveAnnotations: (...args: Parameters<typeof saveAnnotations>) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => saveAnnotations(...args)),
    admitSourceObservation: (...args: Parameters<typeof admitSourceObservation>) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => admitSourceObservation(...args)),
    correctSourceObservation: (...args: Parameters<typeof correctSourceObservation>) =>
      withRequestDeadline(deadlineFor(WORK_STEP_DEADLINE_MS), () => correctSourceObservation(...args)),
  };
}
