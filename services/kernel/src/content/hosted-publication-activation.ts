import type { QueryResultRow } from 'pg';
import { publishHostedLanguageNamespace } from './hosted-chapter-language-namespace.ts';
import type { Actor, AccessClient } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  preflightCommandReceipt,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandAttempt,
  type CommandOutcome,
  type CommandResult,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import {
  capturePublicationAuthorityVector,
  lockAndComparePublicationAuthorityHomes,
  type PublicationAuthorityEpoch,
} from '../database/publication-authority.ts';
import { partitionOf, routeOf, newId } from '../route/route.ts';
import {
  ContentNotFoundError,
  RevisionPreconditionError,
  hostedPostAuthorization,
  type ContentCommandDependencies,
} from './commands.ts';
import { snapshot, type ContentReadDependencies } from './reads.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedChapterTarget, HostedCommandContext } from './hosted-chapters-model.ts';
import { observeHostedPublicationActivationTarget } from './hosted-publication-point-eligibility.ts';
import {
  lockHostedPublicationStagingForActivation,
  readHostedPublicationStagingActivationTargets,
} from './hosted-publication-staging.ts';
import type {
  HostedPublicationActivationTarget,
  HostedPublicationTargetCursor,
} from './hosted-publication-staging-model.ts';
import { commitHostedVersionRevision } from './hosted-version-revision.ts';
import { readHostedVersionSnapshot } from './hosted-version-store.ts';

const ACTIVATION_EVENT = 'com.rezics.content.hosted-catalogue.publication.activated.v1';
const ACTIVATION_PROGRESS_EVENT = 'com.rezics.content.hosted-catalogue.activation.changed.v1';
const AUTHORITY_PAGE_SIZE = 20;

export type HostedPublicationActivationState = 'checking' | 'ready' | 'restart' | 'activated';
export type HostedPublicationActivationProgress = Readonly<{
  catalogueId: string;
  stageId: string;
  state: HostedPublicationActivationState;
  passId: string;
  checkedTargetCount: string;
  totalTargetCount: string;
  candidateGenerationId: string;
  publicationId: string | null;
  restartRequired: boolean;
}>;

export type HostedPublicationActivationDependencies = ContentReadDependencies & ContentCommandDependencies;

type ActivationRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  initiator_account_id: string;
  owner_epoch: string;
  pass_id: string;
  activation_revision_id: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  candidate_generation_id: string;
  candidate_sequence: string;
  candidate_preorder_root_id: string | null;
  candidate_chapter_root_id: string | null;
  candidate_placement_count: string;
  candidate_chapter_count: string;
  target_after_thread_id: string | null;
  target_after_post_id: string | null;
  target_after_revision_id: string | null;
  target_after_sha256: Buffer | null;
  target_checked_count: string;
  target_total_count: string;
  opening_thread_id: string | null;
  opening_revision_id: string | null;
  opening_sha256: Buffer | null;
  opening_checked: boolean;
  state: HostedPublicationActivationState;
  publication_id: string | null;
};

type CandidateRow = QueryResultRow & {
  route: number;
  catalogue_id: string;
  stage_id: string;
  generation_id: string;
  generation_sequence: string;
  preorder_root_id: string | null;
  chapter_root_id: string | null;
  placement_count: string;
  chapter_count: string;
  source_revision_id: string;
  expected_head_revision_id: string;
  expected_publication_id: string | null;
  initiator_account_id: string;
  owner_epoch: string;
  status: string;
  stage_status: string;
  stage_expires_at: string;
  stage_expired: boolean;
  language_occurrence_count: string;
};

type PreparedActivationObservation = Readonly<{
  target: HostedChapterTarget;
  occurrenceId: string;
  result: Readonly<{ homes: readonly number[] }>;
}>;

type PreparedActivationAdvance = Readonly<{
  frontier: ActivationRow;
  candidate: CandidateRow;
  resetting: boolean;
  passId: string;
  vector: readonly PublicationAuthorityEpoch[] | null;
  cursor: HostedPublicationTargetCursor | null;
  pageLimit: number;
  page: Readonly<{ items: readonly HostedPublicationActivationTarget[]; next: HostedPublicationTargetCursor | null }>;
  opening: HostedChapterTarget;
  openingNeedsObservation: boolean;
  stageTargetCount: bigint | null;
  observations: readonly PreparedActivationObservation[];
  refusal: HostedPublicationActivationIneligibleError['reason'] | null;
}>;

type ActivationWork = (
  tx: CommandTransaction,
  time: AuthoritativeTime,
  transactionId: string,
  prepared: PreparedActivationAdvance | null,
) => Promise<CommandResult<HostedPublicationActivationProgress>>;

type ActivationPreparation = (attempt: CommandAttempt) => Promise<PreparedActivationAdvance | null>;

function accountActor(actor: Actor): Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account' || !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 0)
    throw new ContentNotFoundError();
  return actor;
}

function activationNotFound(): HostedPublicationActivationNotFoundError {
  return new HostedPublicationActivationNotFoundError();
}

export class HostedPublicationActivationNotFoundError extends Error {
  constructor() {
    super('Hosted publication activation is unavailable');
    this.name = 'HostedPublicationActivationNotFoundError';
  }
}

export class HostedPublicationActivationConflictError extends Error {
  constructor(message = 'Hosted publication activation does not match its sealed candidate') {
    super(message);
    this.name = 'HostedPublicationActivationConflictError';
  }
}

export class HostedPublicationActivationIneligibleError extends Error {
  constructor(readonly reason: 'catalogue_not_public' | 'chapter_not_eligible') {
    super('The exact Book release is not currently eligible for activation');
    this.name = 'HostedPublicationActivationIneligibleError';
  }
}

