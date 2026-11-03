import { randomUUID } from 'node:crypto';
import { createBangumiLabelReview } from './list-import-bangumi-labels.ts';
import type { BangumiLabelState } from './list-import-bangumi-label-model.ts';
import canonicalize from 'canonicalize';
import type { Pool } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import { mintReadTime, type CommandTransaction } from '../command/command.ts';
import type { KernelClock } from '../clock.ts';
import { tupleRoute } from '../content/imported-contract.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type Actor, type AccountActor } from '../request/access.ts';
import { deadlineFor } from '../request/deadline.ts';
import { newId, routeOf } from '../route/route.ts';
import readClaim from '../semantic/bulk-read-claim.sql';
import { withReadTransaction } from '../semantic/read.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { createLibraryCommandRunner, LibraryNotFoundError, requireRoute } from './command-support.ts';
import { createEntryCommands, LibraryConflictError } from './entries.ts';
import { createEntryPersonalCommands } from './entry-personal.ts';
import { parseSourceTimestamp } from './entry-personal-model.ts';
import {
  applyEntryImportMetadataCommands,
  ENTRY_IMPORT_METADATA_LIMITS,
  assertEntryImportMetadataHistorySize,
  entryImportMetadataDigest,
  entryPersonalMetadataDigest,
  metadataObservation,
  parseEntryImportMetadataSelections,
  type EntryImportMetadataOutcome,
  type EntryImportMetadataProposal,
  type EntryImportMetadataProposals,
  type EntryImportMetadataReview,
  type EntryImportMetadataSelection,
  type EntryImportMetadataView,
} from './list-import-entry-metadata.ts';
import { readLibraryProfileSourceObservation } from './profile-source.ts';
import {
  parseBangumiUpload,
  type BangumiChoice,
  type BangumiOutcome,
  type BangumiReview,
  type BangumiRow,
} from './list-import-bangumi-model.ts';

