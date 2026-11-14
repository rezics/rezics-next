import type { Actor, AccessClient } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  preflightCommandReceipt,
  runCommand,
  type CommandAttempt,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, type ContentCommandDependencies } from './commands.ts';
import { snapshot } from './reads.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedCommandContext, HostedDependencies } from './hosted-chapters-model.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  cancelHostedPublicationStagingWithEvidence,
  freezeHostedPublicationSelectionWithEvidence,
  requireRoute,
  readHostedPublicationAdvanceReplay,
  readHostedPublicationAdvanceProgressWithPreparation,
  readHostedPublicationStagingProgress,
  readHostedPublicationStagingProgressWithExpiry,
  retainHostedPublicationAdvanceReceipt,
  prepareHostedPublicationStagingAdvance,
  sealHostedPublicationStaging,
  type HostedPublicationStagingAdvancePreparation,
} from './hosted-publication-staging.ts';
import type {
  HostedPublicationAdvancePhase,
  HostedPublicationStagingBatchResult,
  HostedPublicationStagingCheckpoint,
  HostedPublicationStagingLocator,
} from './hosted-publication-staging-model.ts';
import { HostedPublicationStagingConflictError } from './hosted-publication-staging-model.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  readHostedVersionReleaseCandidateProgress,
  sealHostedVersionReleaseCandidate,
} from './hosted-version-release-candidate.ts';
import type { HostedVersionReleaseCandidateCheckpoint } from './hosted-version-release-candidate-model.ts';

export type HostedPublicationPreparationDependencies = HostedDependencies & ContentCommandDependencies;

export type HostedPublicationPreparationCandidate = Readonly<{
  candidateId: string;
  generationId: string;
  afterSourceOrder: string | null;
  placementCount: string;
  rootCount: string;
  chapterCount: string;
  coverageComplete: boolean;
  sealed: boolean;
}>;

export type HostedPublicationPreparationProgress = Readonly<{
  catalogueId: string;
  stageId: string;
  stage: HostedPublicationStagingCheckpoint;
  batch?: HostedPublicationStagingBatchResult;
  candidate: HostedPublicationPreparationCandidate | null;
  candidateReady: boolean;
}>;

type PreparationEffect = 'changed' | 'none';
type PreparationWorkResult = Readonly<{
  value: HostedPublicationPreparationProgress;
  effect: PreparationEffect;
}>;
type PreparationWork = (
  tx: CommandTransaction,
  time: AuthoritativeTime,
  prepared: unknown,
) => Promise<PreparationWorkResult>;
type PreparationPreparation = (attempt: CommandAttempt) => Promise<unknown>;
type StageBinding = Readonly<{ stageId: string; allowMissing: boolean }>;

const PREPARATION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const PREPARATION_EVENT = 'com.rezics.content.hosted-catalogue.preparation.changed.v1';

function candidateProgress(checkpoint: HostedVersionReleaseCandidateCheckpoint): HostedPublicationPreparationCandidate {
  return {
    candidateId: checkpoint.candidateId,
    generationId: checkpoint.generationId,
    afterSourceOrder: checkpoint.afterSourceOrder,
    placementCount: checkpoint.placementCount,
    rootCount: checkpoint.rootCount,
    chapterCount: checkpoint.chapterCount,
    coverageComplete: checkpoint.coverageComplete,
    sealed: checkpoint.sealed,
  };
}

function progress(
  catalogueId: string,
  stage: HostedPublicationStagingCheckpoint,
  candidate: HostedPublicationPreparationCandidate | null = null,
  batch?: HostedPublicationStagingBatchResult,
): HostedPublicationPreparationProgress {
  return {
    catalogueId,
    stageId: stage.locator.stageId,
    stage,
    ...(batch === undefined ? {} : { batch }),
    candidate,
    candidateReady: candidate?.sealed === true,
  };
}

function preparationResult(value: HostedPublicationPreparationProgress, changed: boolean): PreparationWorkResult {
  return { value, effect: changed ? 'changed' : 'none' };
}

/** Every preparation operation is an ordinary catalogue-home command. `runCommand` performs
 * current Post/container/revise authorization before it reads the retained
 * receipt, so exact retries keep their original response after later progress. */
