import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readAccount } from '../access/account-data.ts';
import { admitGroup } from '../access/gates/admission.ts';
import {
  authoritativeTimeValue,
  commandTime,
  mintReadTime,
  noEffect,
  principalCommandIdentity,
  releaseOperationalTime,
} from '../command/command.ts';
import { runOperationalTransaction, type OperationalTransaction } from '../command/operational.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import type { WorkClient } from '../work/client.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { withConnection } from '../database/pool.ts';
import { createLibraryCommandRunner, LibraryNotFoundError } from './command-support.ts';
import { createSessionCommands, ProgressConflictError, ProgressInvalidError } from './sessions.ts';
import {
  createEpisodeProgressCommands,
  MAX_EPISODE_IDS,
  type EpisodeProgressView,
} from './episode-progress.ts';
import {
  readLibraryProfileSourceObservation,
  sameLibraryProfileAnchor,
  type LibraryProfileAnchor,
  type LibraryProfileSource,
} from './profile-source.ts';
import { readEpisodeSources } from './episode-source.ts';
import { nativeProgressUnit, progressUnit, type LibraryProgressUnitDescriptor } from './profile.ts';
import {
  MAX_PROGRESS_MEASURES,
  parseProgressMeasureCreate,
  parseRecord,
  parseSessionCreate,
  type ProgressMode,
} from './progress.ts';
import type { ProgressSession } from './progress-model.ts';
import type { ArchivedProgressMeasure, ArchivedProgressSession, ArchivedProgressUnit } from './copy-archive-format.ts';
import {
  COPY_ARCHIVE_LIMITS,
  parseCopyArchive,
  type ArchivedHolding,
  type ArchiveSectionCoverage,
  type CopyArchiveManifest,
} from './copy-archive-format.ts';

export type CopyArchiveDependencies = {
  pool: Pool;
  access: Access;
  workClient: WorkClient | (() => Promise<WorkClient>);
  tokens: KeyRing;
  routeKey: Uint8Array;
  clock?: KernelClock;
};
export const copyArchiveAuthorityTypes = Object.keys(bundledRelease.types);
type Header = {
  upload_id: string;
  manifest: CopyArchiveManifest;
  coverage: ArchiveSectionCoverage[];
  holding_count: number;
  progress_count: number;
  review_count: number;
  review_bytes: number;
  expires_at: string;
  cancelled: boolean;
  removing: boolean;
};
const missing = () => new ProblemError('not_found');
export type CopyArchiveProgressMeasureMapping = { sourceUnit: string; unit: string };
export type CopyArchiveProgressReviewRequest = {
  sessionId: string;
  subjectId: string;
  mode: ProgressMode;
  unit: string;
  additionalMeasures: CopyArchiveProgressMeasureMapping[];
  unitIds: string[];
};
type ProgressReviewRequest = CopyArchiveProgressReviewRequest;
type ProgressRecoveryPlan = {
  subjectId: string;
  versionSubjectId: string | null;
  mode: ProgressMode;
  unit: string;
  total: string | null;
  additionalMeasures: { unit: string; total: string | null }[];
  records: ({ kind: 'measure'; measureId: string; amount: string } | { kind: 'cursor'; locator: string; position: string })[];
  unitIds: string[];
  transition: 'complete' | 'abandon' | null;
  unsupported: string[];
};
type ProgressReviewEvidence = {
  binding: {
    subjectId: string;
    requestedSubjectId: string | null;
    acceptingType: string;
    identityEpoch: string;
    component: { partition: number; epoch: number; position: string };
    pin: Extract<NonNullable<LibraryProfileSource>, { kind: 'supported' }>['pin'] | null;
  } | null;
  plan: ProgressRecoveryPlan | null;
  response: CopyArchiveProgressReview;
};
export type CopyArchiveProgressState = 'applying' | 'partial' | 'applied' | 'stale' | 'failed';
export type CopyArchiveProgressReview = {
  uploadId: string;
  reviewId: string;
  sourceSessionId: string;
  sourceSubjectId: string;
  subjectId: string;
  historical: {
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    additionalMeasures: ArchivedProgressMeasure[];
    completedUnitCount: number;
    state: string;
    sourceRevision: number;
    versionSubjectId: string | null;
    profilePin: unknown;
    sourceTimes: { startedAt: string; completedAt: string | null; lastChangedAt: string };
  };
  current: {
    profile: { kind: 'supported' | 'unsupported'; subjectId: string; acceptingType: string; profileId?: string; releaseDigest?: string };
    mode: ProgressMode;
    unit: string;
  };
  measures: {
    sourceUnit: string;
    sourceAmount: string | null;
    sourceTotal: string | null;
    currentUnit: string | null;
    currentMeaning: LibraryProgressUnitDescriptor | null;
    amount: 'absent' | 'supported' | 'unsupported';
    total: 'supported' | 'unsupported';
  }[];
  completedUnits: { unitId: string; admission: 'member' | 'detached' | 'unavailable' }[];
  unsupportedHistoricalDates: string[];
  unsupported: string[];
  applicable: boolean;
  recovery: 'complete' | 'partial' | 'unsupported';
  expiresAt: string;
};
export type CopyArchiveProgressApplication = {
  uploadId: string;
  reviewId: string;
  state: CopyArchiveProgressState;
  sessionId: string | null;
  acceptedSteps: number;
  totalSteps: number;
  error: string | null;
};
export type CopyArchiveProgressPage = {
  uploadId: string;
  state: 'cancelled' | 'inspecting';
  expiresAt: string;
  manifest: CopyArchiveManifest;
  coverage: ArchiveSectionCoverage[];
  occurrences: { ordinal: number; evidence: ArchivedProgressSession }[];
  next: number | null;
};
export type CopyArchiveProgressUnitPage = {
  uploadId: string;
  sourceSessionId: string;
  state: 'cancelled' | 'inspecting';
  units: { ordinal: number; evidence: ArchivedProgressUnit }[];
  next: number | null;
};
export type CopyArchiveProgressResult = {
  uploadId: string;
  review: CopyArchiveProgressReview;
  application: Pick<CopyArchiveProgressApplication, 'state' | 'sessionId' | 'acceptedSteps' | 'error'> | null;
  progressSession: ProgressSession | null;
  completedEpisodes: EpisodeProgressView | null;
  expiresAt: string;
};
const sha256 = (value: string) => Buffer.from(createHash('sha256').update(value).digest());