type Dependencies = { pool: Pool; access: Access; tokens: KeyRing; routeKey: Uint8Array; clock?: KernelClock };
type StoredRow = BangumiRow & { choice: BangumiChoice | null; labels: BangumiLabelState | null };
export function bangumiMetadataProposals(evidence: BangumiRow['evidence']): EntryImportMetadataProposals {
  const source = evidence.source;
  const noteField = ['comment', 'notes'].find((field) => Object.hasOwn(source, field)) ?? null;
  const noteRaw = noteField === null ? undefined : source[noteField];
  const note: EntryImportMetadataProposal =
    noteField === null
      ? { state: 'absent', sourceField: null, reason: 'This row has no retained note field.' }
      : typeof noteRaw !== 'string'
        ? { state: 'invalid', sourceField: noteField, sourceValue: null, reason: 'The retained note is not text.' }
        : noteRaw.length === 0
          ? {
              state: 'empty',
              sourceField: noteField,
              sourceValue: '',
              reason: 'An empty source comment is not a native clear.',
            }
          : !noteRaw.isWellFormed() ||
              noteRaw.includes('\u0000') ||
              Buffer.byteLength(noteRaw) > ENTRY_IMPORT_METADATA_LIMITS.noteBytes
            ? {
                state: 'unsupported',
                sourceField: noteField,
                reason: 'The retained note is outside the native 4,096-byte text limit.',
              }
            : { state: 'value', sourceField: noteField, value: noteRaw };
  const privacyField = Object.hasOwn(source, 'private') ? 'private' : null;
  const privacyRaw = privacyField === null ? undefined : source.private;
  const privacy: EntryImportMetadataProposal =
    privacyField === null
      ? { state: 'absent', sourceField: null, value: { status: 'absent' } }
      : typeof privacyRaw === 'boolean'
        ? {
            state: 'value',
            sourceField: privacyField,
            value: { status: 'known', meaning: privacyRaw ? 'private' : 'source_visible' },
            sourceValue: privacyRaw,
          }
        : typeof privacyRaw === 'string' &&
            privacyRaw.length > 0 &&
            Buffer.byteLength(privacyRaw) <= ENTRY_IMPORT_METADATA_LIMITS.privacyValueBytes &&
            !/[\u0000-\u001f\u007f]/.test(privacyRaw)
          ? {
              state: 'unknown',
              sourceField: privacyField,
              sourceValue: privacyRaw,
              value: { status: 'unknown', sourceValue: privacyRaw },
            }
          : privacyRaw === null
            ? { state: 'unknown', sourceField: privacyField, value: { status: 'unknown' } }
            : typeof privacyRaw === 'number' && Number.isFinite(privacyRaw)
              ? {
                  state: 'unknown',
                  sourceField: privacyField,
                  sourceValue: privacyRaw,
                  value: { status: 'unknown', sourceValue: String(privacyRaw) },
                }
              : {
                  state: 'unsupported',
                  sourceField: privacyField,
                  reason: 'The retained private value cannot fit the native provenance evidence bound.',
                };
  const timestamp = (field: 'created_at' | 'updated_at'): EntryImportMetadataProposal => {
    if (!Object.hasOwn(source, field)) return { state: 'absent', sourceField: null, value: { status: 'absent' } };
    const raw = source[field];
    if (typeof raw !== 'string')
      return { state: 'invalid', sourceField: field, sourceValue: null, reason: 'The retained timestamp is not text.' };
    if (raw.length === 0)
      return {
        state: 'empty',
        sourceField: field,
        sourceValue: '',
        reason: 'An empty timestamp is not an absent timestamp.',
      };
    try {
      parseSourceTimestamp(raw);
      return { state: 'value', sourceField: field, value: { status: 'known', value: raw }, sourceValue: raw };
    } catch {
      if (
        Buffer.byteLength(raw) <= ENTRY_IMPORT_METADATA_LIMITS.timestampBytes &&
        !/[\u0000-\u001f\u007f]/.test(raw) &&
        !/^\d{4}(?:-\d{2})?(?:-\d{2})?(?:T|$)/.test(raw)
      )
        return {
          state: 'unknown',
          sourceField: field,
          sourceValue: raw,
          value: { status: 'unknown', sourceValue: raw },
        };
      return {
        state: 'invalid',
        sourceField: field,
        sourceValue: raw.slice(0, 64),
        reason: 'The retained timestamp is not representable with its original precision.',
      };
    }
  };
  return {
    note,
    priority: {
      state: 'unsupported',
      sourceField: null,
      reason: 'Bangumi has no retained personal-list priority field.',
    },
    privacy,
    sourceCreated: timestamp('created_at'),
    sourceUpdated: timestamp('updated_at'),
  };
}
export function createBangumiImport(deps: Dependencies) {
  const { pool, access } = deps;
  const runner = createLibraryCommandRunner(deps);
  const entries = createEntryCommands(deps);
  const personalEntries = createEntryPersonalCommands(deps);
  const owner = (actor: Actor): AccountActor => {
    if (actor.kind !== 'account') throw new GrantDeniedError();
    requireRoute(actor.accountId);
    return actor;
  };
  async function read<T>(actor: Actor, body: (tx: CommandTransaction, a: AccountActor, route: number) => Promise<T>) {
    const a = owner(actor),
      route = requireRoute(a.accountId),
      deadline = deadlineFor(5000);
    const check = await accessCheck(access, a, 'library_entry:list', { route, id: a.accountId }, { pool, deadline });
    return withReadTransaction(
      pool,
      async (tx) => {
        const at = await mintReadTime(tx, deps.clock);
        const current = await readAccount(tx, route, a.accountId);
        if (
          !current ||
          current.kind !== 'actor' ||
          current.state !== 'active' ||
          current.fenced ||
          !Number.isSafeInteger(a.authnEpoch) ||
          a.authnEpoch < 1 ||
          current.minimumAuthnEpoch > BigInt(a.authnEpoch) ||
          !a.scopes.includes('library_entry:list') ||
          !(await check(tx, at))
        )
          throw new GrantDeniedError();
        return body(tx, a, route);
      },
      deadline,
    );
  }
  const args = (a: AccountActor, id: string) => [requireRoute(a.accountId), a.accountId, id];
  async function header(tx: CommandTransaction, a: AccountActor, id: string, lock = false) {
    if (routeOf(id) !== routeOf(a.accountId)) throw new LibraryNotFoundError();
    const h = (
      await tx.query<{ cancelled: boolean }>(
        `SELECT cancelled FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3${lock ? ' FOR UPDATE' : ''}`,
        args(a, id),
      )
    ).rows[0];
    if (!h) throw new LibraryNotFoundError();
    return h;
  }
  async function row(
    tx: CommandTransaction,
    a: AccountActor,
    id: string,
    ordinal: number,
    lock = false,
  ): Promise<StoredRow> {
    const r = (
      await tx.query<StoredRow>(
        `SELECT ordinal,evidence,review,choice,outcome,labels FROM library.bangumi_upload_row
      WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4${lock ? ' FOR UPDATE' : ''}`,
        [...args(a, id), ordinal],
      )
    ).rows[0];
    if (!r) throw new LibraryNotFoundError();
    return r;
  }
  function change<T>(
    actor: Actor,
    kind: string,
    key: string,
    input: unknown,
    body: (tx: CommandTransaction, a: AccountActor) => Promise<T>,
  ) {
    return runner.ownAccount(
      actor,
      { action: 'library_entry:update', kind: `library.bangumi.${kind}`, requestKey: key, input },
      async (tx) => ({
        value: await body(tx, owner(actor)),
        events: [
          {
            type: 'com.rezics.library.bangumi.changed.v1',
            subject: owner(actor).accountId,
            data: { operation: kind },
          },
        ],
      }),
    );
  }
  async function preview(actor: Actor, upload: string, key: string) {
    const evidence = parseBangumiUpload(upload);
    const made = await change(actor, 'preview', key, { upload }, async (tx, a) => {
      const id = newId(requireRoute(a.accountId));
      await tx.query('INSERT INTO library.bangumi_upload(route,account_id,upload_id) VALUES($1,$2,$3)', args(a, id));
      try {
        for (let i = 0; i < evidence.length; i++)
          await tx.query(
            `INSERT INTO library.bangumi_upload_row
          (route,account_id,upload_id,ordinal,evidence) VALUES($1,$2,$3,$4,$5::jsonb)`,
            [...args(a, id), i, JSON.stringify(evidence[i])],
          );
      } catch (error) {
        // PostgreSQL expands numeric notation and JSONB whitespace; reject without exposing row details.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          ['23514', '22P02', '22003'].includes(String(error.code))
        )
          throw new ProblemError('invalid_request');
        throw error;
      }
      return { uploadId: id, count: evidence.length };
    });
    return made.value;
  }
  async function page(actor: Actor, id: string, after: number) {
    return read(actor, async (tx, a) => {
      const h = await header(tx, a, id);
      const rows = (
        await tx.query<BangumiRow>(
          `SELECT ordinal,evidence,review,outcome FROM library.bangumi_upload_row
        WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal>$4 ORDER BY ordinal LIMIT 11`,
          [...args(a, id), after],
        )
      ).rows;
      return {
        uploadId: id,
        cancelled: h.cancelled,
        rows: rows.slice(0, 10),
        next: rows.length > 10 ? rows[9]!.ordinal : null,
      };
    });
  }
  async function observation(actor: Actor, target: string) {
    const at = await mintReadTime(pool, deps.clock);
    return readLibraryProfileSourceObservation({ ...deps, actor, at, deadline: deadlineFor(5000) }, target);
  }
  async function profileMetadata(actor: Actor, target: string) {
    const current = await observation(actor, target);
    if (!current || current.source.subjectId !== target) return null;
    let incarnationId: string | null = null;
    try {
      incarnationId = (await entries.readEntry(actor, target)).incarnationId ?? null;
    } catch (error) {
      if (!(error instanceof LibraryNotFoundError)) throw error;
    }
    const source = current.source;
    return {
      incarnationId,
      digest: entryImportMetadataDigest({
        subjectId: target,
        identityEpoch: String(current.anchor.identityEpoch),
        sourceKind: source.kind,
        releaseDigest: source.kind === 'supported' ? source.pin.releaseDigest : null,
        acceptingType: current.anchor.acceptingType,
        incarnationId,
      }),
      current,
    };
  }
  async function review(actor: Actor, id: string, ordinal: number, target: string | undefined, key: string) {
    const original = await read(actor, async (tx, a) => {
      if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
      return row(tx, a, id, ordinal);
    });
    if (original.choice || original.review?.metadata?.some((item) => item.confirmation && !item.confirmation.outcome))
      throw new ProblemError('conflict');
    const e = original.evidence;
    const candidates: string[] = [];
    let unavailable = false;
    if (
      typeof e.source.subject_id === 'number' &&
      Number.isSafeInteger(e.source.subject_id) &&
      e.source.subject_id > 0
    ) {
      try {
        const claim = await readClaim.run(pool, {
          route: tupleRoute(deps.routeKey, 'bangumi', String(e.source.subject_id)),
          source: 'bangumi',
          external_id: String(e.source.subject_id),
        });
        if (claim) {
          const observed = await observation(actor, claim.subject_id);
          if (observed) candidates.push(observed.source.subjectId);
          else unavailable = true;
        }
      } catch {
        unavailable = true;
      }
    }
    const selected = target ?? (candidates.length === 1 ? candidates[0] : undefined);
    const observed = selected ? await observation(actor, selected) : null;
    if (target && !observed) throw new LibraryNotFoundError();
    const source = observed?.source;
    const nativeStates =
      source?.kind === 'supported' && e.medium !== 'unknown'
        ? (source.profile.entryStateSet?.states.filter((s) => s.role === e.stateRole) ?? [])
        : [];
    const proposedState = nativeStates.length === 1 ? nativeStates[0]!.id : null;
    let current: BangumiReview['current'] = null;
    if (source) {
      try {
        const entry = await entries.readEntry(actor, source.subjectId);
        current = {
          state: entry.state,
          revision: entry.revision,
          ...(entry.incarnationId === undefined ? {} : { incarnationId: entry.incarnationId }),
        };
      } catch (error) {
        if (!(error instanceof LibraryNotFoundError)) throw error;
      }
    }
    const review: BangumiReview = {
      token: randomUUID(),
      candidates,
      target: source?.subjectId ?? null,
      match: target
        ? 'chosen'
        : candidates.length > 1
          ? 'ambiguous'
          : source
            ? current
              ? 'already_matched'
              : 'matched'
            : unavailable
              ? 'unavailable'
              : 'unmatched',
      guard:
        source?.kind === 'supported'
          ? {
              subjectId: source.subjectId,
              releaseDigest: source.pin.releaseDigest,
              identityEpoch: String(observed!.anchor.identityEpoch),
            }
          : null,
      proposedState,
      current,
      conflict: current !== null && proposedState !== null && current.state !== proposedState,
      metadata: original.review?.metadata ?? [],
    };
    const saved = await change(actor, 'review', key, { id, ordinal, target: target ?? null }, async (tx, a) => {
      if ((await header(tx, a, id, true)).cancelled || (await row(tx, a, id, ordinal)).choice)
        throw new ProblemError('conflict');
      await tx.query(
        `UPDATE library.bangumi_upload_row SET review=$5::jsonb,outcome=NULL,labels=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [...args(a, id), ordinal, JSON.stringify(review)],
      );
      return { ordinal, review };
    });
    return saved.value;
  }
  async function reviewMetadata(actor: Actor, id: string, ordinal: number, sourceReviewToken: string, key: string) {
    const original = await read(actor, async (tx, a) => {
      if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
      return row(tx, a, id, ordinal);
    });
    const review = original.review;
    if (!review || review.token !== sourceReviewToken || !review.target || !review.guard)
      throw new ProblemError('conflict');
    if (review.metadata?.some((item) => item.confirmation && !item.confirmation.outcome))
      throw new ProblemError('conflict');
    const account = owner(actor),
      profile = await profileMetadata(actor, review.target);
    if (
      !profile ||
      profile.current.source.kind !== 'supported' ||
      profile.incarnationId !== (review.current?.incarnationId ?? null)
    )
      throw new ProblemError('conflict');
    const currentSource = profile.current.source;
    if (
      currentSource.pin.releaseDigest !== review.guard.releaseDigest ||
      String(profile.current.anchor.identityEpoch) !== review.guard.identityEpoch
    )
      throw new ProblemError('conflict');
    const personal = await personalEntries.readPersonalEntry(actor, review.target);
    const requestDigest = entryImportMetadataDigest({ key });
    const next: EntryImportMetadataReview = {
      token: randomUUID(),
      requestDigest,
      sourceReviewToken,
      subjectId: review.target,
      clientId: account.clientId,
      requestedBy: account.requestedBy ?? null,
      annotationRevision: personal.annotationRevision,
      personalDigest: entryPersonalMetadataDigest(personal),
      sourceDigest: entryImportMetadataDigest(original.evidence),
      profileDigest: profile.digest,
      incarnationId: profile.incarnationId,
    };
    const saved = await change(actor, 'metadata-review', key, { id, ordinal, sourceReviewToken }, async (tx, a) => {
      if ((await header(tx, a, id, true)).cancelled) throw new ProblemError('conflict');
      const locked = await row(tx, a, id, ordinal, true);
      if (!locked.review || locked.review.token !== sourceReviewToken) throw new ProblemError('conflict');
      const history = [...(locked.review.metadata ?? [])];
      const existing = history.find((item) => item.requestDigest === requestDigest);
      if (existing) return { ordinal, reviewToken: existing.token };
      if (history.some((item) => item.confirmation && !item.confirmation.outcome)) throw new ProblemError('conflict');
      if (history.length >= ENTRY_IMPORT_METADATA_LIMITS.reviewsPerRow) throw new ProblemError('conflict');
      history.push(next);
      assertEntryImportMetadataHistorySize(history);
      locked.review.metadata = history;
      await tx.query(
        `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
        [...args(a, id), ordinal, JSON.stringify(locked.review)],
      );
      return { ordinal, reviewToken: next.token };
    });
    return saved.value;
  }
  async function metadataView(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
  ): Promise<EntryImportMetadataView> {
    const current = await read(actor, async (tx, a) => {
      const h = await header(tx, a, id);
      return { cancelled: h.cancelled, row: await row(tx, a, id, ordinal) };
    });
    const review = current.row.review,
      metadata = review?.metadata?.find((item) => item.token === reviewToken);
    if (!review || !metadata) throw new ProblemError('conflict');
    const account = owner(actor),
      personal = await personalEntries.readPersonalEntry(actor, metadata.subjectId);
    const profile = await profileMetadata(actor, metadata.subjectId);
    const sourceCurrent = review.token === metadata.sourceReviewToken;
    const matches =
      sourceCurrent &&
      review.target === metadata.subjectId &&
      review.guard !== null &&
      profile !== null &&
      profile.current.source.kind === 'supported' &&
      profile.current.source.pin.releaseDigest === review.guard.releaseDigest &&
      String(profile.current.anchor.identityEpoch) === review.guard.identityEpoch &&
      profile.incarnationId === metadata.incarnationId &&
      profile.digest === metadata.profileDigest;
    const unchanged =
      account.clientId === metadata.clientId &&
      (account.requestedBy ?? null) === metadata.requestedBy &&
      entryImportMetadataDigest(current.row.evidence) === metadata.sourceDigest &&
      entryPersonalMetadataDigest(personal) === metadata.personalDigest &&
      personal.annotationRevision === metadata.annotationRevision;
    const view: EntryImportMetadataView = {
      status: matches && unchanged ? 'current' : 'stale',
      reviewToken,
      sourceReviewToken: metadata.sourceReviewToken,
      subjectId: metadata.subjectId,
      personal,
      proposals: bangumiMetadataProposals(current.row.evidence),
      outcome: metadata.confirmation?.outcome ?? null,
    };
    if (Buffer.byteLength(JSON.stringify(view)) > ENTRY_IMPORT_METADATA_LIMITS.responseBytes)
      throw new ProblemError('invalid_request');
    return view;
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
    await change(
      actor,
      'metadata-progress',
      `${id}:${ordinal}:${token}:progress:${stateDigest}`,
      { id, ordinal, reviewToken: token, stateDigest },
      async (tx, a) => {
        const h = await header(tx, a, id, true),
          locked = await row(tx, a, id, ordinal, true),
          record = locked.review?.metadata?.find((item) => item.token === token);
        if (!record?.confirmation || record.confirmation.selectionDigest !== confirmation.selectionDigest)
          throw new ProblemError('conflict');
        const starting =
          (confirmation.annotationStarted && !record.confirmation.annotationStarted) ||
          (confirmation.provenanceStarted && !record.confirmation.provenanceStarted);
        if (
          starting &&
          (h.cancelled ||
            locked.review?.token !== record.sourceReviewToken ||
            entryImportMetadataDigest(locked.evidence) !== record.sourceDigest)
        )
          throw new ProblemError('conflict');
        record.confirmation = confirmation;
        assertEntryImportMetadataHistorySize(locked.review?.metadata ?? []);
        await tx.query(
          `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
          [...args(a, id), ordinal, JSON.stringify(locked.review)],
        );
        return { ordinal, reviewToken: token };
      },
    );
  }
  async function applyMetadata(
    actor: Actor,
    id: string,
    ordinal: number,
    reviewToken: string,
    fields: unknown,
    signal?: AbortSignal,
  ) {
    const selections = parseEntryImportMetadataSelections(fields),
      selectionDigest = entryImportMetadataDigest(selections);
    let initial = await read(actor, async (tx, a) => ({
      cancelled: (await header(tx, a, id)).cancelled,
      row: await row(tx, a, id, ordinal),
    }));
    const metadata = initial.row.review?.metadata?.find((item) => item.token === reviewToken);
    if (!metadata)
      return { reviewToken, fields: selections.map((item) => ({ field: item.field, status: 'stale' as const })) };
    if (metadata.confirmation && metadata.confirmation.selectionDigest !== selectionDigest)
      throw new ProblemError('conflict');
    if (metadata.confirmation?.outcome) return metadata.confirmation.outcome;
    if (!metadata.confirmation) {
      const confirmation = {
        fields: selections,
        selectionDigest,
        annotationKey: `bangumi:${id}:${ordinal}:${reviewToken}:annotations`,
        provenanceKey: `bangumi:${id}:${ordinal}:${reviewToken}:provenance`,
        annotationStarted: false,
        provenanceStarted: false,
      };
      await change(
        actor,
        'metadata-confirm',
        `${id}:${ordinal}:${reviewToken}`,
        { id, ordinal, reviewToken, selectionDigest },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            locked = await row(tx, a, id, ordinal, true);
          const record = locked.review?.metadata?.find((item) => item.token === reviewToken);
          if (!record) throw new ProblemError('conflict');
          if (record.confirmation) {
            if (record.confirmation.selectionDigest !== selectionDigest) throw new ProblemError('conflict');
            return { ordinal, reviewToken };
          }
          if (h.cancelled) throw new ProblemError('conflict');
          record.confirmation = confirmation;
          assertEntryImportMetadataHistorySize(locked.review?.metadata ?? []);
          await tx.query(
            `UPDATE library.bangumi_upload_row SET review=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(locked.review)],
          );
          return { ordinal, reviewToken };
        },
      );
      initial = await read(actor, async (tx, a) => ({
        cancelled: (await header(tx, a, id)).cancelled,
        row: await row(tx, a, id, ordinal),
      }));
    }
    const rowValue = initial.row,
      review = rowValue.review,
      state = review?.metadata?.find((item) => item.token === reviewToken);
    if (!state?.confirmation) throw new ProblemError('conflict');
    if (state.confirmation.outcome) return state.confirmation.outcome;
    const view = await metadataView(actor, id, ordinal, reviewToken);
    if (view.status !== 'current' && !state.confirmation.annotationStarted && !state.confirmation.provenanceStarted) {
      const outcome: EntryImportMetadataOutcome = {
        reviewToken,
        fields: selections.map((item) => ({ field: item.field, status: 'stale' })),
      };
      state.confirmation.outcome = outcome;
      await persistMetadataConfirmation(actor, id, ordinal, reviewToken, state.confirmation);
      return outcome;
    }
    const result = await applyEntryImportMetadataCommands({
      actor,
      subjectId: state.subjectId,
      provider: 'bangumi',
      recordId: String(rowValue.evidence.source.subject_id),
      reviewToken,
      personal: view.personal,
      proposals: view.proposals,
      selections,
      baselineAnnotationRevision: state.annotationRevision,
      confirmation: state.confirmation,
      native: personalEntries,
      persist: (confirmation) => persistMetadataConfirmation(actor, id, ordinal, reviewToken, confirmation),
      isCurrent: async () => {
        const latest = await read(actor, async (tx, a) => ({ row: await row(tx, a, id, ordinal) })),
          latestReview = latest.row.review,
          latestMetadata = latestReview?.metadata?.find((item) => item.token === reviewToken);
        if (
          !latestReview ||
          !latestMetadata ||
          latestReview.token !== latestMetadata.sourceReviewToken ||
          entryImportMetadataDigest(latest.row.evidence) !== latestMetadata.sourceDigest ||
          !latestReview.guard
        )
          return false;
        const profile = await profileMetadata(actor, latestMetadata.subjectId);
        return (
          !!profile &&
          profile.current.source.kind === 'supported' &&
          profile.current.source.pin.releaseDigest === latestReview.guard.releaseDigest &&
          String(profile.current.anchor.identityEpoch) === latestReview.guard.identityEpoch &&
          profile.incarnationId === latestMetadata.incarnationId &&
          profile.digest === latestMetadata.profileDigest
        );
      },
      isCancelled: async () => {
        try {
          return await read(actor, async (tx, a) => (await header(tx, a, id)).cancelled);
        } catch (error) {
          if (error instanceof ProblemError && error.code === 'not_found') return true;
          throw error;
        }
      },
      ...(signal === undefined ? {} : { signal }),
    });
    return result.outcome;
  }
  async function apply(actor: Actor, id: string, choices: BangumiChoice[], signal: AbortSignal, deadline: number) {
    if (new Set(choices.map((c) => c.ordinal)).size !== choices.length) throw new ProblemError('invalid_request');
    const outcomes: BangumiOutcome[] = [];
    for (const choice of choices) {
      if (signal.aborted || Date.now() >= deadline) break;
      const { ordinal } = choice;
      // The immutable submitted review and operands survive a crash between the native effect and acknowledgment.
      const claim = await change(
        actor,
        'confirm',
        `${id}:${ordinal}:${choice.reviewToken}`,
        { id, choice },
        async (tx, a) => {
          const h = await header(tx, a, id, true),
            r = await row(tx, a, id, ordinal);
          if (h.cancelled) throw new ProblemError('conflict');
          if (!r.review || r.review.token !== choice.reviewToken) throw new ProblemError('conflict');
          if (r.choice && canonicalize(r.choice) !== canonicalize(choice)) throw new ProblemError('conflict');
          await tx.query(
            `UPDATE library.bangumi_upload_row SET choice=$5::jsonb WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4`,
            [...args(a, id), ordinal, JSON.stringify(choice)],
          );
          // Private evidence stays out of durable command receipts.
          return { confirmed: true };
        },
      );
      void claim;
      const r = await read(actor, async (tx, a) => {
        if ((await header(tx, a, id)).cancelled) throw new ProblemError('conflict');
        return row(tx, a, id, ordinal);
      });
      // A receipt for an older confirmation cannot admit a subsequently refreshed review.
      if (r.review?.token !== choice.reviewToken) throw new ProblemError('conflict');
      if (r.outcome) {
        outcomes.push(r.outcome);
        continue;
      }
      if (canonicalize(r.choice) !== canonicalize(choice)) throw new ProblemError('conflict');
      const v = r.review;
      const outcome: BangumiOutcome = {
        ordinal,
        status: 'unsupported',
        applied: [],
        retained: r.evidence.fields.map((f) => f.field),
      };
      if (choice.skip) outcome.status = 'skipped';
      else if (choice.state === 'omit' || (v.current && choice.state === 'preserve')) outcome.status = 'skipped';
      else if (v.proposedState && v.guard && v.target) {
        try {
          await entries.putEntry(
            actor,
            v.target,
            {
              state: v.proposedState,
              ...(v.current
                ? {
                    revision: v.current.revision,
                    ...(v.current.incarnationId ? { incarnationId: v.current.incarnationId } : {}),
                  }
                : {}),
            },
            `bangumi:${id}:${ordinal}:${choice.reviewToken}`,
            v.guard,
          );
          outcome.status = 'applied';
          outcome.applied = ['type'];
        } catch (error) {
          if (error instanceof GrantDeniedError) throw error;
          outcome.status =
            error instanceof LibraryConflictError ||
            error instanceof LibraryNotFoundError ||
            (error instanceof ProblemError && error.code === 'unsupported_library_profile')
              ? 'stale'
              : 'failed';
        }
      }
      // Stale/failed rows can be refreshed; successful native effects always retain their original command.
      await change(actor, 'ack', randomUUID(), { id, ordinal, outcome }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          `UPDATE library.bangumi_upload_row SET outcome=$5::jsonb,
          choice=CASE WHEN $6 THEN NULL ELSE choice END WHERE route=$1 AND account_id=$2 AND upload_id=$3 AND ordinal=$4 AND review->>'token'=$7`,
          [
            ...args(a, id),
            ordinal,
            outcome.status === 'failed' ? null : JSON.stringify(outcome),
            outcome.status === 'stale',
            choice.reviewToken,
          ],
        );
        return { ordinal, status: outcome.status };
      });
      outcomes.push(outcome);
    }
    return { uploadId: id, outcomes, remaining: choices.slice(outcomes.length).map((c) => c.ordinal) };
  }
  async function cancel(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'cancel', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'UPDATE library.bangumi_upload SET cancelled=true WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        await tx.query(
          'UPDATE library.bangumi_upload_row SET labels=NULL WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { uploadId: id, cancelled: true };
      })
    ).value;
  }
  async function remove(actor: Actor, id: string, key: string) {
    return (
      await change(actor, 'delete', key, { id }, async (tx, a) => {
        await header(tx, a, id, true);
        await tx.query(
          'DELETE FROM library.bangumi_upload WHERE route=$1 AND account_id=$2 AND upload_id=$3',
          args(a, id),
        );
        return { deleted: true };
      })
    ).value;
  }
  return {
    preview,
    page,
    review,
    reviewMetadata,
    metadata: metadataView,
    applyMetadata,
    apply,
    cancel,
    remove,
    ...createBangumiLabelReview(deps, { read, change, header, row }),
  };
}