function progress(row: ActivationRow): HostedPublicationActivationProgress {
  return {
    catalogueId: row.catalogue_id,
    stageId: row.stage_id,
    state: row.state,
    passId: row.pass_id,
    checkedTargetCount: row.target_checked_count,
    totalTargetCount: row.target_total_count,
    candidateGenerationId: row.candidate_generation_id,
    publicationId: row.publication_id,
    restartRequired: row.state === 'restart',
  };
}

function activationEffect(
  value: HostedPublicationActivationProgress,
  type: typeof ACTIVATION_EVENT | typeof ACTIVATION_PROGRESS_EVENT,
): CommandResult<HostedPublicationActivationProgress> {
  return {
    value,
    events: [{ type, subject: value.catalogueId, data: { catalogueId: value.catalogueId, stageId: value.stageId } }],
  };
}

function activationProgressEffect(value: HostedPublicationActivationProgress) {
  return activationEffect(value, ACTIVATION_PROGRESS_EVENT);
}

function publicationActivatedEffect(value: HostedPublicationActivationProgress) {
  return activationEffect(value, ACTIVATION_EVENT);
}

function validateLocator(catalogueId: string, stageId: string): number {
  const route = routeOf(catalogueId);
  if (route === null || routeOf(stageId) !== route) throw activationNotFound();
  return route;
}

