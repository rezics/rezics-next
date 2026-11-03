import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { Pool, PoolClient } from 'pg';
import type { KernelClock } from '../clock.ts';
import { mintReadTime, noEffect } from '../command/command.ts';
import { readAccount } from '../access/account-data.ts';
import accountShare from '../access/account-share.sql';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { withConnection } from '../database/pool.ts';
import { partitionReadClient } from '../database/read-snapshot.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { accessCheck, type Access, type AccountActor, type Actor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, partitionOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import readClaim from '../semantic/bulk-read-claim.sql';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import type { LibraryProfileDescriptor } from './profile.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import { readEntry } from './entry-store.ts';
import {
  createAniListLabelAdoption,
  type AniListLabelReview,
  type AniListLabelWork,
} from './list-import-anilist-labels.ts';
import { aniListLabelEvidence, ANILIST_LABEL_LIMITS } from './list-import-anilist-label-evidence.ts';
import { ANILIST_LIMITS, AniListInputError, parseAniList, type AniListRow } from './list-import-anilist-parser.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import { createSessionCommands } from './sessions.ts';
import {
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  applyEntryImportMetadataCommands,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  parseEntryImportMetadataSelections,
  type EntryImportMetadataOutcome,
  type EntryImportMetadataProposal,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';
import {
  describeProgressSources,
  executeProgressAdoption,
  progressResults,
  reviewProgressAdoption,
  type ProgressAdoptionCheckpoint,
  type ProgressAdoptionInput,
  type ProgressAdoptionPlan,
  type ProgressProfileBinding,
  type ProgressSourceValue,
} from './list-import-progress-adoption.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
export type AniListMatch = {
  state: 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';
  candidates: string[];
  fingerprint: string;
};
export type AniListObservation = {
  subjectId: string;
  epoch: string;
  pin: unknown;
  proposedState: string | null;
  current: { state: string; revision: number; incarnationId: string | null } | null;
  states: { id: string; role?: string }[];
  profile?: LibraryProfileDescriptor | null;
  profileBinding?: ProgressProfileBinding | null;
};
export type AniListReviewInput = {
  subjectId?: string;
  skip?: boolean;
  fields: string[];
  replace?: boolean;
  progress?: ProgressAdoptionInput;
};
type Review = {
  id: string;
  match: AniListMatch;
  observation: AniListObservation | null;
  input: AniListReviewInput;
  commandKey: string;
  clientId: string;
  requestedBy: string | null;
  sourceFingerprint: string;
  progress?: ProgressAdoptionPlan;
};
export type AniListOutcome = {
  ordinal: number;
  status: 'applied' | 'skipped' | 'stale' | 'unsupported' | 'failed';
  retained: string[];
  progress?: {
    occurrence: ProgressAdoptionCheckpoint['occurrence'];
    complete: boolean;
    measures: ReturnType<typeof progressResults>;
  };
};
export type AniListStored = {
  source: AniListRow;
  review?: Review;
  metadataReviews?: EntryImportMetadataReview[];
  started?: boolean;
  progress?: ProgressAdoptionCheckpoint;
  outcome?: AniListOutcome;
  labelReview?: AniListLabelReview;
  labelWork?: Record<number, AniListLabelWork>;
};
type Stored = AniListStored;
type Header = { document: unknown; rawUpload: string; scoreFormat: string | null; count: number; cancelled: boolean };
const hash = (v: unknown) => createHash('sha256').update(canonicalize(v)!).digest('hex');
const role: Record<string, string> = {
  CURRENT: 'active',
  PLANNING: 'planned',
  COMPLETED: 'completed',
  DROPPED: 'dropped',
  PAUSED: 'paused',
};
function aniListProgressSources(row: AniListRow): ProgressSourceValue[] {
  const evidence = row.evidence;
  const media = evidence.media;
  const kind =
    media !== null && typeof media === 'object' && !Array.isArray(media)
      ? (media as Record<string, unknown>).type
      : null;
  const fields: [string, string | null][] =
    kind === 'ANIME'
      ? [
          ['progress', 'episode'],
          ...(Object.hasOwn(evidence, 'progressVolumes') ? [['progressVolumes', null] as [string, null]] : []),
        ]
      : kind === 'MANGA'
        ? [
            ['progress', 'chapter'],
            ['progressVolumes', 'volume'],
          ]
        : [
            ...(Object.hasOwn(evidence, 'progress') ? [['progress', null] as [string, null]] : []),
            ...(Object.hasOwn(evidence, 'progressVolumes') ? [['progressVolumes', null] as [string, null]] : []),
          ];
  return fields.map(([field, unit]) => {
    const present = Object.hasOwn(evidence, field);
    const validity = row.fields.find((item) => item.field === field)?.validity;
    const value = evidence[field];
    const state: ProgressSourceValue['state'] = !present
      ? 'missing'
      : validity === 'invalid'
        ? 'invalid'
        : validity === 'unknown'
          ? 'unknown'
          : typeof value === 'number' && Number.isSafeInteger(value) && value === 0
            ? 'zero'
            : validity === 'valid' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
              ? 'value'
              : 'invalid';
    return {
      field,
      unit,
      state,
      ...(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? { amount: String(value) } : {}),
    };
  });
}

function publicProgress(plan: ProgressAdoptionPlan, checkpoint: ProgressAdoptionCheckpoint | null | undefined) {
  return {
    occurrence: checkpoint?.occurrence ?? null,
    complete: checkpoint?.complete ?? false,
    measures: progressResults(plan, checkpoint),
  };
}

export function anilistMetadataProposals(row: AniListRow): EntryImportMetadataProposals {
  const evidence = row.evidence;
  const note: EntryImportMetadataProposal = !Object.hasOwn(evidence, 'notes')
    ? { state: 'absent', sourceField: null }
    : typeof evidence.notes !== 'string'
      ? {
          state: evidence.notes === null ? 'unknown' : 'invalid',
          sourceField: 'notes',
          sourceValue:
            typeof evidence.notes === 'number' || typeof evidence.notes === 'boolean' ? evidence.notes : null,
        }
      : evidence.notes === ''
        ? { state: 'empty', sourceField: 'notes', sourceValue: '' }
        : !evidence.notes.isWellFormed() || evidence.notes.includes('\0')
          ? { state: 'invalid', sourceField: 'notes', reason: 'The retained note is not valid text.' }
          : Buffer.byteLength(evidence.notes) > ENTRY_IMPORT_METADATA_LIMITS.noteBytes
            ? {
                state: 'unsupported',
                sourceField: 'notes',
                reason: 'The retained note exceeds the native 4,096-byte limit.',
              }
            : { state: 'value', sourceField: 'notes', value: evidence.notes };
  const priorityValue = evidence.priority;
  const priority: EntryImportMetadataProposal = !Object.hasOwn(evidence, 'priority')
    ? { state: 'absent', sourceField: null }
    : {
        state: 'unsupported',
        sourceField: 'priority',
        ...(typeof priorityValue === 'number' || typeof priorityValue === 'string'
          ? { sourceValue: priorityValue }
          : {}),
        reason: 'AniList priority has no installed, confirmed conversion to owner-local 1–100 positions.',
      };
  const privacy: EntryImportMetadataProposal = !Object.hasOwn(evidence, 'private')
    ? { state: 'absent', sourceField: null, value: { status: 'absent' } }
    : typeof evidence.private === 'boolean'
      ? {
          state: 'value',
          sourceField: 'private',
          sourceValue: evidence.private,
          value: { status: 'known', meaning: evidence.private ? 'private' : 'source_visible' },
        }
      : evidence.private === null
        ? { state: 'unknown', sourceField: 'private', sourceValue: null, value: { status: 'unknown' } }
        : { state: 'invalid', sourceField: 'private', reason: 'AniList private must be a retained boolean.' };
  const timestamp = (field: 'createdAt' | 'updatedAt'): EntryImportMetadataProposal => {
    if (!Object.hasOwn(evidence, field)) return { state: 'absent', sourceField: null, value: { status: 'absent' } };
    const value = evidence[field];
    if (value === null)
      return { state: 'unknown', sourceField: field, sourceValue: null, value: { status: 'unknown' } };
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      return {
        state: 'unknown',
        sourceField: field,
        sourceValue: value,
        value: { status: 'unknown', sourceValue: String(value) },
      };
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= ENTRY_IMPORT_METADATA_LIMITS.timestampBytes &&
      !/[\u0000-\u001f\u007f]/.test(value)
    )
      return {
        state: 'unknown',
        sourceField: field,
        sourceValue: value,
        value: { status: 'unknown', sourceValue: value },
      };
    return {
      state: 'unsupported',
      sourceField: field,
      reason: 'Only retained integer AniList timestamps fit the current native unknown-time contract.',
    };
  };
  return { note, priority, privacy, sourceCreated: timestamp('createdAt'), sourceUpdated: timestamp('updatedAt') };
}
function owner(actor: Actor): AccountActor {
  if (
    actor.kind !== 'account' ||
    !actor.scopes.includes('library_entry:update') ||
    !actor.scopes.includes('library_entry:read')
  )
    throw new GrantDeniedError();
  return actor;
}

