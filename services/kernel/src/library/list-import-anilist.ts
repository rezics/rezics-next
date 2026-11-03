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
import { ANILIST_LIMITS, AniListInputError, parseAniList, type AniListRow } from './list-import-anilist-parser.ts';
import { createSessionCommands } from './sessions.ts';
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
type Match = {
  state: 'matched' | 'ambiguous' | 'unmatched' | 'unavailable';
  candidates: string[];
  fingerprint: string;
};
type Observation = {
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
  match: Match;
  observation: Observation | null;
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
  progress?: { occurrence: ProgressAdoptionCheckpoint['occurrence']; complete: boolean; measures: ReturnType<typeof progressResults> };
};
type Stored = { source: AniListRow; review?: Review; started?: boolean; progress?: ProgressAdoptionCheckpoint; outcome?: AniListOutcome };
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
  const kind = media !== null && typeof media === 'object' && !Array.isArray(media)
    ? (media as Record<string, unknown>).type
    : null;
  const fields: [string, string | null][] = kind === 'ANIME'
    ? [['progress', 'episode'], ...(Object.hasOwn(evidence, 'progressVolumes') ? [['progressVolumes', null] as [string, null]] : [])]
    : kind === 'MANGA'
      ? [['progress', 'chapter'], ['progressVolumes', 'volume']]
      : [
          ...(Object.hasOwn(evidence, 'progress') ? [['progress', null] as [string, null]] : []),
          ...(Object.hasOwn(evidence, 'progressVolumes') ? [['progressVolumes', null] as [string, null]] : []),
        ];
  return fields.map(([field, unit]) => {
    const present = Object.hasOwn(evidence, field!);
    const validity = row.fields.find((item) => item.field === field)?.validity;
    const value = evidence[field!];
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
      field: field!,
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
  const sessions = createSessionCommands(deps);
  // Keep source payloads out of command receipts, events and exception text.
  async function snapshot<T>(actor: Actor, body: (client: PoolClient, account: AccountActor) => Promise<T>) {
    const account = owner(actor),
      route = requireRoute(account.accountId);
    const check = await accessCheck(
      access,
      account,
      'library_entry:update',
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
  async function match(actor: Actor, row: AniListRow): Promise<Match> {
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
  async function observe(actor: Actor, subjectId: string): Promise<Observation | null> {
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
      profileBinding: source.kind === 'supported'
        ? { pin: source.pin, epoch: String(anchor.identityEpoch), acceptingType: anchor.acceptingType }
        : null,
      proposedState: null,
    };
  }
  function propose(observation: Observation | null, row: AniListRow) {
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
        if (kind === 'start') {
          const header = (
            await tx.query<{ payload: Header }>(
              'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=-1 FOR SHARE',
              [route, account.accountId, id],
            )
          ).rows[0];
          if (!header || header.payload.cancelled) return noEffect({ reviewId: null });
        }
        const row = (
          await tx.query<{ payload: Stored }>(
            'SELECT payload FROM library.list_import_anilist WHERE route=$1 AND account_id=$2 AND import_id=$3 AND ordinal=$4 FOR UPDATE',
            [route, account.accountId, id, ordinal],
          )
        ).rows[0];
        if (!row) throw new LibraryNotFoundError();
        const next = change(row.payload);
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
      const observed =
        matching.state === 'matched'
          ? await observe(actor, matching.candidates[0]!)
          : null;
      const { profile, profileBinding: _profileBinding, ...visibleObservation } = observed ?? {};
      const proposal = propose(observed ? visibleObservation as Observation : null, row.payload.source);
      rows.push({
        ordinal: row.ordinal,
        source: row.payload.source,
        review: row.payload.review ?? null,
        started: row.payload.started ?? false,
        outcome: row.payload.outcome ?? null,
        match: matching,
        proposal,
        progressMeasures: describeProgressSources(profile ?? null, aniListProgressSources(row.payload.source)),
        progress: row.payload.review?.progress
          ? publicProgress(row.payload.review.progress, row.payload.progress)
          : null,
      });
    }
    await snapshot(actor, async () => undefined);
    return { header, rows, next: raw.length === 20 ? raw[raw.length - 1]!.ordinal : null };
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
    const { profile: _profile, profileBinding: _profileBinding, ...stateObservation } = inspected ?? {};
    const observation = selected ? propose(inspected ? stateObservation as Observation : null, stored.source) : null;
    if (selected && (!observation || selected !== observation.subjectId)) throw new LibraryConflictError();
    if (input.progress && (!selected || !inspected?.profile || !inspected.profileBinding))
      throw new LibraryConflictError();
    const progress = input.progress
      ? await reviewProgressAdoption(
          sessions,
          actor,
          selected!,
          inspected!.profile!,
          inspected!.profileBinding!,
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
      if (current.started && current.outcome?.status !== 'stale') throw new LibraryConflictError();
      return { source: current.source, review: value };
    });
    // Receipt replay refers to the stored review, never freshly computed operands.
    const current = await load(actor, id, ordinal);
    if (current.review?.id !== saved.value.reviewId) throw new LibraryConflictError();
    return { ordinal, review: current.review };
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
            const result = await save(
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
            if (result.value.reviewId !== reviewed.id) return false;
            stored.progress = checkpoint;
            return true;
          },
        });
        stored.progress = progressCheckpoint;
        outcome.progress = publicProgress(reviewed.progress, progressCheckpoint);
        const progressStatus = outcome.progress.measures.map((measure) => measure.status);
        if (progressStatus.includes('stale')) status = 'stale';
        else if (status === 'unsupported' && progressStatus.some((value) => value === 'applied' || value === 'cleared'))
          status = 'applied';
        else if (progressStatus.includes('failed')) status = 'failed';
        outcome.status = status;
      }
      // Failed attempts keep their original review and operands for native receipt replay.
      if (status !== 'failed' && (!reviewed.progress || progressCheckpoint?.complete))
        await save(actor, id, confirmation.ordinal, 'finish', reviewed.commandKey, outcome, (row) => {
          if (row.review?.id !== reviewed.id) throw new LibraryConflictError();
          return { ...row, outcome };
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
  return { preview, page, review, apply, cancel };
}
