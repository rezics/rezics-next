import type { QueryResultRow } from 'pg';
import type { Actor, AccessClient } from '../request/access.ts';
import {
  authoritativeTimeValue,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandOutcome,
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
import { readHostedPublicationStagingActivationTargets } from './hosted-publication-staging.ts';
import type { HostedPublicationTargetCursor } from './hosted-publication-staging-model.ts';
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
};

type ActivationWork = (
  tx: CommandTransaction,
  time: AuthoritativeTime,
  transactionId: string,
) => Promise<HostedPublicationActivationProgress>;

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
  constructor() {
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
  const authorization: CommandAuthorization = {
    ...baseAuthorization,
    async prepare(attempt) {
      const evidence = await baseAuthorization.prepare!(attempt);
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
      return evidence;
    },
  };

  return runCommand<HostedPublicationActivationProgress>(
    deps.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
      authorization,
    },
    async (tx, { time, transactionId }) => {
      const value = await work(tx, time, transactionId);
      return {
        value,
        events: [
          {
            type:
              operation === 'activate' && value.state === 'activated' ? ACTIVATION_EVENT : ACTIVATION_PROGRESS_EVENT,
            subject: catalogueId,
            data: { catalogueId, stageId },
          },
        ],
      };
    },
  );
}

async function readCandidate(
  tx: CommandTransaction,
  route: number,
  catalogueId: string,
  stageId: string,
  lock = false,
): Promise<CandidateRow | null> {
  return (
    (
      await tx.query<CandidateRow>(
        `SELECT route,catalogue_id,stage_id,generation_id,generation_sequence::text,
         preorder_root_id,chapter_root_id,placement_count::text,chapter_count::text,
         source_revision_id,expected_head_revision_id,expected_publication_id,
         initiator_account_id,owner_epoch::text,status
       FROM content.hosted_version_release_candidate
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3${lock ? ' FOR UPDATE' : ''}`,
        [route, catalogueId, stageId],
      )
    ).rows[0] ?? null
  );
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
  return activationCommand(deps, actor, catalogueId, stageId, 'start', { stageId }, context, async (tx) => {
    const existing = await readActivation(tx, route, catalogueId, stageId, true);
    if (existing) return progress(existing);

    const current = await hostedCatalogue(tx as AccessClient, catalogueId, true);
    const candidate = await readCandidate(tx, route, catalogueId, stageId, true);
    if (
      !current ||
      !candidate ||
      candidate.status !== 'sealed' ||
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
    return progress(created);
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
  if (!row) throw new HostedPublicationActivationIneligibleError();
  return { threadId, postId: catalogueId, revisionId: row.head_revision_id, sha256: row.sha256 };
}

async function resetPass(tx: CommandTransaction, row: ActivationRow): Promise<ActivationRow> {
  const vector = await capturePublicationAuthorityVector(tx as AccessClient);
  const passId = newId(row.route);
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
    [
      row.route,
      row.catalogue_id,
      row.stage_id,
      passId,
      ((await stageTargetCount(tx, row.route, row.catalogue_id, row.stage_id)) + 1n).toString(),
    ],
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
  return activationCommand(deps, actor, catalogueId, stageId, 'advance', { stageId }, context, async (tx) => {
    let row = await readActivation(tx, route, catalogueId, stageId, true);
    if (!row) throw activationNotFound();
    const candidate = await readCandidate(tx, route, catalogueId, stageId);
    if (!candidate || !candidateMatches(row, candidate, actor)) throw activationNotFound();
    if (row.state === 'activated' || row.state === 'ready') return progress(row);
    if (row.state === 'restart') row = await resetPass(tx, row);

    const observations: Array<Readonly<{ homes: readonly number[] }>> = [];
    let checked = BigInt(row.target_checked_count);
    let total = BigInt(row.target_total_count);
    let openingObservedThisPage = false;
    let opening = row.opening_checked
      ? {
          threadId: row.opening_thread_id!,
          postId: catalogueId,
          revisionId: row.opening_revision_id!,
          sha256: row.opening_sha256!.toString('hex'),
        }
      : null;

    if (!row.opening_checked) {
      const catalogue = await hostedCatalogue(tx as AccessClient, catalogueId);
      if (!catalogue) throw new ContentNotFoundError();
      opening = await openingTarget(tx, route, catalogueId, catalogue.thread_id);
      const observedOpening = await observeHostedPublicationActivationTarget(
        deps,
        {
          catalogueId,
          activationRevisionId: row.activation_revision_id,
          target: opening,
          occurrenceId: catalogueId,
          additionalAuthorityIds: [actor.accountId],
          opening: true,
        },
        { actor: { kind: 'anonymous' }, deadline: context.deadline },
      );
      if (!observedOpening) throw new HostedPublicationActivationIneligibleError();
      observations.push(observedOpening);
      openingObservedThisPage = true;
      checked += 1n;
      await tx.query(
        `UPDATE content.hosted_publication_activation
         SET opening_thread_id=$4,opening_revision_id=$5,opening_sha256=decode($6,'hex'),
           opening_checked=true,target_checked_count=$7::bigint,target_total_count=$8::bigint,
           updated_at=transaction_timestamp()
         WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
        [
          route,
          catalogueId,
          stageId,
          opening.threadId,
          opening.revisionId,
          opening.sha256,
          checked.toString(),
          total.toString(),
        ],
      );
      row = {
        ...row,
        opening_thread_id: opening.threadId,
        opening_revision_id: opening.revisionId,
        opening_sha256: Buffer.from(opening.sha256, 'hex'),
        opening_checked: true,
        target_checked_count: checked.toString(),
      };
    }

    const pageLimit = openingObservedThisPage ? AUTHORITY_PAGE_SIZE - 1 : AUTHORITY_PAGE_SIZE;
    const targetPage = await readHostedPublicationStagingActivationTargets(
      tx as AccessClient,
      actor,
      { catalogueId, stageId },
      targetCursor(row),
      pageLimit,
    );
    for (const item of targetPage.items) {
      const duplicateOpening =
        opening !== null &&
        item.target.threadId === opening.threadId &&
        item.target.postId === opening.postId &&
        item.target.revisionId === opening.revisionId &&
        item.target.sha256 === opening.sha256;
      if (duplicateOpening) {
        total -= 1n;
        continue;
      }
      const observed = await observeHostedPublicationActivationTarget(
        deps,
        {
          catalogueId,
          activationRevisionId: row.activation_revision_id,
          target: item.target,
          occurrenceId: item.occurrenceId,
          additionalAuthorityIds: [actor.accountId],
          expectedAuthorId: item.authorId,
          expectedLicence: item.licence,
        },
        { actor: { kind: 'anonymous' }, deadline: context.deadline },
      );
      if (!observed) throw new HostedPublicationActivationIneligibleError();
      observations.push(observed);
      checked += 1n;
    }
    await retainDependencies(tx, row, observations);
    const last = targetPage.items.at(-1);
    const nextCursor = targetPage.next;
    const complete = nextCursor === null;
    if (complete && checked !== total)
      throw new HostedPublicationActivationConflictError('The authority pass did not cover its exact target set');
    await tx.query(
      `UPDATE content.hosted_publication_activation
       SET target_after_thread_id=$4,target_after_post_id=$5,target_after_revision_id=$6,
         target_after_sha256=CASE WHEN $4::uuid IS NULL THEN NULL ELSE decode($7,'hex') END,
         target_checked_count=$8::bigint,target_total_count=$9::bigint,
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
      ],
    );
    const updated = await readActivation(tx, route, catalogueId, stageId);
    if (!updated) throw new HostedPublicationActivationConflictError();
    return progress(updated);
  });
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
      const candidate = await readCandidate(tx, route, catalogueId, stageId);
      if (!candidate || !candidateMatches(row, candidate, actor)) throw activationNotFound();
      if (row.state === 'activated') return progress(row);
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
        return progress(restart);
      }

      const current = await hostedCatalogue(tx as AccessClient, catalogueId, true);
      if (
        !current ||
        current.head_revision_id !== row.expected_head_revision_id ||
        current.publication_id !== row.expected_publication_id
      )
        throw new RevisionPreconditionError();
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
      await tx.query(
        `UPDATE content.hosted_publication_activation
       SET state='activated',publication_id=$4,completed_at=transaction_timestamp(),
         updated_at=transaction_timestamp()
       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3 AND state='ready'`,
        [route, catalogueId, stageId, row.activation_revision_id],
      );
      const completed = await readActivation(tx, route, catalogueId, stageId);
      if (!completed) throw new HostedPublicationActivationConflictError();
      return progress(completed);
    },
  );
}