function parseReviewRequest(value: unknown): ProgressReviewRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProblemError('invalid_request');
  const row = value as Record<string, unknown>,
    keys = ['sessionId', 'subjectId', 'mode', 'unit', 'additionalMeasures', 'unitIds'];
  if (Object.keys(row).some((key) => !keys.includes(key)) || !keys.slice(0, 6).every((key) => Object.hasOwn(row, key)))
    throw new ProblemError('invalid_request');
  if (
    typeof row.sessionId !== 'string' ||
    routeOf(row.sessionId) === null ||
    typeof row.subjectId !== 'string' ||
    routeOf(row.subjectId) === null ||
    !['scalar_amount', 'cursor_position', 'completed_units'].includes(String(row.mode)) ||
    typeof row.unit !== 'string' ||
    row.unit.length < 1 ||
    row.unit.length > 128 ||
    !Array.isArray(row.additionalMeasures) ||
    row.additionalMeasures.length > MAX_PROGRESS_MEASURES - 1 ||
    !Array.isArray(row.unitIds) ||
    row.unitIds.length > MAX_EPISODE_IDS
  )
    throw new ProblemError('invalid_request');
  const additionalMeasures: CopyArchiveProgressMeasureMapping[] = row.additionalMeasures.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new ProblemError('invalid_request');
    const mapping = candidate as Record<string, unknown>;
    if (
      Object.keys(mapping).length !== 2 ||
      typeof mapping.sourceUnit !== 'string' ||
      typeof mapping.unit !== 'string' ||
      mapping.sourceUnit.length < 1 ||
      mapping.sourceUnit.length > 128 ||
      mapping.unit.length < 1 ||
      mapping.unit.length > 128
    )
      throw new ProblemError('invalid_request');
    return { sourceUnit: mapping.sourceUnit, unit: mapping.unit };
  });
  const unitIds = row.unitIds.map((id) => {
    if (typeof id !== 'string' || id.length < 1 || id.length > 128 || id.includes('\u0000'))
      throw new ProblemError('invalid_request');
    return id;
  });
  if (
    new Set(unitIds).size !== unitIds.length ||
    new Set(additionalMeasures.map((measure) => measure.sourceUnit)).size !== additionalMeasures.length
  )
    throw new ProblemError('invalid_request');
  additionalMeasures.sort((left, right) => (left.sourceUnit < right.sourceUnit ? -1 : left.sourceUnit > right.sourceUnit ? 1 : 0));
  return {
    sessionId: row.sessionId,
    subjectId: row.subjectId,
    mode: row.mode as ProgressMode,
    unit: row.unit,
    additionalMeasures,
    unitIds,
  };
}

function profileBinding(
  anchor: LibraryProfileAnchor,
  source: NonNullable<LibraryProfileSource>,
): NonNullable<ProgressReviewEvidence['binding']> {
  return {
    subjectId: anchor.subjectId,
    requestedSubjectId: anchor.requestedSubjectId,
    acceptingType: anchor.acceptingType,
    identityEpoch: anchor.identityEpoch.toString(),
    component: {
      partition: anchor.component.partition,
      epoch: anchor.component.epoch,
      position: anchor.component.position.toString(),
    },
    pin: source.kind === 'supported' ? source.pin : null,
  };
}

function sameBinding(
  binding: ProgressReviewEvidence['binding'],
  observation: Awaited<ReturnType<typeof readLibraryProfileSourceObservation>>,
): boolean {
  if (!binding || !observation) return false;
  const current = profileBinding(observation.anchor, observation.source),
    before = binding;
  return (
    before.subjectId === current.subjectId &&
    before.requestedSubjectId === current.requestedSubjectId &&
    before.acceptingType === current.acceptingType &&
    before.identityEpoch === current.identityEpoch &&
    before.component.partition === current.component.partition &&
    before.component.epoch === current.component.epoch &&
    before.component.position === current.component.position &&
    JSON.stringify(before.pin) === JSON.stringify(current.pin)
  );
}

function nativeBinding(binding: NonNullable<ProgressReviewEvidence['binding']>) {
  if (!binding.pin) throw new ProblemError('unsupported_library_profile');
  return {
    subjectId: binding.subjectId,
    requestedSubjectId: binding.requestedSubjectId,
    acceptingType: binding.acceptingType,
    identityEpoch: binding.identityEpoch,
    component: binding.component,
    profilePin: binding.pin,
  };
}