async function activationCommand(
  deps: HostedPublicationActivationDependencies,
  actorInput: Actor,
  catalogueId: string,
  stageId: string,
  operation: string,
  intent: unknown,
  context: HostedCommandContext,
  work: ActivationWork,
  prepareAdvance?: ActivationPreparation,
): Promise<CommandOutcome<HostedPublicationActivationProgress>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(catalogueId, stageId);
  const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId))).value;
  if (!initial) throw new ContentNotFoundError();

  const kind = `content.hosted-catalogue.activation.${operation}`;
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, { catalogueId, stageId, input: intent }),
  };
  const baseAuthorization = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
  let prepared: PreparedActivationAdvance | null = null;
  let preparationFailed = false;
  const authorization = (includeAdvancePreparation: boolean): CommandAuthorization => ({
    ...baseAuthorization,
    async prepare(attempt) {
      const advance = includeAdvancePreparation ? prepareAdvance : undefined;
      // Receipt preflight has already authorized a new advance. Do not age the
      // write's short-lived evidence while reading a page of foreign targets.
      const evidence = advance ? undefined : await baseAuthorization.prepare!(attempt);
      const staged = (
        await snapshot(deps, catalogueId, context, (client) =>
          client.query<{ initiator_account_id: string; owner_epoch: string }>(
            `SELECT initiator_account_id,owner_epoch::text AS owner_epoch
             FROM content.hosted_publication_staging
             WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
            [route, catalogueId, stageId],
          ),
        )
      ).value.rows[0];
      if (!staged || staged.initiator_account_id !== actor.accountId || staged.owner_epoch !== String(actor.authnEpoch))
        throw activationNotFound();
      if (!advance) return evidence;
      try {
        prepared = await advance(attempt);
      } catch (error) {
        preparationFailed = true;
        throw error;
      }
      return baseAuthorization.prepare!(attempt);
    },
  });
  const input = {
    ...principalCommandIdentity(actor),
    partition: partitionOf(route),
    deadline: context.deadline,
    clock: deps.clock,
    receipt,
  };
  const preflightAuthorization = authorization(false);

  if (prepareAdvance) {
    const replay = await preflightCommandReceipt<HostedPublicationActivationProgress>(deps.pool, {
      ...input,
      authorization: preflightAuthorization,
    });
    if (replay) return replay;
  }

  try {
    return await runCommand<HostedPublicationActivationProgress>(
      deps.pool,
      {
        ...input,
        authorization: authorization(prepareAdvance !== undefined),
      },
      async (tx, { time, transactionId }) => {
        // runCommand has already authorized and settled exact receipt replay.
        // Lock stage first, as build/reclaim do, before activation/candidate locks
        // and before the authority-home locks and final catalogue CAS. SERIALIZABLE
        // alone permits the stale stage read to precede a committed cancellation.
        await lockHostedPublicationStagingForActivation(tx as AccessClient, { catalogueId, stageId });
        return work(tx, time, transactionId, prepared);
      },
    );
  } catch (error) {
    if (prepareAdvance && preparationFailed) {
      const replay = await preflightCommandReceipt<HostedPublicationActivationProgress>(deps.pool, {
        ...input,
        authorization: preflightAuthorization,
      });
      if (replay) return replay;
    }
    throw error;
  }
}

async function readCandidate(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  stageId: string,
  time: AuthoritativeTime,
  lock = false,
): Promise<CandidateRow | null> {
  return (
    (
      await tx.query<CandidateRow>(
        `SELECT candidate.route,candidate.catalogue_id,candidate.stage_id,candidate.generation_id,
         candidate.generation_sequence::text,candidate.preorder_root_id,candidate.chapter_root_id,
         candidate.placement_count::text,candidate.chapter_count::text,candidate.source_revision_id,
         candidate.expected_head_revision_id,candidate.expected_publication_id,
         candidate.initiator_account_id,candidate.owner_epoch::text,candidate.status,
         stage.status AS stage_status,stage.language_occurrence_count::text,
         to_char(stage.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS stage_expires_at,
         (stage.expires_at<=$4::timestamptz) AS stage_expired
       FROM content.hosted_version_release_candidate candidate
       JOIN content.hosted_publication_staging stage
         ON stage.route=candidate.route AND stage.catalogue_id=candidate.catalogue_id
        AND stage.stage_id=candidate.stage_id
       WHERE candidate.route=$1 AND candidate.catalogue_id=$2 AND candidate.stage_id=$3
       ${lock ? 'FOR UPDATE OF candidate' : ''}`,
        [route, catalogueId, stageId, authoritativeTimeValue(time)],
      )
    ).rows[0] ?? null
  );
}

/** The stage deadline is compared in PostgreSQL, preserving sub-millisecond
 * precision. This admission belongs after native receipt replay, not in the
 * authorization wrapper: successful receipts outlive preparation expiry. */
function liveCandidate(candidate: CandidateRow): boolean {
  return candidate.status === 'sealed' && candidate.stage_status === 'sealed' && !candidate.stage_expired;
}

async function readActivation(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  stageId: string,
  lock = false,
): Promise<ActivationRow | null> {
  return (
    (
      await tx.query<ActivationRow>(
        `SELECT route,catalogue_id,stage_id,initiator_account_id,owner_epoch::text,pass_id,
         activation_revision_id,source_revision_id,expected_head_revision_id,expected_publication_id,
         candidate_generation_id,candidate_sequence::text,candidate_preorder_root_id,candidate_chapter_root_id,
         candidate_placement_count::text,candidate_chapter_count::text,
         target_after_thread_id,target_after_post_id,target_after_revision_id,target_after_sha256,
         target_checked_count::text,target_total_count::text,opening_thread_id,opening_revision_id,
         opening_sha256,opening_checked,state,publication_id
       FROM content.hosted_publication_activation
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3${lock ? ' FOR UPDATE' : ''}`,
        [route, catalogueId, stageId],
      )
    ).rows[0] ?? null
  );
}

function candidateMatches(row: ActivationRow, candidate: CandidateRow, actor: Actor): boolean {
  return (
    candidate.status === 'sealed' &&
    candidate.route === row.route &&
    candidate.catalogue_id === row.catalogue_id &&
    candidate.stage_id === row.stage_id &&
    candidate.generation_id === row.candidate_generation_id &&
    candidate.generation_sequence === row.candidate_sequence &&
    candidate.preorder_root_id === row.candidate_preorder_root_id &&
    candidate.chapter_root_id === row.candidate_chapter_root_id &&
    candidate.placement_count === row.candidate_placement_count &&
    candidate.chapter_count === row.candidate_chapter_count &&
    candidate.source_revision_id === row.source_revision_id &&
    candidate.expected_head_revision_id === row.expected_head_revision_id &&
    candidate.expected_publication_id === row.expected_publication_id &&
    candidate.initiator_account_id === row.initiator_account_id &&
    candidate.owner_epoch === row.owner_epoch &&
    actor.kind === 'account' &&
    row.initiator_account_id === actor.accountId &&
    row.owner_epoch === String(actor.authnEpoch)
  );
}

function targetCursor(row: ActivationRow): HostedPublicationTargetCursor | null {
  if (
    row.target_after_thread_id === null ||
    row.target_after_post_id === null ||
    row.target_after_revision_id === null ||
    row.target_after_sha256 === null
  )
    return null;
  return {
    threadId: row.target_after_thread_id,
    postId: row.target_after_post_id,
    revisionId: row.target_after_revision_id,
    sha256: row.target_after_sha256.toString('hex'),
  };
}

async function insertVector(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  stageId: string,
  passId: string,
  vector: readonly PublicationAuthorityEpoch[],
): Promise<void> {
  await tx.query(
    `INSERT INTO content.hosted_publication_activation_vector
       (route,catalogue_id,stage_id,pass_id,home_no,generation,epoch)
     SELECT $1,$2,$3,$4,home_no,generation,epoch
     FROM unnest($5::integer[],$6::uuid[],$7::bigint[]) AS captured(home_no,generation,epoch)`,
    [
      route,
      catalogueId,
      stageId,
      passId,
      vector.map((entry) => entry.home),
      vector.map((entry) => entry.generation),
      vector.map((entry) => entry.epoch),
    ],
  );
}

async function stageTargetCount(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  stageId: string,
): Promise<bigint> {
  const row = (
    await tx.query<{ target_count: string }>(
      `SELECT count(*)::text AS target_count
       FROM content.hosted_publication_staging_target
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
      [route, catalogueId, stageId],
    )
  ).rows[0];
  return BigInt(row?.target_count ?? '0');
}

/** Begin currentness checks for one immutable, sealed candidate. The full
 * installed vector is captured before any fresh target or container read. */
export function startHostedPublicationActivation(
  deps: HostedPublicationActivationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
): Promise<CommandOutcome<HostedPublicationActivationProgress>> {
  const route = validateLocator(catalogueId, stageId);
  return activationCommand(deps, actor, catalogueId, stageId, 'start', { stageId }, context, async (tx, time) => {
    const existing = await readActivation(tx, route, catalogueId, stageId, true);
    if (existing) {
      const candidate = await readCandidate(tx, route, catalogueId, stageId, time);
      if (!candidate || !liveCandidate(candidate)) throw activationNotFound();
      return noEffect(progress(existing));
    }

    const current = await hostedCatalogue(tx as AccessClient, catalogueId, true);
    const candidate = await readCandidate(tx, route, catalogueId, stageId, time, true);
    if (
      !current ||
      !candidate ||
      !liveCandidate(candidate) ||
      current.head_revision_id !== candidate.expected_head_revision_id ||
      current.publication_id !== candidate.expected_publication_id
    )
      throw new HostedPublicationActivationConflictError();
    const exactSnapshot = await readHostedVersionSnapshot(
      tx as AccessClient,
      catalogueId,
      candidate.generation_id,
      BigInt(candidate.generation_sequence),
    );
    if (
      !exactSnapshot ||
      exactSnapshot.generationKind !== 'candidate' ||
      exactSnapshot.placementCount !== BigInt(candidate.placement_count) ||
      exactSnapshot.chapterCount !== BigInt(candidate.chapter_count) ||
      exactSnapshot.preorderRootId !== candidate.preorder_root_id ||
      exactSnapshot.chapterRootId !== candidate.chapter_root_id
    )
      throw new HostedPublicationActivationConflictError('The sealed candidate snapshot is unavailable');

    const vector = await capturePublicationAuthorityVector(tx as AccessClient);
    const passId = newId(route);
    const activationRevisionId = newId(route);
    const totalTargets = (await stageTargetCount(tx, route, catalogueId, stageId)) + 1n;
    await tx.query(
      `INSERT INTO content.hosted_publication_activation
         (route,catalogue_id,stage_id,initiator_account_id,owner_epoch,pass_id,activation_revision_id,
          source_revision_id,expected_head_revision_id,expected_publication_id,candidate_generation_id,
          candidate_sequence,candidate_preorder_root_id,candidate_chapter_root_id,candidate_placement_count,
          candidate_chapter_count,target_total_count,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'checking')`,
      [
        route,
        catalogueId,
        stageId,
        candidate.initiator_account_id,
        candidate.owner_epoch,
        passId,
        activationRevisionId,
        candidate.source_revision_id,
        candidate.expected_head_revision_id,
        candidate.expected_publication_id,
        candidate.generation_id,
        candidate.generation_sequence,
        candidate.preorder_root_id,
        candidate.chapter_root_id,
        candidate.placement_count,
        candidate.chapter_count,
        totalTargets.toString(),
      ],
    );
    await insertVector(tx, route, catalogueId, stageId, passId, vector);
    const created = await readActivation(tx, route, catalogueId, stageId);
    if (!created) throw new HostedPublicationActivationConflictError('The activation pass was not retained');
    return activationProgressEffect(progress(created));
  });
}

async function vectorEntriesForHomes(
  tx: CommandTransaction,
  row: ActivationRow,
  homes: readonly number[],
): Promise<readonly PublicationAuthorityEpoch[]> {
  const unique = [...new Set(homes)].sort((left, right) => left - right);
  if (unique.length === 0) return [];
  const result = await tx.query<QueryResultRow & { home_no: number; generation: string; epoch: string }>(
    `SELECT home_no,generation::text,epoch::text
     FROM content.hosted_publication_activation_vector
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND pass_id=$4 AND home_no=ANY($5::integer[])
     ORDER BY home_no`,
    [row.route, row.catalogue_id, row.stage_id, row.pass_id, unique],
  );
  if (result.rows.length !== unique.length)
    throw new HostedPublicationActivationConflictError('A dependency home was missing from the captured vector');
  return result.rows.map((entry) => ({ home: entry.home_no, generation: entry.generation, epoch: entry.epoch }));
}

async function retainDependencies(
  tx: CommandTransaction,
  row: ActivationRow,
  observations: readonly Readonly<{ homes: readonly number[] }>[],
): Promise<void> {
  const counts = new Map<number, number>();
  for (const observation of observations)
    for (const home of new Set(observation.homes)) counts.set(home, (counts.get(home) ?? 0) + 1);
  if (counts.size === 0) return;
  const captured = await vectorEntriesForHomes(tx, row, [...counts.keys()]);
  await tx.query(
    `INSERT INTO content.hosted_publication_activation_dependency
       (route,catalogue_id,stage_id,pass_id,home_no,generation,epoch,observation_count)
     SELECT $1,$2,$3,$4,home_no,generation,epoch,observation_count
     FROM unnest($5::integer[],$6::uuid[],$7::bigint[],$8::bigint[])
       AS dependency(home_no,generation,epoch,observation_count)
     ON CONFLICT (route,catalogue_id,stage_id,pass_id,home_no)
     DO UPDATE SET observation_count=content.hosted_publication_activation_dependency.observation_count
       + EXCLUDED.observation_count`,
    [
      row.route,
      row.catalogue_id,
      row.stage_id,
      row.pass_id,
      captured.map((entry) => entry.home),
      captured.map((entry) => entry.generation),
      captured.map((entry) => entry.epoch),
      captured.map((entry) => counts.get(entry.home) ?? 0),
    ],
  );
}

async function openingTarget(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  threadId: string,
): Promise<HostedChapterTarget> {
  const row = (
    await tx.query<{ head_revision_id: string; sha256: string }>(
      `SELECT p.head_revision_id,encode(r.body_sha256,'hex') AS sha256
       FROM content.post p
       JOIN content.revision r ON r.route=p.route AND r.thread_id=p.thread_id
        AND r.post_id=p.post_id AND r.revision_id=p.head_revision_id
       WHERE p.route=$1 AND p.thread_id=$2 AND p.post_id=$3`,
      [route, threadId, catalogueId],
    )
  ).rows[0];
  if (!row) throw new HostedPublicationActivationIneligibleError('catalogue_not_public');
  return { threadId, postId: catalogueId, revisionId: row.head_revision_id, sha256: row.sha256 };
}

/** Read the locked staging reader's exact page shape without taking its stage
 * fence; the command repeats this page under the fence before accepting results. */
async function readActivationPageForPreparation(
  client: AccessClient,
  route: number,
  catalogueId: string,
  stageId: string,
  after: HostedPublicationTargetCursor | null,
  limit: number,
): Promise<
  Readonly<{ items: readonly HostedPublicationActivationTarget[]; next: HostedPublicationTargetCursor | null }>
> {
  const rows = (
    await client.query<
      QueryResultRow & {
        thread_id: string;
        post_id: string;
        target_revision_id: string;
        sha256: string;
        occurrence_id: string;
        author_account_id: string;
        licence: string;
        observed_at: string;
      }
    >(
      `SELECT t.thread_id,t.post_id,t.target_revision_id,encode(t.body_sha256,'hex') AS sha256,
         candidate.occurrence_id,t.author_account_id,t.licence,
         to_char(t.observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at
       FROM (
         SELECT thread_id,post_id,target_revision_id,body_sha256,author_account_id,licence,observed_at
         FROM content.hosted_publication_staging_target
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
           AND ($4::uuid IS NULL OR ROW(thread_id,post_id,target_revision_id,body_sha256)>
             ROW($4::uuid,$5::uuid,$6::uuid,decode($7,'hex')))
         ORDER BY thread_id,post_id,target_revision_id,body_sha256
         LIMIT $8
       ) t
       JOIN LATERAL (
         SELECT c.occurrence_id
         FROM content.hosted_publication_staging_candidate c
         WHERE c.route=$1 AND c.catalogue_id=$2 AND c.stage_id=$3 AND c.kind='chapter'
           AND c.thread_id=t.thread_id AND c.post_id=t.post_id
           AND c.target_revision_id=t.target_revision_id AND c.body_sha256=t.body_sha256
         UNION ALL
         SELECT language.occurrence_id FROM content.hosted_publication_language_target language
         WHERE language.route=$1 AND language.catalogue_id=$2 AND language.stage_id=$3
           AND language.thread_id=t.thread_id AND language.post_id=t.post_id
           AND language.target_revision_id=t.target_revision_id AND language.body_sha256=t.body_sha256
         ORDER BY occurrence_id
         LIMIT 1
       ) candidate ON true
       ORDER BY t.thread_id,t.post_id,t.target_revision_id,t.body_sha256
       LIMIT $8`,
      [
        route,
        catalogueId,
        stageId,
        after?.threadId ?? null,
        after?.postId ?? null,
        after?.revisionId ?? null,
        after?.sha256 ?? null,
        limit + 1,
      ],
    )
  ).rows;
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => ({
    target: { threadId: row.thread_id, postId: row.post_id, revisionId: row.target_revision_id, sha256: row.sha256 },
    occurrenceId: row.occurrence_id,
    authorId: row.author_account_id,
    licence: row.licence,
    observedAt: row.observed_at,
  }));
  const last = items.at(-1);
  return {
    items,
    next:
      more && last
        ? {
            threadId: last.target.threadId,
            postId: last.target.postId,
            revisionId: last.target.revisionId,
            sha256: last.target.sha256,
          }
        : null,
  };
}

function sameTarget(left: HostedChapterTarget, right: HostedChapterTarget): boolean {
  return (
    left.threadId === right.threadId &&
    left.postId === right.postId &&
    left.revisionId === right.revisionId &&
    left.sha256 === right.sha256
  );
}

function sameCursor(left: HostedPublicationTargetCursor | null, right: HostedPublicationTargetCursor | null): boolean {
  return (left === null && right === null) || (left !== null && right !== null && sameTarget(left, right));
}

function sameActivationFrontier(left: ActivationRow, right: ActivationRow): boolean {
  const sameBytes = (a: Buffer | null, b: Buffer | null) => (a === null ? b === null : b !== null && a.equals(b));
  return (
    left.route === right.route &&
    left.catalogue_id === right.catalogue_id &&
    left.stage_id === right.stage_id &&
    left.initiator_account_id === right.initiator_account_id &&
    left.owner_epoch === right.owner_epoch &&
    left.pass_id === right.pass_id &&
    left.activation_revision_id === right.activation_revision_id &&
    left.source_revision_id === right.source_revision_id &&
    left.expected_head_revision_id === right.expected_head_revision_id &&
    left.expected_publication_id === right.expected_publication_id &&
    left.candidate_generation_id === right.candidate_generation_id &&
    left.candidate_sequence === right.candidate_sequence &&
    left.candidate_preorder_root_id === right.candidate_preorder_root_id &&
    left.candidate_chapter_root_id === right.candidate_chapter_root_id &&
    left.candidate_placement_count === right.candidate_placement_count &&
    left.candidate_chapter_count === right.candidate_chapter_count &&
    left.target_after_thread_id === right.target_after_thread_id &&
    left.target_after_post_id === right.target_after_post_id &&
    left.target_after_revision_id === right.target_after_revision_id &&
    sameBytes(left.target_after_sha256, right.target_after_sha256) &&
    left.target_checked_count === right.target_checked_count &&
    left.target_total_count === right.target_total_count &&
    left.opening_thread_id === right.opening_thread_id &&
    left.opening_revision_id === right.opening_revision_id &&
    sameBytes(left.opening_sha256, right.opening_sha256) &&
    left.opening_checked === right.opening_checked &&
    left.state === right.state &&
    left.publication_id === right.publication_id
  );
}

function sameCandidate(left: CandidateRow, right: CandidateRow): boolean {
  return (
    left.route === right.route &&
    left.catalogue_id === right.catalogue_id &&
    left.stage_id === right.stage_id &&
    left.generation_id === right.generation_id &&
    left.generation_sequence === right.generation_sequence &&
    left.preorder_root_id === right.preorder_root_id &&
    left.chapter_root_id === right.chapter_root_id &&
    left.placement_count === right.placement_count &&
    left.chapter_count === right.chapter_count &&
    left.source_revision_id === right.source_revision_id &&
    left.expected_head_revision_id === right.expected_head_revision_id &&
    left.expected_publication_id === right.expected_publication_id &&
    left.initiator_account_id === right.initiator_account_id &&
    left.owner_epoch === right.owner_epoch &&
    left.status === right.status &&
    left.stage_status === right.stage_status &&
    left.stage_expires_at === right.stage_expires_at &&
    left.stage_expired === right.stage_expired
  );
}

function samePage(left: PreparedActivationAdvance['page'], right: PreparedActivationAdvance['page']): boolean {
  return (
    sameCursor(left.next, right.next) &&
    left.items.length === right.items.length &&
    left.items.every((item, index) => {
      const other = right.items[index];
      return (
        other !== undefined &&
        sameTarget(item.target, other.target) &&
        item.occurrenceId === other.occurrenceId &&
        item.authorId === other.authorId &&
        item.licence === other.licence &&
        item.observedAt === other.observedAt
      );
    })
  );
}

function observationsMatchPage(prepared: PreparedActivationAdvance): boolean {
  const expected: Array<Readonly<{ target: HostedChapterTarget; occurrenceId: string }>> = [];
  if (prepared.openingNeedsObservation)
    expected.push({ target: prepared.opening, occurrenceId: prepared.frontier.catalogue_id });
  for (const item of prepared.page.items)
    if (!sameTarget(item.target, prepared.opening))
      expected.push({ target: item.target, occurrenceId: item.occurrenceId });
  return (
    expected.length === prepared.observations.length &&
    expected.every((item, index) => {
      const observation = prepared.observations[index];
      return (
        observation !== undefined &&
        sameTarget(observation.target, item.target) &&
        observation.occurrenceId === item.occurrenceId
      );
    })
  );
}

async function prepareActivationAdvance(
  deps: HostedPublicationActivationDependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  route: number,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
  attempt: CommandAttempt,
): Promise<PreparedActivationAdvance | null> {
  const plan = (
    await snapshot(deps, catalogueId, context, async (client) => {
      const readClient = client as unknown as CommandTransaction;
      const frontier = await readActivation(readClient, route, catalogueId, stageId);
      if (!frontier) throw activationNotFound();
      if (frontier.state === 'activated' || frontier.state === 'ready') return null;

      const candidate = await readCandidate(readClient, route, catalogueId, stageId, attempt.time);
      if (!candidate || !liveCandidate(candidate) || !candidateMatches(frontier, candidate, actor))
        throw activationNotFound();
      const resetting = frontier.state === 'restart';
      if (!resetting && frontier.state !== 'checking')
        throw new HostedPublicationActivationConflictError('The authority pass is not accepting progress');

      // A restarted pass captures its new fixed vector before any exact target
      // observer runs. The observations and vector stay bound to this pass ID.
      const passId = resetting ? newId(route) : frontier.pass_id;
      const vector = resetting ? await capturePublicationAuthorityVector(client) : null;
      const cursor = resetting ? null : targetCursor(frontier);
      const openingNeedsObservation = resetting || !frontier.opening_checked;
      let opening: HostedChapterTarget;
      if (openingNeedsObservation) {
        const catalogue = await hostedCatalogue(client, catalogueId);
        if (!catalogue) throw new ContentNotFoundError();
        opening = await openingTarget(readClient, route, catalogueId, catalogue.thread_id);
      } else {
        opening = {
          threadId: frontier.opening_thread_id!,
          postId: catalogueId,
          revisionId: frontier.opening_revision_id!,
          sha256: frontier.opening_sha256!.toString('hex'),
        };
      }
      const pageLimit = openingNeedsObservation ? AUTHORITY_PAGE_SIZE - 1 : AUTHORITY_PAGE_SIZE;
      const page = await readActivationPageForPreparation(client, route, catalogueId, stageId, cursor, pageLimit);
      const targetCount = resetting ? await stageTargetCount(readClient, route, catalogueId, stageId) : null;
      return {
        frontier,
        candidate,
        resetting,
        passId,
        vector,
        cursor,
        pageLimit,
        page,
        opening,
        openingNeedsObservation,
        stageTargetCount: targetCount,
      };
    })
  ).value;
  if (!plan) return null;

  const observations: PreparedActivationObservation[] = [];
  let refusal: PreparedActivationAdvance['refusal'] = null;
  const readContext = { actor: { kind: 'anonymous' as const }, deadline: context.deadline };
  if (plan.openingNeedsObservation) {
    const observed = await observeHostedPublicationActivationTarget(
      deps,
      {
        catalogueId,
        activationRevisionId: plan.frontier.activation_revision_id,
        target: plan.opening,
        occurrenceId: catalogueId,
        additionalAuthorityIds: [actor.accountId],
        catalogueOpening: true,
      },
      readContext,
    );
    if (!observed) refusal = 'catalogue_not_public';
    else observations.push({ target: plan.opening, occurrenceId: catalogueId, result: observed });
  }
  if (!refusal) {
    for (const item of plan.page.items) {
      if (sameTarget(item.target, plan.opening)) continue;
      const observed = await observeHostedPublicationActivationTarget(
        deps,
        {
          catalogueId,
          activationRevisionId: plan.frontier.activation_revision_id,
          target: item.target,
          occurrenceId: item.occurrenceId,
          additionalAuthorityIds: [actor.accountId],
          expectedAuthorId: item.authorId,
          expectedLicence: item.licence,
        },
        readContext,
      );
      if (!observed) {
        refusal = 'chapter_not_eligible';
        break;
      }
      observations.push({ target: item.target, occurrenceId: item.occurrenceId, result: observed });
    }
  }
  return { ...plan, observations, refusal };
}

async function resetPass(
  tx: CommandTransaction,
  row: ActivationRow,
  passId: string,
  vector: readonly PublicationAuthorityEpoch[],
  targetCount: bigint,
): Promise<ActivationRow> {
  await tx.query(
    `DELETE FROM content.hosted_publication_activation_dependency
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [row.route, row.catalogue_id, row.stage_id],
  );
  await tx.query(
    `DELETE FROM content.hosted_publication_activation_vector
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [row.route, row.catalogue_id, row.stage_id],
  );
  await tx.query(
    `UPDATE content.hosted_publication_activation
     SET pass_id=$4,target_after_thread_id=NULL,target_after_post_id=NULL,
       target_after_revision_id=NULL,target_after_sha256=NULL,target_checked_count=0,
       target_total_count=$5,opening_thread_id=NULL,opening_revision_id=NULL,
       opening_sha256=NULL,opening_checked=false,state='checking',updated_at=transaction_timestamp()
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
    [row.route, row.catalogue_id, row.stage_id, passId, (targetCount + 1n).toString()],
  );
  await insertVector(tx, row.route, row.catalogue_id, row.stage_id, passId, vector);
  const updated = await readActivation(tx, row.route, row.catalogue_id, row.stage_id);
  if (!updated) throw new HostedPublicationActivationConflictError('The authority pass could not be restarted');
  return updated;
}

/** Advance at most 20 distinct exact targets. A restart captures a fresh fixed
 * vector first and reuses the same immutable candidate generation. */
export function advanceHostedPublicationActivationAuthority(
  deps: HostedPublicationActivationDependencies,
  actorInput: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
): Promise<CommandOutcome<HostedPublicationActivationProgress>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(catalogueId, stageId);
  return activationCommand(
    deps,
    actor,
    catalogueId,
    stageId,
    'advance',
    { stageId },
    context,
    async (tx, time, _transactionId, prepared) => {
      let row = await readActivation(tx, route, catalogueId, stageId, true);
      if (!row) throw activationNotFound();
      const candidate = await readCandidate(tx, route, catalogueId, stageId, time);
      if (!candidate || !liveCandidate(candidate) || !candidateMatches(row, candidate, actor))
        throw activationNotFound();
      if (row.state === 'activated' || row.state === 'ready') return noEffect(progress(row));

      if (
        !prepared ||
        !sameActivationFrontier(row, prepared.frontier) ||
        !sameCandidate(candidate, prepared.candidate) ||
        (row.state === 'restart') !== prepared.resetting
      )
        throw new HostedPublicationActivationConflictError('The prepared authority page is stale');

      if (prepared.openingNeedsObservation) {
        const catalogue = await hostedCatalogue(tx as AccessClient, catalogueId);
        if (!catalogue) throw new ContentNotFoundError();
        const currentOpening = await openingTarget(tx, route, catalogueId, catalogue.thread_id);
        if (!sameTarget(currentOpening, prepared.opening))
          throw new HostedPublicationActivationConflictError('The prepared opening source changed');
      }

      const targetPage = await readHostedPublicationStagingActivationTargets(
        tx as AccessClient,
        actor,
        { catalogueId, stageId },
        prepared.cursor,
        prepared.pageLimit,
      );
      if (!samePage(prepared.page, targetPage))
        throw new HostedPublicationActivationConflictError('The prepared exact target page changed');
      if (prepared.refusal) throw new HostedPublicationActivationIneligibleError(prepared.refusal);
      if (!observationsMatchPage(prepared))
        throw new HostedPublicationActivationConflictError('The authority observations do not cover the exact page');

      const resetting = prepared.resetting;
      if (resetting) {
        if (!prepared.vector || prepared.stageTargetCount === null)
          throw new HostedPublicationActivationConflictError('The restarted authority vector was not prepared');
        const currentTargetCount = await stageTargetCount(tx, route, catalogueId, stageId);
        if (currentTargetCount !== prepared.stageTargetCount)
          throw new HostedPublicationActivationConflictError('The sealed target set changed during restart');
        row = await resetPass(tx, row, prepared.passId, prepared.vector, prepared.stageTargetCount);
      }

      const opening = prepared.opening;
      let checked = resetting ? 0n : BigInt(row.target_checked_count);
      let total = resetting ? prepared.stageTargetCount! + 1n : BigInt(row.target_total_count);
      if (prepared.openingNeedsObservation) checked += 1n;
      for (const item of targetPage.items) {
        const duplicateOpening = sameTarget(item.target, opening);
        if (duplicateOpening) {
          total -= 1n;
          continue;
        }
        checked += 1n;
      }
      await retainDependencies(
        tx,
        row,
        prepared.observations.map(({ result }) => result),
      );
      const last = targetPage.items.at(-1);
      const complete = targetPage.next === null;
      if (complete && checked !== total)
        throw new HostedPublicationActivationConflictError('The authority pass did not cover its exact target set');
      await tx.query(
        `UPDATE content.hosted_publication_activation
       SET target_after_thread_id=$4,target_after_post_id=$5,target_after_revision_id=$6,
         target_after_sha256=CASE WHEN $4::uuid IS NULL THEN NULL ELSE decode($7,'hex') END,
         target_checked_count=$8::bigint,target_total_count=$9::bigint,
         opening_thread_id=COALESCE($11::uuid,opening_thread_id),
         opening_revision_id=COALESCE($12::uuid,opening_revision_id),
         opening_sha256=CASE WHEN $11::uuid IS NULL THEN opening_sha256 ELSE decode($13,'hex') END,
         opening_checked=opening_checked OR ($11::uuid IS NOT NULL),
         state=$10,updated_at=transaction_timestamp()
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [
          route,
          catalogueId,
          stageId,
          last?.target.threadId ?? null,
          last?.target.postId ?? null,
          last?.target.revisionId ?? null,
          last?.target.sha256 ?? null,
          checked.toString(),
          total.toString(),
          complete ? 'ready' : 'checking',
          prepared.openingNeedsObservation ? opening.threadId : null,
          prepared.openingNeedsObservation ? opening.revisionId : null,
          prepared.openingNeedsObservation ? opening.sha256 : null,
        ],
      );
      const updated = await readActivation(tx, route, catalogueId, stageId);
      if (!updated) throw new HostedPublicationActivationConflictError();
      return activationProgressEffect(progress(updated));
    },
    (attempt) => prepareActivationAdvance(deps, actor, route, catalogueId, stageId, context, attempt),
  );
}

/** Compare only recorded dependency homes and keep their row locks through the
 * descriptor/root/publication CAS, receipt, event and COMMIT. A stale vector
 * schedules a new authority pass without rebuilding the candidate. */
export function activateHostedPublicationCandidate(
  deps: HostedPublicationActivationDependencies,
  actorInput: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
): Promise<CommandOutcome<HostedPublicationActivationProgress>> {
  const actor = accountActor(actorInput);
  const route = validateLocator(catalogueId, stageId);
  return activationCommand(
    deps,
    actor,
    catalogueId,
    stageId,
    'activate',
    { stageId },
    context,
    async (tx, time, transactionId) => {
      const row = await readActivation(tx, route, catalogueId, stageId, true);
      if (!row) throw activationNotFound();
      const candidate = await readCandidate(tx, route, catalogueId, stageId, time);
      if (!candidate || !liveCandidate(candidate) || !candidateMatches(row, candidate, actor))
        throw activationNotFound();
      if (row.state === 'activated') return noEffect(progress(row));
      if (row.state !== 'ready')
        throw new HostedPublicationActivationConflictError('Authority checks are not complete');

      const dependencies = await tx.query<
        QueryResultRow & { home_no: number; generation: string; epoch: string; observation_count: string }
      >(
        `SELECT home_no,generation::text,epoch::text,observation_count::text
       FROM content.hosted_publication_activation_dependency
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND pass_id=$4
       ORDER BY home_no`,
        [route, catalogueId, stageId, row.pass_id],
      );
      if (dependencies.rows.length === 0)
        throw new HostedPublicationActivationConflictError('No native authority dependencies were retained');
      const locked = await lockAndComparePublicationAuthorityHomes(
        tx as AccessClient,
        dependencies.rows.map((entry) => ({ home: entry.home_no, generation: entry.generation, epoch: entry.epoch })),
      );
      if (!locked.matches) {
        await tx.query(
          `UPDATE content.hosted_publication_activation
         SET state='restart',updated_at=transaction_timestamp()
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
          [route, catalogueId, stageId],
        );
        const restart = await readActivation(tx, route, catalogueId, stageId);
        if (!restart) throw new HostedPublicationActivationConflictError();
        return activationProgressEffect(progress(restart));
      }

      // Earlier passes could prove the catalogue via chapter consent. Check its native
      // publication flags with the existing catalogue lock and retained authority locks.
      const current = (
        await tx.query<{ head_revision_id: string; publication_id: string | null; opening_published: boolean }>(
          `SELECT c.head_revision_id,c.publication_id,EXISTS (
             SELECT 1 FROM content.thread t
             JOIN content.post p ON p.route=t.route AND p.thread_id=t.thread_id AND p.post_id=t.first_post_id
             WHERE t.route=c.route AND t.thread_id=c.thread_id AND p.post_id=c.catalogue_id
               AND p.visibility='published' AND t.visibility='published'
           ) AS opening_published
           FROM content.hosted_catalogue c WHERE c.route=$1 AND c.catalogue_id=$2 FOR UPDATE OF c`,
          [route, catalogueId],
        )
      ).rows[0];
      if (
        !current ||
        current.head_revision_id !== row.expected_head_revision_id ||
        current.publication_id !== row.expected_publication_id
      )
        throw new RevisionPreconditionError();
      if (!current.opening_published) throw new HostedPublicationActivationIneligibleError('catalogue_not_public');

      const activationSnapshot = {
        route,
        catalogueId,
        generationId: row.candidate_generation_id,
        generationKind: 'candidate' as const,
        sequence: BigInt(row.candidate_sequence),
      };
      await commitHostedVersionRevision(tx as AccessClient, {
        revisionId: row.activation_revision_id,
        revisionKind: 'publication',
        snapshot: activationSnapshot,
        recordedTransactionId: transactionId,
        recordedAt: authoritativeTimeValue(time),
        expectedDraftRevisionId: row.expected_head_revision_id,
        expectedPublicationId: row.expected_publication_id,
      });
      if (BigInt(candidate.language_occurrence_count) > 0n)
        await publishHostedLanguageNamespace(tx as AccessClient, catalogueId, stageId, row.activation_revision_id);
      await tx.query(
        `UPDATE content.hosted_publication_activation
       SET state='activated',publication_id=$4,completed_at=transaction_timestamp(),
         updated_at=transaction_timestamp()
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND state='ready'`,
        [route, catalogueId, stageId, row.activation_revision_id],
      );
      const completed = await readActivation(tx, route, catalogueId, stageId);
      if (!completed) throw new HostedPublicationActivationConflictError();
      return publicationActivatedEffect(progress(completed));
    },
  );
}