/** This source composes existing account, identifier, profile and entry commands; it has no scheduler. */
export function createAniListImport(deps: Dependencies) {
  const { pool, access, clock } = deps;
  const runner = createLibraryCommandRunner(deps);
  const entries = createEntryCommands(deps);
  const personalEntries = createEntryPersonalCommands(deps);
  const sessions = createSessionCommands(deps);
  // Keep source payloads out of command receipts, events and exception text.
  async function snapshot<T>(actor: Actor, body: (client: PoolClient, account: AccountActor) => Promise<T>) {
    const account = owner(actor),
      route = requireRoute(account.accountId);
    const check = await accessCheck(
      access,
      account,
      'library_entry:read',
      { route, id: account.accountId },
      { pool, deadline: deadlineFor(5000) },
    );
    return withConnection(pool, async (client) => {
      await client.query('BEGIN');
      try {
        await partitionReadClient(client, partitionOf(route));
        await accountShare.run(client, { route, account_id: account.accountId });
        const current = await readAccount(client, route, account.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(account.authnEpoch) ||
          account.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(account.authnEpoch) ||
          !(await check(client, await mintReadTime(client, clock)))
        )
          throw new GrantDeniedError();
        const result = await body(client, account);
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    });
  }
  async function load<T = Stored>(actor: Actor, id: string, ordinal: number): Promise<T> {
    requireRoute(id);
    return snapshot(actor, async (client, account) => {
      const row = (
        await client.query<{ payload: T }>(
          'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4',
          [requireRoute(account.accountId), account.accountId, id, ordinal],
        )
      ).rows[0];
      if (!row) throw new LibraryNotFoundError();
      return row.payload;
    });
  }
  async function match(actor: Actor, row: AniListRow): Promise<AniListMatch> {
    const candidates: string[] = [],
      claims: unknown[] = [];
    let unavailable = false;
    for (const identifier of row.identifiers) {
      const route = tupleRoute(deps.routeKey, identifier.source, identifier.externalId);
      const claim = await withConnection(pool, async (client) => {
        await partitionReadClient(client, partitionOf(route));
        return readClaim.run(client, { route, source: identifier.source, external_id: identifier.externalId });
      });
      if (!claim) {
        claims.push([identifier, null]);
        continue;
      }
      const observed = await observe(actor, claim.subject_id);
      if (!observed) {
        unavailable = true;
        claims.push([identifier, 'unavailable']);
        continue;
      }
      candidates.push(observed.subjectId);
      claims.push([identifier, observed.subjectId, observed.epoch]);
    }
    const unique = [...new Set(candidates)].sort();
    const conflictingIds = row.identifiers.filter((i) => i.source === 'anilist').length > 1;
    return {
      state: unavailable
        ? 'unavailable'
        : unique.length > 1 || conflictingIds
          ? 'ambiguous'
          : unique.length
            ? 'matched'
            : 'unmatched',
      candidates: unique,
      fingerprint: hash(claims),
    };
  }
  async function observe(actor: Actor, subjectId: string): Promise<AniListObservation | null> {
    const at = await withConnection(pool, (client) => mintReadTime(client, clock));
    const observed = await readLibraryProfileSourceObservation(
      { pool, access, actor, at, deadline: deadlineFor(5000) },
      subjectId,
    );
    if (!observed) return null;
    const { source, anchor } = observed;
    const current = await snapshot(actor, (client, account) =>
      readEntry(client, requireRoute(account.accountId), account.accountId, source.subjectId),
    );
    return {
      subjectId: source.subjectId,
      epoch: String(anchor.identityEpoch),
      pin: source.kind === 'supported' ? source.pin : null,
      current: current
        ? { state: current.state, revision: current.revision, incarnationId: current.incarnationId ?? null }
        : null,
      states:
        source.kind === 'supported'
          ? (source.profile.entryStateSet?.states ?? []).map((s) => ({ id: s.id, ...(s.role ? { role: s.role } : {}) }))
          : [],
      profile: source.kind === 'supported' ? source.profile : null,
      profileBinding:
        source.kind === 'supported'
          ? { pin: source.pin, epoch: String(anchor.identityEpoch), acceptingType: anchor.acceptingType }
          : null,
      proposedState: null,
    };
  }
  function propose(observation: AniListObservation | null, row: AniListRow) {
    if (observation) {
      const desired = role[String(row.evidence.status)];
      const choices = observation.states.filter((s) => desired !== undefined && s.role === desired);
      observation.proposedState = choices.length === 1 ? choices[0]!.id : null;
    }
    return observation;
  }
  async function save(
    actor: Actor,
    id: string,
    ordinal: number,
    kind: string,
    key: string,
    input: unknown,
    change: (stored: Stored) => Stored,
  ) {
    const account = owner(actor),
      route = requireRoute(account.accountId);
    return runner.ownAccount(
      actor,
      {
        action: 'library_entry:update',
        kind: `library.anilist.${kind}`,
        requestKey: key,
        input: { id, ordinal, input },
      },
      async (tx) => {
        if (kind === 'start' || kind === 'metadata-confirm' || kind === 'metadata-progress') {
          const header = (
            await tx.query<{ payload: Header }>(
              'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR SHARE',
              [route, account.accountId, id],
            )
          ).rows[0];
          if (!header) return noEffect({ reviewId: null });
          if (header.payload.cancelled && kind !== 'metadata-progress') return noEffect({ reviewId: null });
        }
        const row = (
          await tx.query<{ payload: Stored }>(
            'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4 FOR UPDATE',
            [route, account.accountId, id, ordinal],
          )
        ).rows[0];
        if (!row) throw new LibraryNotFoundError();
        const next = change(row.payload);
        if (kind === 'metadata-progress') {
          const started = (next.metadataReviews ?? []).some((item, index) => {
            const prior = row.payload.metadataReviews?.[index]?.confirmation;
            return (
              !!item.confirmation &&
              ((item.confirmation.annotationStarted && !prior?.annotationStarted) ||
                (item.confirmation.provenanceStarted && !prior?.provenanceStarted))
            );
          });
          if (started) {
            const header = (
              await tx.query<{ payload: Header }>(
                'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR SHARE',
                [route, account.accountId, id],
              )
            ).rows[0];
            if (!header || header.payload.cancelled) throw new LibraryConflictError();
          }
        }
        await tx.query(
          'UPDATE library.list_import_anilist SET payload=$5 WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4',
          [route, account.accountId, id, ordinal, JSON.stringify(next)],
        );
        return {
          value: { reviewId: next.review?.id ?? null },
          events: [
            { type: 'com.rezics.library.anilist.changed.v1', subject: account.accountId, data: { importId: id } },
          ],
        };
      },
    );
  }
  async function preview(actor: Actor, upload: string, scoreFormat: string | undefined, key: string) {
    const account = owner(actor),
      parsed = parseAniList(upload, scoreFormat);
    const result = await runner.ownAccount(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.anilist.preview',
        requestKey: key,
        input: { digest: hash([upload, scoreFormat ?? null]) },
      },
      async (tx) => {
        const route = requireRoute(account.accountId),
          id = newId(route);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `library.anilist:${account.accountId}`,
        ]);
        const count = (
          await tx.query(
            'SELECT count(*)::int AS n FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND ordinal=-1',
            [route, account.accountId],
          )
        ).rows[0].n;
        if (count >= ANILIST_LIMITS.uploads) throw new LibraryConflictError();
        const payloads = [
          {
            document: parsed.document,
            rawUpload: upload,
            scoreFormat: parsed.scoreFormat,
            count: parsed.rows.length,
            cancelled: false,
          },
          ...parsed.rows.map((source) => ({ source })),
        ];
        await tx.query(
          'INSERT INTO library.list_import_anilist(route,account_id,import_id,ordinal,payload) SELECT $1,$2,$3,ordinality-2,payload FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS rows(payload,ordinality)',
          [route, account.accountId, id, JSON.stringify(payloads)],
        );
        return {
          value: { id, count: parsed.rows.length },
          events: [
            { type: 'com.rezics.library.anilist.changed.v1', subject: account.accountId, data: { importId: id } },
          ],
        };
      },
    );
    return result.value;
  }
  async function page(actor: Actor, id: string, after: number) {
    const header = await load<Header>(actor, id, -1);
    const raw = await snapshot(
      actor,
      async (client, account) =>
        (
          await client.query<{ ordinal: number; payload: Stored }>(
            'SELECT ordinal,payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 20',
            [requireRoute(account.accountId), account.accountId, id, after],
          )
        ).rows,
    );
    const rows = [];
    for (const row of raw) {
      const matching = await match(actor, row.payload.source);
      const inspected =
        matching.state === 'matched'
          ? await observe(actor, matching.candidates[0]!)
          : null;
      const { profile, profileBinding: _profileBinding, ...publicObservation } = inspected ?? {};
      const observation = inspected ? propose(publicObservation as AniListObservation, row.payload.source) : null;
      rows.push({
        ordinal: row.ordinal,
        ...row.payload,
        labelEvidence: aniListLabelEvidence(row.payload.source),
        match: matching,
        proposal: observation,
        progressMeasures: describeProgressSources(profile ?? null, aniListProgressSources(row.payload.source)),
        progress: row.payload.review?.progress
          ? publicProgress(row.payload.review.progress, row.payload.progress)
          : null,
      });
    }
    await snapshot(actor, async () => undefined);
    const result = { header, rows, next: raw.length === 20 ? raw[raw.length - 1]!.ordinal : null };
    if (Buffer.byteLength(JSON.stringify(result)) > ANILIST_LABEL_LIMITS.pageBytes) throw new AniListInputError();
    return result;
  }
  async function review(actor: Actor, id: string, ordinal: number, input: AniListReviewInput, key: string) {
    if (input.fields.some((field) => !field.isWellFormed() || field.includes('\0'))) throw new AniListInputError();
    if (input.skip && input.progress) throw new AniListInputError();
    const account = owner(actor),
      stored = await load(actor, id, ordinal);
    const matching = await match(actor, stored.source);
    const selected = input.subjectId ?? (matching.state === 'matched' ? matching.candidates[0] : undefined);
    if (!input.skip && !selected) throw new LibraryConflictError();
    const inspected = selected ? await observe(actor, selected) : null;
    const { profile, profileBinding, ...publicObservation } = inspected ?? {};
    const observation = selected
      ? propose(inspected ? (publicObservation as AniListObservation) : null, stored.source)
      : null;
    if (selected && (!observation || selected !== observation.subjectId)) throw new LibraryConflictError();
    if (input.progress && (!selected || !profile || !profileBinding)) throw new LibraryConflictError();
    const progress = input.progress
      ? await reviewProgressAdoption(
          sessions,
          actor,
          selected!,
          profile!,
          profileBinding!,
          aniListProgressSources(stored.source),
          input.progress,
          `anilist-progress-start:${hash({ id, ordinal, commandKey: randomUUID() })}`,
        )
      : undefined;
    const value: Review = {
      id: randomUUID(),
      commandKey: randomUUID(),
      match: matching,
      observation,
      input,
      clientId: account.clientId,
      requestedBy: account.requestedBy ?? null,
      sourceFingerprint: hash(stored.source),
      ...(progress ? { progress } : {}),
    };
    const saved = await save(actor, id, ordinal, 'review', key, input, (current) => {
      if (current.started) throw new LibraryConflictError();
      if (current.metadataReviews?.some((item) => item.confirmation && !item.confirmation.outcome))
        throw new LibraryConflictError();
      return { ...current, review: value, progress: undefined, outcome: undefined };
    });
    // Receipt replay refers to the stored review, never freshly computed operands.
    const current = await load(actor, id, ordinal);
    if (current.review?.id !== saved.value.reviewId) throw new LibraryConflictError();
    return { ordinal, review: current.review };
  }
  async function currentMetadataProfileDigest(
    actor: Actor,
    stored: Stored,
    sourceReviewToken: string,
    subjectId: string,
  ) {
    const review = stored.review,
      reviewed = review?.observation;
    if (!review || !reviewed || review.id !== sourceReviewToken || reviewed.subjectId !== subjectId) return null;
    const matching = await match(actor, stored.source),
      current = await observe(actor, subjectId);
    if (
      !current ||
      matching.fingerprint !== review.match.fingerprint ||
      !matching.candidates.includes(subjectId) ||
      current.subjectId !== reviewed.subjectId ||
      current.epoch !== reviewed.epoch ||
      hash(current.pin) !== hash(reviewed.pin) ||
      hash(current.current) !== hash(reviewed.current)
    )
      return null;
    return entryImportMetadataDigest({
      match: matching.fingerprint,
      subjectId: current.subjectId,
      epoch: current.epoch,
      pin: current.pin,
      current: current.current,
    });
  }
  async function metadataCurrent(actor: Actor, stored: Stored, metadata: EntryImportMetadataReview) {
    return (
      (await currentMetadataProfileDigest(actor, stored, metadata.sourceReviewToken, metadata.subjectId)) ===
      metadata.profileDigest
    );
  }
  async function reviewMetadata(actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) {
    const account = owner(actor),
      stored = await load(actor, id, ordinal),
      review = stored.review;
    if (
      !review ||
      sourceReviewToken.length > 128 ||
      review.id !== sourceReviewToken ||
      review.input.skip ||
      !review.observation?.current?.incarnationId
    )
      throw new LibraryConflictError();
    if (stored.metadataReviews?.some((item) => item.confirmation && !item.confirmation.outcome))
      throw new LibraryConflictError();
    const profileDigest = await currentMetadataProfileDigest(
      actor,
      stored,
      sourceReviewToken,
      review.observation.subjectId,
    );
    if (!profileDigest) throw new LibraryConflictError();
    const personal = await personalEntries.readPersonalEntry(actor, review.observation.subjectId),
      next: EntryImportMetadataReview = {
        token: randomUUID(),
        requestDigest: entryImportMetadataDigest({ sourceReviewToken, key }),
        sourceReviewToken,
        subjectId: review.observation.subjectId,
        clientId: account.clientId,
        requestedBy: account.requestedBy ?? null,
        annotationRevision: personal.annotationRevision,
        personalDigest: entryPersonalMetadataDigest(personal),
        sourceDigest: entryImportMetadataDigest(stored.source.evidence),
        profileDigest,
        incarnationId: review.observation.current.incarnationId,
      };
    const saved = await save(actor, id, ordinal, 'metadata-review', key, { sourceReviewToken }, (current) => {
      if (
        current.review?.id !== sourceReviewToken ||
        current.metadataReviews?.some((item) => item.confirmation && !item.confirmation.outcome)
      )
        throw new LibraryConflictError();
      const history = [...(current.metadataReviews ?? [])],
        existing = history.find((item) => item.requestDigest === next.requestDigest);
      if (existing) return current;
      if (history.length >= ENTRY_IMPORT_METADATA_LIMITS.reviewsPerRow) throw new LibraryConflictError();
      history.push(next);
      assertEntryImportMetadataHistorySize(history);
      return { ...current, metadataReviews: history };
    });
    const current = await load(actor, id, ordinal),
      record = current.metadataReviews?.find((item) => item.requestDigest === next.requestDigest);
    if (!record || saved.value.reviewId !== sourceReviewToken) throw new LibraryConflictError();
    return { ordinal, reviewToken: record.token };
  }
  async function metadataView(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
  ): Promise<EntryImportMetadataView> {
    const stored = await load(actor, id, ordinal),
      metadata = stored.metadataReviews?.find((item) => item.token === reviewToken);
    if (!metadata || !stored.review) throw new LibraryConflictError();
    const account = owner(actor),
      personal = await personalEntries.readPersonalEntry(actor, metadata.subjectId),
      current = await metadataCurrent(actor, stored, metadata),
      unchanged =
        account.clientId === metadata.clientId &&
        (account.requestedBy ?? null) === metadata.requestedBy &&
        entryImportMetadataDigest(stored.source.evidence) === metadata.sourceDigest &&
        entryPersonalMetadataDigest(personal) === metadata.personalDigest &&
        personal.annotationRevision === metadata.annotationRevision &&
        (stored.review.observation?.current?.incarnationId ?? null) === metadata.incarnationId,
      view: EntryImportMetadataView = {
        status: current && unchanged ? 'current' : 'stale',
        reviewToken,
        sourceReviewToken: metadata.sourceReviewToken,
        subjectId: metadata.subjectId,
        personal,
        proposals: anilistMetadataProposals(stored.source),
        outcome: metadata.confirmation?.outcome ?? null,
      };
    if (Buffer.byteLength(JSON.stringify(view)) > ENTRY_IMPORT_METADATA_LIMITS.responseBytes)
      throw new AniListInputError();
    return view;
  }
  async function applyMetadata(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
    fields: unknown,
    signal?: AbortSignal,
  ): Promise<EntryImportMetadataOutcome> {
    const selections = parseEntryImportMetadataSelections(fields),
      selectionDigest = entryImportMetadataDigest(selections);
    let stored = await load(actor, id, ordinal),
      metadata = stored.metadataReviews?.find((item) => item.token === reviewToken);
    if (!metadata) return { reviewToken, fields: selections.map(({ field }) => ({ field, status: 'stale' })) };
    if (metadata.confirmation && metadata.confirmation.selectionDigest !== selectionDigest)
      throw new LibraryConflictError();
    if (metadata.confirmation?.outcome) return metadata.confirmation.outcome;
    if (!metadata.confirmation) {
      const confirmation = {
        fields: selections,
        selectionDigest,
        annotationKey: `anilist:${id}:${ordinal}:${reviewToken}:annotations`,
        provenanceKey: `anilist:${id}:${ordinal}:${reviewToken}:provenance`,
        annotationStarted: false,
        provenanceStarted: false,
      };
      const saved = await save(
        actor,
        id,
        ordinal,
        'metadata-confirm',
        `${id}:${ordinal}:${reviewToken}:confirm`,
        { reviewToken, selectionDigest },
        (current) => {
          const record = current.metadataReviews?.find((item) => item.token === reviewToken);
          if (!record || current.review?.id !== record.sourceReviewToken) throw new LibraryConflictError();
          if (record.confirmation) {
            if (record.confirmation.selectionDigest !== selectionDigest) throw new LibraryConflictError();
            return current;
          }
          const next = {
            ...current,
            metadataReviews: current.metadataReviews!.map((item) =>
              item.token === reviewToken ? { ...item, confirmation } : item,
            ),
          };
          assertEntryImportMetadataHistorySize(next.metadataReviews ?? []);
          return next;
        },
      );
      if (saved.value.reviewId === null) throw new LibraryConflictError();
      stored = await load(actor, id, ordinal);
      metadata = stored.metadataReviews?.find((item) => item.token === reviewToken);
    }
    if (!metadata?.confirmation) throw new LibraryConflictError();
    if (metadata.confirmation.outcome) return metadata.confirmation.outcome;
    const view = await metadataView(actor, id, ordinal, reviewToken);
    if (
      view.status !== 'current' &&
      !metadata.confirmation.annotationStarted &&
      !metadata.confirmation.provenanceStarted
    ) {
      const outcome: EntryImportMetadataOutcome = {
        reviewToken,
        fields: selections.map(({ field }) => ({ field, status: 'stale' })),
      };
      metadata.confirmation.outcome = outcome;
      await persistMetadataConfirmation(actor, id, ordinal, reviewToken, metadata.confirmation);
      return outcome;
    }
    const row = stored.source;
    const stableRecord =
      typeof row.evidence.id === 'number' && Number.isSafeInteger(row.evidence.id) && row.evidence.id > 0
        ? String(row.evidence.id)
        : `${id}/${ordinal}`;
    return (
      await applyEntryImportMetadataCommands({
        actor,
        subjectId: metadata.subjectId,
        provider: 'anilist',
        recordId: stableRecord,
        reviewToken,
        personal: view.personal,
        proposals: view.proposals,
        selections,
        baselineAnnotationRevision: metadata.annotationRevision,
        confirmation: metadata.confirmation,
        native: personalEntries,
        persist: (value) => persistMetadataConfirmation(actor, id, ordinal, reviewToken, value),
        isCurrent: async () => {
          try {
            return await metadataCurrent(actor, await load(actor, id, ordinal), metadata!);
          } catch (error) {
            if (error instanceof LibraryNotFoundError) return false;
            throw error;
          }
        },
        isCancelled: async () => {
          try {
            return (await load<Header>(actor, id, -1)).cancelled;
          } catch (error) {
            if (error instanceof LibraryNotFoundError) return true;
            throw error;
          }
        },
        ...(signal ? { signal } : {}),
      })
    ).outcome;
  }
  async function persistMetadataConfirmation(
    actor: Actor,
    id: string,
    ordinal: number,
    token: string,
    confirmation: EntryImportMetadataReview['confirmation'],
  ) {
    if (!confirmation) return;
    const stateDigest = entryImportMetadataDigest(confirmation);
    await save(
      actor,
      id,
      ordinal,
      'metadata-progress',
      `${id}:${ordinal}:${token}:progress:${stateDigest}`,
      { reviewToken: token, stateDigest },
      (current) => {
        const record = current.metadataReviews?.find((item) => item.token === token);
        if (!record?.confirmation || record.confirmation.selectionDigest !== confirmation.selectionDigest)
          throw new LibraryConflictError();
        const next = {
          ...current,
          metadataReviews: current.metadataReviews!.map((item) =>
            item.token === token ? { ...item, confirmation } : item,
          ),
        };
        assertEntryImportMetadataHistorySize(next.metadataReviews ?? []);
        return next;
      },
    );
  }
  async function apply(
    actor: Actor,
    id: string,
    confirmations: { ordinal: number; reviewId: string }[],
    signal?: AbortSignal,
  ) {
    const account = owner(actor),
      outcomes: AniListOutcome[] = [],
      deadline = deadlineFor(20_000);
    for (const confirmation of confirmations) {
      if (signal?.aborted || Date.now() >= deadline) break;
      const header = await load<Header>(actor, id, -1);
      if (header.cancelled) break;
      const stored = await load(actor, id, confirmation.ordinal),
        reviewed = stored.review;
      if (
        !reviewed ||
        reviewed.id !== confirmation.reviewId ||
        reviewed.clientId !== account.clientId ||
        reviewed.requestedBy !== (account.requestedBy ?? null)
      ) {
        outcomes.push({
          ordinal: confirmation.ordinal,
          status: 'stale',
          retained: stored.source.fields.map((f) => f.field),
        });
        continue;
      }
      if (stored.outcome && (!reviewed.progress || stored.progress?.complete)) {
        outcomes.push(stored.outcome);
        continue;
      }
      const retained = stored.source.fields
        .map((f) => f.field)
        .filter((f) => f !== 'status' || !reviewed.input.fields.includes('status'));
      let status: AniListOutcome['status'] = 'unsupported';
      if (hash(stored.source) !== reviewed.sourceFingerprint) status = 'stale';
      else if (reviewed.input.skip) status = 'skipped';
      else if (reviewed.input.fields.includes('status') && reviewed.observation?.proposedState) {
        const observed = reviewed.observation;
        const current = await observe(actor, observed.subjectId),
          matching = await match(actor, stored.source);
        if (
          !current ||
          current.subjectId !== observed.subjectId ||
          current.epoch !== observed.epoch ||
          hash(current.pin) !== hash(observed.pin) ||
          matching.fingerprint !== reviewed.match.fingerprint
        )
          status = 'stale';
        else if (observed.current && !reviewed.input.replace) status = 'skipped';
        else {
          if (signal?.aborted || Date.now() >= deadline) break;
          const admitted = await save(
            actor,
            id,
            confirmation.ordinal,
            'start',
            reviewed.commandKey,
            { reviewId: reviewed.id },
            (row) => {
              if (row.review?.id !== reviewed.id) throw new LibraryConflictError();
              return { ...row, started: true };
            },
          );
          if (admitted.value.reviewId === null) break;
          try {
            // Native receipt identity and every operand survive crashes, lost replies and repeat pages.
            await entries.putEntry(
              actor,
              observed.subjectId,
              {
                state: observed.proposedState,
                ...(observed.current
                  ? {
                      revision: observed.current.revision,
                      ...(observed.current.incarnationId ? { incarnationId: observed.current.incarnationId } : {}),
                    }
                  : {}),
              },
              reviewed.commandKey,
              { subjectId: observed.subjectId, pin: observed.pin, epoch: observed.epoch },
            );
            status = 'applied';
          } catch (e) {
            if (e instanceof GrantDeniedError) throw e;
            status = e instanceof LibraryConflictError ? 'stale' : 'failed';
          }
        }
      }
      if (status !== 'applied' && !retained.includes('status') && Object.hasOwn(stored.source.evidence, 'status'))
        retained.push('status');
      const outcome: AniListOutcome = { ordinal: confirmation.ordinal, status, retained };
      let progressCheckpoint: ProgressAdoptionCheckpoint | undefined;
      if (reviewed.progress && hash(stored.source) === reviewed.sourceFingerprint) {
        progressCheckpoint = await executeProgressAdoption(actor, sessions, reviewed.progress, stored.progress, {
          async canceled() {
            return (await load<Header>(actor, id, -1)).cancelled;
          },
          async binding() {
            const matching = await match(actor, stored.source);
            const current = await observe(actor, reviewed.progress!.subjectId);
            if (
              matching.fingerprint !== reviewed.match.fingerprint ||
              !current ||
              current.subjectId !== reviewed.progress!.subjectId ||
              current.epoch !== reviewed.progress!.profile.epoch ||
              hash(current.pin) !== hash(reviewed.progress!.profile.pin)
            )
              return null;
            return current.profileBinding ?? null;
          },
          async save(checkpoint, admission = false) {
            const digest = hash(checkpoint);
            const saved = await save(
              actor,
              id,
              confirmation.ordinal,
              admission ? 'start' : 'finish',
              `anilist-progress:${hash({ reviewId: reviewed.id, admission, digest })}`,
              { reviewId: reviewed.id, admission, digest },
              (row) => {
                if (row.review?.id !== reviewed.id) throw new LibraryConflictError();
                return { ...row, progress: checkpoint, ...(admission ? { started: true } : {}) };
              },
            );
            if (saved.value.reviewId !== reviewed.id) return false;
            stored.progress = checkpoint;
            return true;
          },
        });
        stored.progress = progressCheckpoint;
        outcome.progress = publicProgress(reviewed.progress, progressCheckpoint);
        const measureStatuses = outcome.progress.measures.map((measure) => measure.status);
        if (measureStatuses.includes('stale')) status = 'stale';
        else if (status === 'unsupported' && measureStatuses.some((value) => value === 'applied' || value === 'cleared'))
          status = 'applied';
        else if (measureStatuses.includes('failed')) status = 'failed';
        outcome.status = status;
      }
      // Failed attempts remain retryable with the original command; stale reviews can be refreshed before starting.
      if (status !== 'failed' && (!reviewed.progress || progressCheckpoint?.complete))
        await save(actor, id, confirmation.ordinal, 'finish', reviewed.commandKey, outcome, (row) => {
          if (row.review?.id !== reviewed.id) throw new LibraryConflictError();
          return status === 'stale' && !row.started
            ? { ...row, review: undefined, started: undefined, outcome: undefined }
            : { ...row, outcome };
        });
      outcomes.push(outcome);
    }
    return { outcomes, complete: outcomes.length === confirmations.length };
  }
  async function cancel(actor: Actor, id: string, key: string, remove = false) {
    const account = owner(actor),
      route = requireRoute(account.accountId);
    await runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: 'library.anilist.cancel', requestKey: key, input: { id, remove } },
      async (tx) => {
        const exists = await tx.query(
          'SELECT 1 FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR UPDATE',
          [route, account.accountId, id],
        );
        if (!exists.rowCount) throw new LibraryNotFoundError();
        if (remove)
          await tx.query('DELETE FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3', [
            route,
            account.accountId,
            id,
          ]);
        else
          await tx.query(
            "UPDATE library.list_import_anilist SET payload=jsonb_set(payload,'{cancelled}','true') WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1",
            [route, account.accountId, id],
          );
        return {
          value: { cancelled: true },
          events: [
            { type: 'com.rezics.library.anilist.changed.v1', subject: account.accountId, data: { importId: id } },
          ],
        };
      },
    );
    return { cancelled: true };
  }
  const labelAdoption = createAniListLabelAdoption({ ...deps, load, snapshot, match, observe });
  return {
    preview,
    page,
    review,
    reviewMetadata,
    metadata: metadataView,
    applyMetadata,
    apply,
    cancel,
    ...labelAdoption,
  };
}