/** Private evidence only. This service has no native copy, entry or catalogue writer. */
export function createCopyArchive(deps: CopyArchiveDependencies) {
  const clock = deps.clock ?? systemClock;
  const runner = createLibraryCommandRunner(deps);
  const sessions = createSessionCommands({ pool: deps.pool, access: deps.access, tokens: deps.tokens, clock });
  const episodes = createEpisodeProgressCommands({
    pool: deps.pool,
    access: deps.access,
    tokens: deps.tokens,
    routeKey: deps.routeKey,
    clock,
  });
  const episodeUnits = async (
    actor: Actor,
    subjectId: string,
    ids: readonly string[],
  ) => {
    const at = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
    try {
      return await readEpisodeSources(
        {
          pool: deps.pool,
          access: deps.access,
          actor,
          at,
          deadline: deadlineFor(5000),
          routeKey: deps.routeKey,
        },
        subjectId,
        ids,
      );
    } finally {
      releaseOperationalTime(at);
    }
  };
  const profileObservation = async (actor: Actor, subjectId: string) => {
    const at = await withConnection(deps.pool, (client) => mintReadTime(client, clock));
    try {
      return await readLibraryProfileSourceObservation(
        { pool: deps.pool, access: deps.access, actor, at, deadline: deadlineFor(5000) },
        subjectId,
      );
    } finally {
      releaseOperationalTime(at);
    }
  };
  function owner(actor: Actor) {
    if (actor.kind !== 'account') throw new ProblemError('authentication_required');
    if (routeOf(actor.accountId) === null || !actor.scopes.includes('copy:list')) throw new ProblemError('forbidden');
    return actor;
  }
  async function operation<T>(
    actor: Actor,
    signal: AbortSignal | undefined,
    body: (tx: OperationalTransaction, route: number, accountId: string, now: number) => Promise<T>,
    progressAction?: 'progress_session:read' | 'progress_session:create' | 'progress_session:update',
  ) {
    const a = owner(actor),
      route = routeOf(a.accountId)!;
    await admitGroup({
      pool: deps.pool,
      access: () => deps.access,
      actor,
      group: 'personal_library',
      clientAction: 'copy:list',
      deadline: deadlineFor(5000),
      clock,
    });
    if (progressAction) {
      const requiredScopes =
        progressAction === 'progress_session:create'
          ? ['progress_session:read', 'progress_session:create', 'progress_session:update']
          : [progressAction];
      for (const scope of requiredScopes)
        if (!a.scopes.includes(scope)) throw new ProblemError('forbidden');
      await admitGroup({
        pool: deps.pool,
        access: () => deps.access,
        actor,
        group: 'reading_progress',
        clientAction: progressAction,
        deadline: deadlineFor(5000),
        clock,
      });
    }
    const authorization = await accessCommandAuthorization(
      deps.access,
      a,
      progressAction ?? 'copy:list',
      { route, id: a.accountId },
      { pool: deps.pool, deadline: deadlineFor(5000) },
      () => new ProblemError('forbidden'),
    );
    return runOperationalTransaction(
      deps.pool,
      {
        mode: 'request',
        ...principalCommandIdentity(a),
        partition: partitionOf(route),
        kind: 'library.copy-archive',
        accounts: [a.accountId],
        authorization,
        clock,
        deadline: deadlineFor(5000),
        workClient: typeof deps.workClient === 'function' ? await deps.workClient() : deps.workClient,
      },
      async (tx) => {
        signal?.throwIfAborted();
        const current = await readAccount(tx, route, a.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(a.authnEpoch) ||
          a.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(a.authnEpoch)
        )
          throw new ProblemError('forbidden');
        const at = commandTime(tx);
        if (!at) throw new ProblemError('dependency_unavailable');
        const result = await body(tx, route, a.accountId, Date.parse(authoritativeTimeValue(at)));
        signal?.throwIfAborted();
        return result;
      },
    );
  }
  async function header(
    tx: OperationalTransaction,
    route: number,
    account: string,
    id: string,
    now: number,
    allowExpired = false,
  ): Promise<Header> {
    if (routeOf(id) !== route) throw missing();
    const h = (
      await tx.query<Header>(
        `SELECT upload_id,manifest,coverage,holding_count,progress_count,review_count,review_bytes,
      expires_at::text,cancelled,removing FROM library.copy_archive_upload
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 FOR UPDATE`,
        [route, account, id],
      )
    ).rows[0];
    if (!h || (!allowExpired && (h.removing || Date.parse(h.expires_at) <= now))) throw missing();
    return h;
  }
  async function upload(actor: Actor, bytes: Uint8Array, requestKey: string, signal?: AbortSignal) {
    // Admission and the terminal account barrier precede decoding, parsing and persistence.
    await operation(actor, signal, async () => undefined);
    const parsed = parseCopyArchive(bytes),
      a = owner(actor),
      route = routeOf(a.accountId)!;
    signal?.throwIfAborted();
    const outcome = await runner.ownAccount(
      actor,
      {
        action: 'copy:list',
        kind: 'library.copy-archive.upload',
        requestKey,
        input: { digest: createHash('sha256').update(bytes).digest('hex') },
      },
      async (tx, command) => {
        signal?.throwIfAborted();
        const id = newId(route);
        const expiresAt = new Date(
          Date.parse(authoritativeTimeValue(command.time)) + COPY_ARCHIVE_LIMITS.lifetimeDays * 86_400_000,
        ).toISOString();
        // One retained upload is a keyed capacity bound, including cancelled and expired evidence.
        const inserted = await tx.query(
          `INSERT INTO library.copy_archive_upload
        (route,account_id,upload_id,manifest,coverage,holding_count,progress_count,expires_at)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::timestamptz)
        ON CONFLICT (route,account_id) DO NOTHING RETURNING upload_id`,
          [
            route,
            a.accountId,
            id,
            JSON.stringify(parsed.manifest),
            JSON.stringify(parsed.coverage),
            parsed.holdings.length,
            parsed.progress.length,
            expiresAt,
          ],
        );
        if (!inserted.rowCount) throw new ProblemError('conflict');
        await tx.query(
          `INSERT INTO library.copy_archive_row
        (route,account_id,upload_id,ordinal,section,source_session_id,source_unit_id,evidence)
        SELECT $1,$2,$3,r.ordinal,r.section,r.source_session_id,r.source_unit_id,r.evidence
        FROM jsonb_to_recordset($4::jsonb) AS r(ordinal integer,section text,source_session_id uuid,source_unit_id text,evidence jsonb)`,
          [
            route,
            a.accountId,
            id,
            JSON.stringify([
              ...parsed.holdings.map((row) => ({
                ordinal: row.ordinal,
                section: 'holdings',
                source_session_id: null,
                source_unit_id: null,
                evidence: row.evidence,
              })),
              ...parsed.progress.map((row) => ({
                ordinal: row.ordinal,
                section: row.evidence.section,
                source_session_id: row.sourceSessionId,
                source_unit_id: row.sourceUnitId,
                evidence: row.evidence,
              })),
            ]),
          ],
        );
        signal?.throwIfAborted();
        // Original receipts contain no uploaded text, pins or historical row identities.
        return noEffect({
          uploadId: id,
          holdings: parsed.holdings.length,
          progressRecords: parsed.progress.length,
          expiresAt,
        });
      },
    );
    // A receipt never recreates evidence removed since the original upload.
    await operation(actor, signal, async (tx, r, account, now) => {
      await header(tx, r, account, outcome.value.uploadId, now);
    });
    return outcome;
  }
  async function page(actor: Actor, id: string, after = -1, signal?: AbortSignal) {
    if (!Number.isInteger(after) || after < -1 || after >= COPY_ARCHIVE_LIMITS.records)
      throw new ProblemError('invalid_request');
    return operation(actor, signal, async (tx, route, account, now) => {
      const h = await header(tx, route, account, id, now);
      const rows = (
        await tx.query<{ ordinal: number; evidence: ArchivedHolding }>(
        `SELECT ordinal,evidence FROM library.copy_archive_row
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='holdings' AND ordinal>$4 ORDER BY ordinal LIMIT 11`,
          [route, account, id, after],
        )
      ).rows;
      return {
        uploadId: id,
        state: h.cancelled ? ('cancelled' as const) : ('inspecting' as const),
        expiresAt: h.expires_at,
        fullRestoration: false as const,
        effectsSupported: false as const,
        manifest: h.manifest,
        coverage: h.coverage,
        holdings: h.holding_count,
        rows: rows
          .slice(0, COPY_ARCHIVE_LIMITS.page)
          .map((r) => ({
            ...r,
            resolution: 'unresolved' as const,
            reason: 'Historical evidence requires current identity, profile and explicit copy review',
          })),
        next: rows.length > COPY_ARCHIVE_LIMITS.page ? rows[COPY_ARCHIVE_LIMITS.page - 1]!.ordinal : null,
      };
    });
  }
  async function progressPage(
    actor: Actor,
    id: string,
    after = -1,
    signal?: AbortSignal,
  ): Promise<CopyArchiveProgressPage> {
    if (!Number.isInteger(after) || after < -1 || after >= COPY_ARCHIVE_LIMITS.records)
      throw new ProblemError('invalid_request');
    return operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        const h = await header(tx, route, account, id, now);
        const rows = (
          await tx.query<{ ordinal: number; evidence: ArchivedProgressSession }>(
            `SELECT ordinal,evidence FROM library.copy_archive_row
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='sessions' AND ordinal>$4
            ORDER BY ordinal LIMIT $5`,
            [route, account, id, after, COPY_ARCHIVE_LIMITS.page + 1],
          )
        ).rows;
        return {
          uploadId: id,
          state: h.cancelled ? ('cancelled' as const) : ('inspecting' as const),
          expiresAt: h.expires_at,
          manifest: h.manifest,
          coverage: h.coverage,
          occurrences: rows.slice(0, COPY_ARCHIVE_LIMITS.page).map((row) => ({
            ordinal: row.ordinal,
            evidence: row.evidence,
          })),
          next: rows.length > COPY_ARCHIVE_LIMITS.page ? rows[COPY_ARCHIVE_LIMITS.page - 1]!.ordinal : null,
        };
      },
      'progress_session:read',
    );
  }
  async function progressUnitPage(
    actor: Actor,
    id: string,
    sessionId: string,
    after = -1,
    signal?: AbortSignal,
  ): Promise<CopyArchiveProgressUnitPage> {
    if (
      !Number.isInteger(after) ||
      after < -1 ||
      after >= COPY_ARCHIVE_LIMITS.records ||
      routeOf(sessionId) === null
    )
      throw new ProblemError('invalid_request');
    return operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        const h = await header(tx, route, account, id, now);
        if (routeOf(sessionId) !== route) throw missing();
        if (
          !(
            await tx.query(
              `SELECT 1 FROM library.copy_archive_row
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='sessions' AND source_session_id=$4 LIMIT 1`,
              [route, account, id, sessionId],
            )
          ).rowCount
        )
          throw missing();
        const rows = (
          await tx.query<{ ordinal: number; evidence: ArchivedProgressUnit }>(
            `SELECT ordinal,evidence FROM library.copy_archive_row
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='units'
              AND source_session_id=$4 AND ordinal>$5 ORDER BY ordinal LIMIT $6`,
            [route, account, id, sessionId, after, COPY_ARCHIVE_LIMITS.page + 1],
          )
        ).rows;
        return {
          uploadId: id,
          sourceSessionId: sessionId,
          state: h.cancelled ? ('cancelled' as const) : ('inspecting' as const),
          units: rows.slice(0, COPY_ARCHIVE_LIMITS.page).map((row) => ({ ordinal: row.ordinal, evidence: row.evidence })),
          next: rows.length > COPY_ARCHIVE_LIMITS.page ? rows[COPY_ARCHIVE_LIMITS.page - 1]!.ordinal : null,
        };
      },
      'progress_session:read',
    );
  }
  async function reviewProgress(
    actor: Actor,
    id: string,
    requestKey: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<CopyArchiveProgressReview> {
    const request = parseReviewRequest(input),
      requestDigest = sha256(JSON.stringify(request)),
      requestKeyHash = sha256(requestKey);
    const evidence = await operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        const h = await header(tx, route, account, id, now);
        const previous = (
          await tx.query<{ review_id: string; input_digest: Buffer; evidence: ProgressReviewEvidence }>(
            `SELECT review_id,input_digest,evidence FROM library.copy_archive_progress_review
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND request_key_hash=$4`,
            [route, account, id, requestKeyHash],
          )
        ).rows[0];
        if (previous) {
          if (!previous.input_digest.equals(requestDigest)) throw new ProblemError('idempotency_conflict');
          return { replay: previous.evidence };
        }
        const session = (
          await tx.query<{ ordinal: number; evidence: ArchivedProgressSession }>(
            `SELECT ordinal,evidence FROM library.copy_archive_row
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='sessions' AND source_session_id=$4 LIMIT 1`,
            [route, account, id, request.sessionId],
          )
        ).rows[0];
        if (!session || routeOf(request.sessionId) !== route) throw missing();
        const units = request.unitIds.length
          ? (
              await tx.query<{ source_unit_id: string }>(
                `SELECT source_unit_id FROM library.copy_archive_row
                WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND section='units'
                  AND source_session_id=$4 AND source_unit_id=ANY($5::text[])`,
                [route, account, id, request.sessionId, request.unitIds],
              )
            ).rows.map((row) => row.source_unit_id)
          : [];
        if (units.length !== request.unitIds.length) throw new ProblemError('invalid_request');
        return { replay: null, route, session, units, expiresAt: h.expires_at };
      },
      'progress_session:read',
    );
    if (evidence.replay) return evidence.replay.response;
    signal?.throwIfAborted();
    const observation = await profileObservation(actor, request.subjectId);
    if (!observation || observation.source.subjectId !== request.subjectId) throw missing();
    let unitReview: { unitId: string; admission: 'member' | 'detached' | 'unavailable' }[] = [];
    const canonicalUnitIds = request.unitIds.filter((unitId) => routeOf(unitId) !== null);
    if (
      request.mode === 'completed_units' &&
      request.unit === 'episode' &&
      canonicalUnitIds.length > 0 &&
      observation.source.kind === 'supported' &&
      nativeProgressUnit(observation.source.profile, { mode: request.mode, unit: request.unit })
    ) {
      const membership = await episodeUnits(actor, request.subjectId, canonicalUnitIds),
        admitted = new Map(canonicalUnitIds.map((unitId, index) => [unitId, membership[index]?.membership]));
      unitReview = request.unitIds.map((unitId, index) => ({
        unitId,
        admission: admitted.get(unitId) === 'member'
          ? 'member'
          : admitted.get(unitId) === 'detached'
            ? 'detached'
            : 'unavailable',
      }));
    } else {
      unitReview = request.unitIds.map((unitId) => ({ unitId, admission: 'unavailable' as const }));
    }
    signal?.throwIfAborted();
    const currentObservation = await profileObservation(actor, request.subjectId);
    if (!currentObservation || !sameLibraryProfileAnchor(observation.anchor, currentObservation.anchor))
      throw new ProblemError('conflict');
    if (
      observation.source.kind !== currentObservation.source.kind ||
      (observation.source.kind === 'supported' &&
        currentObservation.source.kind === 'supported' &&
        JSON.stringify(observation.source.pin) !== JSON.stringify(currentObservation.source.pin))
    )
      throw new ProblemError('conflict');
    const binding = profileBinding(observation.anchor, observation.source),
      archived = evidence.session.evidence,
      unsupported: string[] = [],
      measureReviews: CopyArchiveProgressReview['measures'] = [];
    let plan: ProgressRecoveryPlan | null = null;
    if (archived.mode !== request.mode) unsupported.push('mode-mapping-not-supported');
    if (observation.source.kind !== 'supported') unsupported.push('current-profile-unavailable');
    const stateAdmitted = archived.state === 'active' || archived.state === 'completed' || archived.state === 'abandoned';
    if (!stateAdmitted)
      unsupported.push('historical-state-not-expressible');
    if (archived.version_subject_id !== null) unsupported.push('version-subject-mapping-not-supported');
    if (!Object.hasOwn(archived, 'additional_measures')) unsupported.push('additional-measures-not-in-source-record');

    if (stateAdmitted && archived.mode === request.mode && observation.source.kind === 'supported') {
      const profile = observation.source.profile,
        descriptor = progressUnit(profile, request.mode, request.unit),
        currentUnit = nativeProgressUnit(profile, { mode: request.mode, unit: request.unit });
      if (!descriptor || !currentUnit) unsupported.push('primary-unit-not-admitted');
      else if (archived.mode === 'scalar_amount') {
        const records: ProgressRecoveryPlan['records'] = [],
          additionalMeasures: ProgressRecoveryPlan['additionalMeasures'] = [],
          usedUnits = new Set<string>([request.unit]);
        let total = archived.total;
        const totalCheck = parseSessionCreate(
          {
            subjectId: request.subjectId,
            mode: 'scalar_amount',
            unit: request.unit,
            total,
          },
          descriptor,
        );
        if (!totalCheck.ok && total !== null) {
          const withoutTotal = parseSessionCreate(
            { subjectId: request.subjectId, mode: 'scalar_amount', unit: request.unit, total: null },
            descriptor,
          );
          if (withoutTotal.ok) {
            unsupported.push(`total:${archived.unit}`);
            total = null;
          }
        }
        const primaryCreate = parseSessionCreate(
          { subjectId: request.subjectId, mode: 'scalar_amount', unit: request.unit, total },
          descriptor,
        );
        let applicable = primaryCreate.ok;
        if (!applicable) unsupported.push(`primary-total:${archived.unit}`);
        const sourceMeasures: ArchivedProgressMeasure[] = archived.additional_measures ?? [];
        const mappedSources = new Set<string>();
        for (const mapping of request.additionalMeasures) {
          const sourceMeasure = sourceMeasures.find((candidate) => candidate.unit === mapping.sourceUnit),
            extraDescriptor = progressUnit(profile, 'scalar_amount', mapping.unit),
            extraUnit = extraDescriptor && nativeProgressUnit(profile, { mode: 'scalar_amount', unit: mapping.unit });
          if (!sourceMeasure) {
            unsupported.push(`unknown-source-measure:${mapping.sourceUnit}`);
            continue;
          }
          mappedSources.add(mapping.sourceUnit);
          if (!extraDescriptor || !extraUnit || usedUnits.has(mapping.unit)) {
            measureReviews.push({
              sourceUnit: sourceMeasure.unit,
              sourceAmount: sourceMeasure.amount,
              sourceTotal: sourceMeasure.total,
              currentUnit: mapping.unit,
              currentMeaning: extraDescriptor ?? null,
              amount: sourceMeasure.amount === null ? 'absent' : 'unsupported',
              total: 'unsupported',
            });
            unsupported.push(`additional-unit:${sourceMeasure.unit}`);
            continue;
          }
          usedUnits.add(mapping.unit);
          let extraTotal = sourceMeasure.total,
            parsedExtra = parseProgressMeasureCreate({ unit: mapping.unit, total: extraTotal }, extraDescriptor);
          if (!parsedExtra.ok && extraTotal !== null) {
            const withoutTotal = parseProgressMeasureCreate({ unit: mapping.unit, total: null }, extraDescriptor);
            if (withoutTotal.ok) {
              unsupported.push(`total:${sourceMeasure.unit}`);
              extraTotal = null;
              parsedExtra = withoutTotal;
            }
          }
          if (!parsedExtra.ok) {
            unsupported.push(`additional-total:${sourceMeasure.unit}`);
            measureReviews.push({
              sourceUnit: sourceMeasure.unit,
              sourceAmount: sourceMeasure.amount,
              sourceTotal: sourceMeasure.total,
              currentUnit: mapping.unit,
              currentMeaning: extraDescriptor,
              amount: sourceMeasure.amount === null ? 'absent' : 'unsupported',
              total: 'unsupported',
            });
            continue;
          }
          additionalMeasures.push(parsedExtra.value);
          let amountStatus: 'absent' | 'supported' | 'unsupported' = 'absent';
          if (sourceMeasure.amount !== null) {
            const parsedAmount = parseRecord(
              'scalar_amount',
              { amount: sourceMeasure.amount },
              { unit: mapping.unit, state: 'active' },
              extraDescriptor,
            );
            if (parsedAmount.ok && 'amount' in parsedAmount.value) {
              records.push({ kind: 'measure', measureId: mapping.unit, amount: parsedAmount.value.amount });
              amountStatus = 'supported';
            } else {
              amountStatus = 'unsupported';
              unsupported.push(`amount:${sourceMeasure.unit}`);
            }
          }
          measureReviews.push({
            sourceUnit: sourceMeasure.unit,
            sourceAmount: sourceMeasure.amount,
            sourceTotal: sourceMeasure.total,
            currentUnit: mapping.unit,
            currentMeaning: extraDescriptor,
            amount: amountStatus,
            total: extraTotal === sourceMeasure.total ? 'supported' : 'unsupported',
          });
        }
        for (const sourceMeasure of sourceMeasures)
          if (!mappedSources.has(sourceMeasure.unit)) {
            measureReviews.push({
              sourceUnit: sourceMeasure.unit,
              sourceAmount: sourceMeasure.amount,
              sourceTotal: sourceMeasure.total,
              currentUnit: null,
              currentMeaning: null,
              amount: sourceMeasure.amount === null ? 'absent' : 'unsupported',
              total: 'unsupported',
            });
            unsupported.push(`unmapped-additional-measure:${sourceMeasure.unit}`);
          }
        if (archived.amount !== null) {
          const parsedAmount = parseRecord(
            'scalar_amount',
            { amount: archived.amount },
            { unit: request.unit, state: 'active' },
            descriptor,
          );
          if (parsedAmount.ok && 'amount' in parsedAmount.value)
            records.unshift({ kind: 'measure', measureId: request.unit, amount: parsedAmount.value.amount });
          else unsupported.push(`amount:${archived.unit}`);
        }
        measureReviews.unshift({
          sourceUnit: archived.unit,
          sourceAmount: archived.amount,
          sourceTotal: archived.total,
          currentUnit: request.unit,
          currentMeaning: descriptor,
          amount: archived.amount === null ? 'absent' : records.some((record) => record.kind === 'measure' && record.measureId === request.unit) ? 'supported' : 'unsupported',
          total: total === archived.total ? 'supported' : 'unsupported',
        });
        const create = parseSessionCreate(
          {
            subjectId: request.subjectId,
            mode: 'scalar_amount',
            unit: request.unit,
            total,
            ...(additionalMeasures.length ? { additionalMeasures } : {}),
          },
          descriptor,
        );
        applicable &&= create.ok;
        if (applicable && archived.state !== 'active') {
          plan = {
            subjectId: request.subjectId,
            versionSubjectId: null,
            mode: 'scalar_amount',
            unit: request.unit,
            total,
            additionalMeasures,
            records,
            unitIds: [],
            transition: archived.state === 'completed' ? 'complete' : 'abandon',
            unsupported,
          };
        } else if (applicable) {
          plan = {
            subjectId: request.subjectId,
            versionSubjectId: null,
            mode: 'scalar_amount',
            unit: request.unit,
            total,
            additionalMeasures,
            records,
            unitIds: [],
            transition: null,
            unsupported,
          };
        }
      } else if (archived.mode === 'cursor_position') {
        const parsedCreate = parseSessionCreate(
          { subjectId: request.subjectId, mode: 'cursor_position', unit: request.unit },
          descriptor,
        );
        let record: ProgressRecoveryPlan['records'][number] | null = null;
        if (archived.position !== null && archived.locator !== null) {
          const parsed = parseRecord(
            'cursor_position',
            { locator: archived.locator, position: archived.position },
            { unit: request.unit, state: 'active' },
            descriptor,
          );
          if (parsed.ok && 'locator' in parsed.value)
            record = { kind: 'cursor', locator: parsed.value.locator, position: parsed.value.position };
          else unsupported.push('cursor-value-not-admitted');
        } else if (archived.position !== null || archived.locator !== null) unsupported.push('incomplete-cursor-value');
        if (parsedCreate.ok)
          plan = {
            subjectId: request.subjectId,
            versionSubjectId: null,
            mode: 'cursor_position',
            unit: request.unit,
            total: null,
            additionalMeasures: [],
            records: record ? [record] : [],
            unitIds: [],
            transition: archived.state === 'completed' ? 'complete' : archived.state === 'abandoned' ? 'abandon' : null,
            unsupported,
          };
        else if (!parsedCreate.ok) unsupported.push('cursor-unit-not-admitted');
      } else if (archived.mode === 'completed_units') {
        const parsedCreate = parseSessionCreate(
          { subjectId: request.subjectId, mode: 'completed_units', unit: request.unit },
          descriptor,
        );
        const admittedIds = unitReview.filter((unit) => unit.admission === 'member').map((unit) => unit.unitId);
        const unsupportedUnits = unitReview.filter((unit) => unit.admission !== 'member');
        if (unsupportedUnits.length) unsupported.push(`units-not-admitted:${unsupportedUnits.length}`);
        if (archived.completed_unit_count > admittedIds.length) unsupported.push('source-count-not-fully-identified');
        if (parsedCreate.ok && (archived.completed_unit_count === 0 || admittedIds.length > 0))
          plan = {
            subjectId: request.subjectId,
            versionSubjectId: null,
            mode: 'completed_units',
            unit: request.unit,
            total: null,
            additionalMeasures: [],
            records: [],
            unitIds: admittedIds,
            transition: archived.state === 'completed' ? 'complete' : archived.state === 'abandoned' ? 'abandon' : null,
            unsupported,
          };
        else if (!parsedCreate.ok) unsupported.push('completed-unit-mode-not-admitted');
        else unsupported.push('source-count-without-supported-unit-identities');
      }
    }
    const profileSummary = {
      kind: observation.source.kind,
      subjectId: observation.source.subjectId,
      acceptingType: observation.anchor.acceptingType,
      ...(observation.source.kind === 'supported'
        ? { profileId: observation.source.pin.profileId, releaseDigest: observation.source.pin.releaseDigest }
        : {}),
    };
    const reviewId = newId(evidence.route),
      response: CopyArchiveProgressReview = {
        uploadId: id,
        reviewId,
        sourceSessionId: archived.session_id,
        sourceSubjectId: archived.subject_id,
        subjectId: request.subjectId,
        historical: {
          mode: archived.mode,
          unit: archived.unit,
          total: archived.total,
          amount: archived.amount,
          additionalMeasures: archived.additional_measures ?? [],
          completedUnitCount: archived.completed_unit_count,
          state: archived.state,
          sourceRevision: archived.revision,
          versionSubjectId: archived.version_subject_id,
          profilePin: archived.library_profile_pin,
          sourceTimes: {
            startedAt: archived.started_at,
            completedAt: archived.completed_at,
            lastChangedAt: archived.last_changed_at,
          },
        },
        current: { profile: profileSummary, mode: request.mode, unit: request.unit },
        measures: measureReviews,
        completedUnits: unitReview,
        unsupportedHistoricalDates: ['started_at', 'completed_at', 'last_changed_at'],
        unsupported,
        applicable: plan !== null,
        recovery: plan === null ? 'unsupported' : unsupported.length ? 'partial' : 'complete',
        expiresAt: evidence.expiresAt,
      };
    const stored: ProgressReviewEvidence = { binding, plan, response };
    const evidenceBytes = Buffer.byteLength(JSON.stringify(stored), 'utf8');
    if (evidenceBytes > 32768) throw new ProblemError('invalid_request');
    signal?.throwIfAborted();
    return operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        const h = await header(tx, route, account, id, now);
        if (h.cancelled || h.review_count >= 4096 || h.review_bytes + evidenceBytes > 32 * 1024 * 1024)
          throw new ProblemError('conflict');
        const reviewIdForOwner = reviewId;
        const added = await tx.query(
          `INSERT INTO library.copy_archive_progress_review
          (route,account_id,upload_id,review_id,source_session_id,source_ordinal,subject_id,binding,
            request_key_hash,input_digest,evidence,evidence_bytes,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,to_timestamp($13/1000.0))
          ON CONFLICT (route,account_id,upload_id,request_key_hash) DO NOTHING RETURNING review_id`,
          [
            route,
            account,
            id,
            reviewIdForOwner,
            request.sessionId,
            evidence.session.ordinal,
            request.subjectId,
            JSON.stringify(binding),
            requestKeyHash,
            requestDigest,
            JSON.stringify(stored),
            evidenceBytes,
            now,
          ],
        );
        if (!added.rowCount) {
          const prior = (
            await tx.query<{ input_digest: Buffer; evidence: ProgressReviewEvidence }>(
              `SELECT input_digest,evidence FROM library.copy_archive_progress_review
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND request_key_hash=$4`,
              [route, account, id, requestKeyHash],
            )
          ).rows[0];
          if (!prior || !prior.input_digest.equals(requestDigest)) throw new ProblemError('idempotency_conflict');
          return prior.evidence.response;
        }
        await tx.query(
          `UPDATE library.copy_archive_upload SET review_count=review_count+1,review_bytes=review_bytes+$4
          WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
          [route, account, id, evidenceBytes],
        );
        return response;
      },
      'progress_session:read',
    );
  }
  function recoverySteps(plan: ProgressRecoveryPlan) {
    return [
      { kind: 'create' as const },
      ...plan.records.map((record) => ({ kind: 'record' as const, record })),
      ...(plan.unitIds.length ? [{ kind: 'episodes' as const }] : []),
      ...(plan.transition ? [{ kind: 'transition' as const, action: plan.transition }] : []),
    ];
  }
  async function applyProgress(
    actor: Actor,
    id: string,
    reviewId: string,
    requestKey: string,
    signal?: AbortSignal,
    onCommand?: (receipt: { partition: number; epoch: number; position: bigint }) => void,
  ): Promise<CopyArchiveProgressApplication> {
    if (routeOf(reviewId) === null) throw new ProblemError('invalid_request');
    const requestKeyHash = sha256(requestKey);
    const initial = await operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        await header(tx, route, account, id, now);
        const review = (
          await tx.query<{ evidence: ProgressReviewEvidence }>(
            `SELECT evidence FROM library.copy_archive_progress_review
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
            [route, account, id, reviewId],
          )
        ).rows[0];
        if (!review) throw missing();
        if (!review.evidence.plan || !review.evidence.binding?.pin)
          throw new ProblemError('unsupported_library_profile');
        return { evidence: review.evidence, route };
      },
      'progress_session:create',
    );
    const steps = recoverySteps(initial.evidence.plan!),
      totalSteps = steps.length;
    for (;;) {
      signal?.throwIfAborted();
      const reservation = await operation(
        actor,
        signal,
        async (tx, route, account, now) => {
          const h = await header(tx, route, account, id, now);
          const app = (
            await tx.query<{
              request_key_hash: Buffer;
              state: CopyArchiveProgressState;
              next_step: number;
              active_step: number | null;
              session_id: string | null;
              error_code: string | null;
            }>(
              `SELECT request_key_hash,state,next_step,active_step,session_id,error_code
              FROM library.copy_archive_progress_apply
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4 FOR UPDATE`,
              [route, account, id, reviewId],
            )
          ).rows[0];
          if (app && !app.request_key_hash.equals(requestKeyHash)) throw new ProblemError('idempotency_conflict');
          let current = app;
          if (!current) {
            if (h.cancelled) throw new ProblemError('conflict');
            const keyOwner = (
              await tx.query<{ review_id: string }>(
                `SELECT review_id FROM library.copy_archive_progress_apply
                WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND request_key_hash=$4
                LIMIT 1`,
                [route, account, id, requestKeyHash],
              )
            ).rows[0];
            if (keyOwner && keyOwner.review_id !== reviewId) throw new ProblemError('idempotency_conflict');
            current = (
              await tx.query({
                text: `INSERT INTO library.copy_archive_progress_apply
                (route,account_id,upload_id,review_id,request_key_hash,state,updated_at)
                VALUES($1,$2,$3,$4,$5,'applying',to_timestamp($6/1000.0))
                RETURNING request_key_hash,state,next_step,active_step,session_id,error_code`,
                values: [route, account, id, reviewId, requestKeyHash, now],
              })
            ).rows[0] as NonNullable<typeof current>;
          }
          if (['applied', 'partial', 'stale', 'failed'].includes(current.state))
            return {
              done: true as const,
              state: current.state,
              sessionId: current.session_id,
              acceptedSteps: current.next_step,
              error: current.error_code,
            };
          if (current.active_step !== null)
            return {
              done: false as const,
              step: current.active_step,
              sessionId: current.session_id,
              cancelled: h.cancelled,
            };
          if (h.cancelled) {
            await tx.query(
              `UPDATE library.copy_archive_progress_apply SET state='partial',updated_at=to_timestamp($5/1000.0)
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
              [route, account, id, reviewId, now],
            );
            return {
              done: true as const,
              state: 'partial' as const,
              sessionId: current.session_id,
              acceptedSteps: current.next_step,
              error: null,
            };
          }
          if (current.next_step >= totalSteps) {
            await tx.query(
              `UPDATE library.copy_archive_progress_apply SET state='applied',updated_at=to_timestamp($5/1000.0)
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
              [route, account, id, reviewId, now],
            );
            return {
              done: true as const,
              state: 'applied' as const,
              sessionId: current.session_id,
              acceptedSteps: current.next_step,
              error: null,
            };
          }
          const step = current.next_step;
          await tx.query(
            `UPDATE library.copy_archive_progress_apply SET active_step=$5,updated_at=to_timestamp($6/1000.0)
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
            [route, account, id, reviewId, step, now],
          );
          return { done: false as const, step, sessionId: current.session_id, cancelled: false };
        },
        'progress_session:create',
      );
      if (reservation.done)
        return applicationResult(
          id,
          reviewId,
          reservation.state,
          reservation.sessionId,
          totalSteps,
          reservation.error,
          reservation.acceptedSteps,
        );
      const step = steps[reservation.step];
      if (!step) throw new Error('Invalid archive progress step');
      signal?.throwIfAborted();
      const plan = initial.evidence.plan!;
      const expected = nativeBinding(initial.evidence.binding!);
      let sessionId = reservation.sessionId;
      try {
        const nativeKey = `archive:${reviewId}:${reservation.step}`;
        if (step.kind === 'create') {
          const created = await sessions.startSession(
            actor,
            {
              subjectId: plan.subjectId,
              versionSubjectId: null,
              mode: plan.mode,
              unit: plan.unit,
              ...(plan.mode === 'scalar_amount' ? { total: plan.total } : {}),
              ...(plan.additionalMeasures.length ? { additionalMeasures: plan.additionalMeasures } : {}),
            },
            nativeKey,
            expected,
          );
          onCommand?.(created);
          sessionId = created.value.id;
        } else {
          if (!sessionId) throw new Error('Archive progress session was not created');
          const current = await sessions.readSession(actor, sessionId);
          if (step.kind === 'record') {
            const body = step.record.kind === 'measure'
              ? { revision: current.revision, measureId: step.record.measureId, amount: step.record.amount }
              : { revision: current.revision, locator: step.record.locator, position: step.record.position };
            const recorded = await sessions.recordProgress(actor, sessionId, body, nativeKey, expected);
            onCommand?.(recorded);
          } else if (step.kind === 'episodes') {
            const recorded = await episodes.recordEpisodes(
              actor,
              sessionId,
              { revision: current.revision, add: plan.unitIds },
              nativeKey,
              expected,
            );
            onCommand?.(recorded);
          } else if (step.kind === 'transition') {
            const transitioned = step.action === 'complete'
              ? await sessions.completeSession(actor, sessionId, { revision: current.revision }, nativeKey, expected)
              : await sessions.abandonSession(actor, sessionId, { revision: current.revision }, nativeKey, expected);
            onCommand?.(transitioned);
          }
        }
        signal?.throwIfAborted();
        const checkpoint = await operation(
          actor,
          signal,
          async (tx, route, account, now) => {
            const h = await header(tx, route, account, id, now);
            const current = (
              await tx.query<{ next_step: number; active_step: number | null; request_key_hash: Buffer }>(
                `SELECT next_step,active_step,request_key_hash FROM library.copy_archive_progress_apply
                WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4 FOR UPDATE`,
                [route, account, id, reviewId],
              )
            ).rows[0];
            if (!current || !current.request_key_hash.equals(requestKeyHash)) throw missing();
            if (current.next_step > reservation.step)
              return { state: 'applying', sessionId };
            if (current.active_step !== reservation.step) throw new ProblemError('conflict');
            const next = reservation.step + 1,
              state = next >= totalSteps ? 'applied' : h.cancelled ? 'partial' : 'applying';
            await tx.query(
              `UPDATE library.copy_archive_progress_apply SET session_id=COALESCE(session_id,$5),
              next_step=$6,active_step=NULL,state=$7,updated_at=to_timestamp($8/1000.0)
              WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
              [route, account, id, reviewId, sessionId, next, state, now],
            );
            return { state, sessionId };
          },
          'progress_session:create',
        );
        if (checkpoint.state === 'partial' || checkpoint.state === 'applied')
          return applicationResult(id, reviewId, checkpoint.state, sessionId, totalSteps, null, reservation.step + 1);
      } catch (error) {
        const failure: { state: CopyArchiveProgressState; code: string } | null =
          error instanceof ProblemError && ['conflict', 'not_found', 'unsupported_library_profile'].includes(error.code)
            ? { state: error.code === 'unsupported_library_profile' || error.code === 'conflict' ? 'stale' : 'failed', code: error.code }
            : error instanceof ProgressConflictError
              ? { state: 'stale', code: 'conflict' }
              : error instanceof ProgressInvalidError
                ? { state: 'failed', code: 'invalid_request' }
                : error instanceof LibraryNotFoundError
                  ? { state: 'failed', code: 'not_found' }
                  : null;
        if (failure) {
          await operation(
            actor,
            signal,
            async (tx, route, account, now) => {
              await tx.query(
                `UPDATE library.copy_archive_progress_apply SET state=$5,error_code=$6,active_step=NULL,
                session_id=COALESCE(session_id,$7),updated_at=to_timestamp($8/1000.0)
                WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
                [route, account, id, reviewId, failure.state, failure.code, sessionId, now],
              );
            },
            'progress_session:create',
          );
          return applicationResult(id, reviewId, failure.state, sessionId, totalSteps, failure.code, reservation.step);
        }
        throw error;
      }
    }
  }
  function applicationResult(
    uploadId: string,
    reviewId: string,
    state: CopyArchiveProgressState,
    sessionId: string | null,
    totalSteps: number,
    error: string | null,
    acceptedSteps = state === 'applied' ? totalSteps : 0,
  ) {
    return {
      uploadId,
      reviewId,
      state,
      sessionId,
      acceptedSteps,
      totalSteps,
      error,
    };
  }
  async function progressResult(
    actor: Actor,
    id: string,
    reviewId: string,
    signal?: AbortSignal,
  ): Promise<CopyArchiveProgressResult> {
    if (routeOf(reviewId) === null) throw new ProblemError('invalid_request');
    const captured = await operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        const h = await header(tx, route, account, id, now);
        const review = (
          await tx.query<{ evidence: ProgressReviewEvidence }>(
            `SELECT evidence FROM library.copy_archive_progress_review
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
            [route, account, id, reviewId],
          )
        ).rows[0];
        if (!review) throw missing();
        const app = (
          await tx.query<{
            state: CopyArchiveProgressState;
            next_step: number;
            session_id: string | null;
            error_code: string | null;
          }>(
            `SELECT state,next_step,session_id,error_code FROM library.copy_archive_progress_apply
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
            [route, account, id, reviewId],
          )
        ).rows[0];
        return { review: review.evidence, app: app ?? null, expiresAt: h.expires_at };
      },
      'progress_session:read',
    );
    const app = captured.app;
    if (!app?.session_id)
      return {
        uploadId: id,
        review: captured.review.response,
        application: app ? { state: app.state, sessionId: null, acceptedSteps: app.next_step, error: app.error_code } : null,
        progressSession: null,
        completedEpisodes: null,
        expiresAt: captured.expiresAt,
      };
    signal?.throwIfAborted();
    const progressSession = await sessions.readSession(actor, app.session_id);
    const completedEpisodes = captured.review.plan?.unitIds.length
      ? await episodes.readEpisodes(actor, app.session_id, { ids: captured.review.plan.unitIds })
      : null;
    signal?.throwIfAborted();
    return operation(
      actor,
      signal,
      async (tx, route, account, now) => {
        await header(tx, route, account, id, now);
        const current = (
            await tx.query<{
              state: CopyArchiveProgressState;
              next_step: number;
              session_id: string | null;
              error_code: string | null;
            }>(
            `SELECT state,next_step,session_id,error_code FROM library.copy_archive_progress_apply
            WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND review_id=$4`,
            [route, account, id, reviewId],
          )
        ).rows[0];
        if (!current || current.session_id !== app.session_id) throw missing();
        return {
          uploadId: id,
          review: captured.review.response,
          application: {
            state: current.state,
            sessionId: current.session_id,
            acceptedSteps: current.next_step,
            error: current.error_code,
          },
          progressSession,
          completedEpisodes,
          expiresAt: captured.expiresAt,
        };
      },
      'progress_session:read',
    );
  }
  async function cancel(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor, signal, async (tx, route, account, now) => {
      await header(tx, route, account, id, now);
      await tx.query(
        'UPDATE library.copy_archive_upload SET cancelled=true WHERE route=$1 AND account_id=$2 AND upload_id=$3',
        [route, account, id],
      );
      return { uploadId: id, cancelled: true as const };
    });
  }
  async function remove(actor: Actor, id: string, signal?: AbortSignal) {
    return operation(actor, signal, async (tx, route, account, now) => {
      await header(tx, route, account, id, now, true);
      await tx.query(
        `UPDATE library.copy_archive_upload SET removing=true,cancelled=true
        WHERE route=$1 AND account_id=$2 AND upload_id=$3`,
        [route, account, id],
      );
      const removed = await removeCopyArchivePage(tx, route, account, id);
      return { uploadId: id, ...removed };
    });
  }
  return { upload, page, progressPage, progressUnitPage, reviewProgress, applyProgress, progressResult, cancel, remove };
}

/** Caller holds the root lock and owns account/terminal admission. Never cascade an unbounded child set. */
export async function removeCopyArchivePage(
  tx: Pick<OperationalTransaction, 'query'>,
  route: number,
  accountId: string,
  id: string,
) {
  let budget = COPY_ARCHIVE_LIMITS.cleanup,
    removed = 0;
  for (const child of [
    { table: 'library.copy_archive_progress_apply', key: 'review_id' },
    { table: 'library.copy_archive_progress_review', key: 'review_id' },
    { table: 'library.copy_archive_row', key: 'ordinal' },
  ]) {
    if (!budget) break;
    const count = await tx.query(
      `WITH keys AS MATERIALIZED (SELECT ${child.key} FROM ${child.table}
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 ORDER BY ${child.key} LIMIT $4)
      DELETE FROM ${child.table} child USING keys k WHERE child.route=$1 AND child.account_id=$2
        AND child.upload_id=$3 AND child.${child.key}=k.${child.key}`,
      [route, accountId, id, budget],
    );
    const countRemoved = count.rowCount ?? 0;
    removed += countRemoved;
    budget -= countRemoved;
  }
  const root = await tx.query(
    `DELETE FROM library.copy_archive_upload u
    WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND NOT EXISTS
    (SELECT 1 FROM library.copy_archive_row r WHERE r.route=u.route AND r.account_id=u.account_id
      AND r.upload_id=u.upload_id)
      AND NOT EXISTS (SELECT 1 FROM library.copy_archive_progress_review r
        WHERE r.route=u.route AND r.account_id=u.account_id AND r.upload_id=u.upload_id)
      AND NOT EXISTS (SELECT 1 FROM library.copy_archive_progress_apply a
        WHERE a.route=u.route AND a.account_id=u.account_id AND a.upload_id=u.upload_id)`,
    [route, accountId, id],
  );
  return { removed, complete: (root.rowCount ?? 0) > 0 };
}