function preparationCommand(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  operation: string,
  intent: unknown,
  context: HostedCommandContext,
  work: PreparationWork,
  stageBinding?: StageBinding,
  prepareWork?: PreparationPreparation,
): Promise<CommandOutcome<HostedPublicationPreparationProgress>> {
  const route = routeOf(catalogueId);
  if (route === null || actor.kind !== 'account') throw new ContentNotFoundError();
  return (async () => {
    const initial = (await snapshot(deps, catalogueId, context, (client) => hostedCatalogue(client, catalogueId)))
      .value;
    if (!initial) throw new ContentNotFoundError();

    const kind = `content.hosted-catalogue.preparation.${operation}`;
    const receipt = {
      kind,
      key: context.idempotencyKey,
      digest: requestDigest(kind, actor, { catalogueId, input: intent }),
    };
    const baseAuthorization = hostedPostAuthorization(deps, actor, initial.thread_id, catalogueId, context, receipt);
    const stageBoundAuthorization: CommandAuthorization = {
      ...baseAuthorization,
      async prepare(attempt) {
        const evidence = await baseAuthorization.prepare!(attempt);
        if (stageBinding) {
          const staged = (
            await snapshot(deps, catalogueId, context, (client) =>
              client.query<{ initiator_account_id: string; owner_epoch: string }>(
                `SELECT initiator_account_id,owner_epoch::text AS owner_epoch
                 FROM content.hosted_publication_staging
                 WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
                [route, catalogueId, stageBinding.stageId],
              ),
            )
          ).value.rows[0];
          if (!staged) {
            if (!stageBinding.allowMissing) throw new ContentNotFoundError();
          } else if (
            staged.initiator_account_id !== actor.accountId ||
            staged.owner_epoch !== String(actor.authnEpoch)
          ) {
            throw new ContentNotFoundError();
          }
        }
        return evidence;
      },
    };
    const preparedByTime = new WeakMap<AuthoritativeTime, unknown>();
    const authorization: CommandAuthorization = {
      ...stageBoundAuthorization,
      async prepare(attempt) {
        // Receipt preflight already checks current authority; let foreign attachment reads finish
        // before preparing the evidence reused by the final authorization at this command time.
        if (prepareWork) preparedByTime.set(attempt.time, await prepareWork(attempt));
        return stageBoundAuthorization.prepare!(attempt);
      },
    };
    const commandInput = {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: deps.clock,
      receipt,
    };
    if (prepareWork) {
      const replay = await preflightCommandReceipt<HostedPublicationPreparationProgress>(deps.pool, {
        ...commandInput,
        authorization: stageBoundAuthorization,
      });
      if (replay) return replay;
    }
    return runCommand<HostedPublicationPreparationProgress>(
      deps.pool,
      {
        ...commandInput,
        authorization,
      },
      async (tx, { time }) => {
        const result = await work(tx, time, preparedByTime.get(time));
        if (result.effect === 'none') return noEffect(result.value);
        return {
          value: result.value,
          events: [
            {
              type: PREPARATION_EVENT,
              subject: catalogueId,
              data: { catalogueId, stageId: result.value.stageId },
            },
          ],
        };
      },
    );
  })();
}

function locator(catalogueId: string, stageId: string): HostedPublicationStagingLocator {
  return { catalogueId, stageId };
}

/** Start a whole or explicit selection stage from the expected live Book source.
 * The expected IDs are stale-intent preconditions; the stage captures the exact
 * descriptor and current publication pointer inside this transaction. */
export function startHostedPublicationPreparation(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  input: Readonly<{
    stageId: string;
    expectedRevisionId: string;
    expectedPublicationId: string | null;
    mode: 'whole' | 'selection';
  }>,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'start',
    input,
    context,
    async (tx, time) => {
      const expiresAt = new Date(Date.parse(authoritativeTimeValue(time)) + PREPARATION_LIFETIME_MS);
      const begun = await beginHostedPublicationStaging(tx as AccessClient, actor, {
        catalogueId,
        stageId: input.stageId,
        expectedHeadRevisionId: input.expectedRevisionId,
        expectedPublicationId: input.expectedPublicationId,
        mode: input.mode,
        expiresAt,
      });
      return preparationResult(progress(catalogueId, begun.progress), !begun.replayed);
    },
    { stageId: input.stageId, allowMissing: true },
  );
}

export function appendHostedPublicationPreparationBatch(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  input: Readonly<{ batchId: string; occurrenceIds: readonly string[] }>,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'batch',
    { stageId, ...input },
    context,
    async (tx) => {
      const batch = await appendHostedPublicationSelectionBatch(tx as AccessClient, actor, {
        ...locator(catalogueId, stageId),
        ...input,
      });
      const stageRead = await readHostedPublicationStagingProgressWithExpiry(
        tx as AccessClient,
        actor,
        locator(catalogueId, stageId),
      );
      return preparationResult(
        progress(catalogueId, stageRead.progress, null, batch),
        !batch.replayed || stageRead.expired,
      );
    },
    { stageId, allowMissing: false },
  );
}

export function freezeHostedPublicationPreparationSelection(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'freeze',
    { stageId },
    context,
    async (tx) => {
      const result = await freezeHostedPublicationSelectionWithEvidence(
        tx as AccessClient,
        actor,
        locator(catalogueId, stageId),
      );
      return preparationResult(progress(catalogueId, result.checkpoint), result.changed);
    },
    { stageId, allowMissing: false },
  );
}

async function candidateAfterSourceSeal(
  tx: CommandTransaction,
  actor: Actor,
  stageId: string,
  catalogueId: string,
): Promise<Readonly<{ checkpoint: HostedVersionReleaseCandidateCheckpoint; changed: boolean }>> {
  const source = await sealHostedPublicationStaging(tx as AccessClient, actor, locator(catalogueId, stageId));
  const candidate = await beginHostedVersionReleaseCandidate(tx, actor, source.seal);
  return { checkpoint: candidate.checkpoint, changed: !source.replayed || !candidate.replayed };
}

/** Advance exactly one retained staging or candidate page. The choice of source
 * phase and frontier comes only from native progress and candidate checkpoints. */
export function advanceHostedPublicationPreparation(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  stepId: string,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'advance',
    { stageId, stepId },
    context,
    async (tx, _time, preparedValue) => {
      // runCommand authorizes and checks committed receipts before entering this body. This
      // fresh-work precondition covers candidate phases before any stage or candidate work.
      requireRoute(stepId, routeOf(catalogueId)!);
      const stageLocator = locator(catalogueId, stageId);
      const replay = await readHostedPublicationAdvanceReplay(tx as AccessClient, actor, stageLocator, stepId);
      if (replay?.kind === 'preparation')
        return preparationResult(replay.response as HostedPublicationPreparationProgress, false);
      if (replay?.kind === 'staging') return preparationResult(progress(catalogueId, replay.progress), false);

      const preparation = preparedValue as HostedPublicationStagingAdvancePreparation | null;
      if (!preparation) throw new HostedPublicationStagingConflictError('Advance preparation is unavailable');
      const stageRead = await readHostedPublicationAdvanceProgressWithPreparation(
        tx as AccessClient,
        actor,
        stageLocator,
      );
      const stage = stageRead.progress;
      if (
        !stageRead.expired &&
        stage.state !== 'cancelled' &&
        stage.state !== 'expired' &&
        stage.state !== 'failed' &&
        stageRead.stageFingerprint !== preparation.stageFingerprint
      )
        throw new HostedPublicationStagingConflictError('Prepared stage changed before advance');
      let phase: HostedPublicationAdvancePhase;
      let processed = 0;
      let fromFrontier = stage.sourceFrontier;
      let toFrontier = stage.sourceFrontier;
      let retainPreparationReceipt = true;
      let result: PreparationWorkResult;

      if (stage.state === 'building' || stage.state === 'closing' || stage.state === 'collecting') {
        let acknowledged: PreparationWorkResult | undefined;
        const advanced = await advanceHostedPublicationStaging(
          deps,
          tx as AccessClient,
          actor,
          stageLocator,
          stepId,
          context.deadline,
          (sourceResult) => {
            acknowledged = preparationResult(
              progress(catalogueId, sourceResult.progress),
              stageRead.expired || !sourceResult.replayed,
            );
            return acknowledged.value;
          },
          preparation,
        );
        // A zero-row step can still persist phase or failure progress, so native replay evidence decides the event.
        phase = advanced.phase;
        processed = advanced.processed;
        retainPreparationReceipt = false;
        result =
          acknowledged ??
          preparationResult(progress(catalogueId, advanced.progress), stageRead.expired || !advanced.replayed);
      } else if (stage.state === 'ready') {
        const source = await sealHostedPublicationStaging(tx as AccessClient, actor, stageLocator);
        const candidate = await beginHostedVersionReleaseCandidate(tx, actor, source.seal);
        const sealedStage = await readHostedPublicationStagingProgress(tx as AccessClient, actor, stageLocator);
        phase = 'candidate_begin';
        fromFrontier = '-1';
        toFrontier = candidate.checkpoint.afterSourceOrder ?? '-1';
        result = preparationResult(
          progress(catalogueId, sealedStage, candidateProgress(candidate.checkpoint)),
          stageRead.expired || !source.replayed || !candidate.replayed,
        );
      } else if (stage.state === 'sealed') {
        const materialization = await candidateAfterSourceSeal(tx, actor, stageId, catalogueId);
        const checkpoint = materialization.checkpoint;
        if (checkpoint.coverageComplete) {
          phase = materialization.changed ? 'candidate_begin' : 'exhausted';
          fromFrontier = checkpoint.afterSourceOrder ?? '-1';
          toFrontier = checkpoint.afterSourceOrder ?? '-1';
          result = preparationResult(
            progress(catalogueId, stage, candidateProgress(checkpoint)),
            stageRead.expired || materialization.changed,
          );
        } else {
          const advanced = await applyHostedVersionReleaseCandidatePage(
            tx,
            actor,
            checkpoint.sourceSeal,
            checkpoint.afterSourceOrder,
          );
          phase = 'candidate_page';
          processed = advanced.processed;
          fromFrontier = checkpoint.afterSourceOrder ?? '-1';
          toFrontier = advanced.checkpoint.afterSourceOrder ?? '-1';
          result = preparationResult(
            progress(catalogueId, stage, candidateProgress(advanced.checkpoint)),
            stageRead.expired || materialization.changed || !advanced.replayed,
          );
        }
      } else {
        phase = 'terminal';
        result = preparationResult(progress(catalogueId, stage), stageRead.expired);
      }

      if (retainPreparationReceipt)
        await retainHostedPublicationAdvanceReceipt(tx as AccessClient, actor, stageLocator, stepId, {
          phase,
          processed,
          fromFrontier,
          toFrontier,
          progress: result.value.stage,
          response: result.value,
        });
      return result;
    },
    { stageId, allowMissing: false },
    () => prepareHostedPublicationStagingAdvance(deps, actor, locator(catalogueId, stageId), stepId, context.deadline),
  );
}

export function readHostedPublicationPreparationProgress(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'progress',
    { stageId },
    context,
    async (tx) => {
      const stageRead = await readHostedPublicationStagingProgressWithExpiry(
        tx as AccessClient,
        actor,
        locator(catalogueId, stageId),
      );
      const stage = stageRead.progress;
      if (stage.state !== 'sealed') return preparationResult(progress(catalogueId, stage), stageRead.expired);
      const candidate = await readHostedVersionReleaseCandidateProgress(tx, actor, locator(catalogueId, stageId));
      const value = progress(catalogueId, stage, candidate === null ? null : candidateProgress(candidate));
      return preparationResult(value, stageRead.expired);
    },
    { stageId, allowMissing: false },
  );
}

export function cancelHostedPublicationPreparation(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'cancel',
    { stageId },
    context,
    async (tx) => {
      const result = await cancelHostedPublicationStagingWithEvidence(
        tx as AccessClient,
        actor,
        locator(catalogueId, stageId),
      );
      return preparationResult(progress(catalogueId, result.checkpoint), result.changed);
    },
    { stageId, allowMissing: false },
  );
}

/** Seal coverage when complete, then seal the exact private candidate only after
 * its retained page frontier proves full source coverage. */
export function sealHostedPublicationPreparation(
  deps: HostedPublicationPreparationDependencies,
  actor: Actor,
  catalogueId: string,
  stageId: string,
  context: HostedCommandContext,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'seal',
    { stageId },
    context,
    async (tx) => {
      const stageLocator = locator(catalogueId, stageId);
      const source = await sealHostedPublicationStaging(tx as AccessClient, actor, stageLocator);
      const candidate = await beginHostedVersionReleaseCandidate(tx, actor, source.seal);
      let checkpoint = candidate.checkpoint;
      let changed = !source.replayed || !candidate.replayed;
      if (checkpoint.coverageComplete && !checkpoint.sealed) {
        const sealed = await sealHostedVersionReleaseCandidate(tx, actor, candidate.checkpoint.sourceSeal);
        changed ||= !sealed.replayed;
        checkpoint = {
          ...checkpoint,
          placementCount: sealed.candidate.coverage.placementCount,
          rootCount: sealed.candidate.coverage.rootCount,
          chapterCount: sealed.candidate.coverage.chapterCount,
          sealed: true,
        };
      }
      const stage = await readHostedPublicationStagingProgress(tx as AccessClient, actor, stageLocator);
      return preparationResult(progress(catalogueId, stage, candidateProgress(checkpoint)), changed);
    },
    { stageId, allowMissing: false },
  );
}
