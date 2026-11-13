import type { Actor, AccessClient } from '../request/access.ts';
import {
  authoritativeTimeValue,
  type CommandAttempt,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandAuthorization,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { derivedId, partitionOf, routeOf } from '../route/route.ts';
import { commandAccessContext, captureDurableInitiator, durableInitiatorCommitment } from './access-port.ts';
import {
  ContentNotFoundError,
  RevisionPreconditionError,
  hostedPostAuthorization,
  type ContentCommandDependencies,
} from './commands.ts';
import { snapshot } from './reads.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedCommandContext, HostedDependencies } from './hosted-chapters-model.ts';
import {
  HOSTED_PREPARATION_OPERATION,
  HOSTED_PREPARATION_START,
  deleteHostedPublicationPreparationInitiator,
  writeHostedPublicationPreparationInitiator,
  type HostedPublicationPreparationAuthority,
} from './hosted-publication-preparation-initiator.ts';
import {
  HOSTED_PUBLICATION_PREPARATION_WORK_EVENT,
  type HostedPublicationPreparationWorkInput,
} from './work-contract.ts';
import type { DurableInitiatorRecord, DurableOperationAnchor } from '../access/durable-initiator.ts';
import {
  advanceHostedPublicationStaging,
  appendHostedPublicationSelectionBatch,
  beginHostedPublicationStaging,
  cancelHostedPublicationStaging,
  freezeHostedPublicationSelection,
  readHostedPublicationStagingProgress,
  sealHostedPublicationStaging,
} from './hosted-publication-staging.ts';
import type {
  HostedPublicationStagingBatchResult,
  HostedPublicationStagingCheckpoint,
  HostedPublicationStagingLocator,
} from './hosted-publication-staging-model.ts';
import {
  applyHostedVersionReleaseCandidatePage,
  beginHostedVersionReleaseCandidate,
  sealHostedVersionReleaseCandidate,
} from './hosted-version-release-candidate.ts';
import type { HostedVersionReleaseCandidateCheckpoint } from './hosted-version-release-candidate-model.ts';

export type HostedPublicationPreparationDependencies = Omit<HostedDependencies, 'tokens'> & ContentCommandDependencies;

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
  durableInitiator?: string;
}>;

type PreparationWork = (
  tx: CommandTransaction,
  time: AuthoritativeTime,
  actor: Actor,
  transactionId: string,
  capture: Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'> | null,
) => Promise<HostedPublicationPreparationProgress>;
type StageBinding = Readonly<{ stageId: string; allowMissing: boolean }>;
type PreparedAuthorization = Readonly<{
  authorization: CommandAuthorization;
  evidence: unknown;
}>;

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

function preparationWorkInput(
  catalogueId: string,
  value: HostedPublicationPreparationProgress,
): HostedPublicationPreparationWorkInput {
  const stageId = value.stageId;
  const route = routeOf(stageId);
  if (route === null || routeOf(catalogueId) !== route) throw new TypeError('Invalid hosted preparation source');
  const frontier =
    value.stage.state === 'building'
      ? `staging:${value.stage.mode}:${value.stage.mode === 'whole' ? value.stage.sourceFrontier : value.stage.settledInputCount}`
      : value.stage.state === 'closing'
        ? `closure:${value.stage.closureFrontier}`
        : value.stage.state === 'ready'
          ? `ready:${value.stage.candidateCount}:${value.stage.closureFrontier}`
          : value.stage.state === 'sealed'
            ? `candidate:${value.candidate?.afterSourceOrder ?? 'start'}`
            : null;
  if (frontier === null) throw new TypeError('Hosted preparation stage has no work frontier');
  return {
    catalogueId,
    stageId,
    stepId: derivedId(stageId, `hosted-preparation-step:${frontier}`, route),
    commandKey: derivedId(stageId, `hosted-preparation-command:${frontier}`, route),
  };
}

function needsPreparationWork(value: HostedPublicationPreparationProgress): boolean {
  return (
    ['building', 'closing', 'ready'].includes(value.stage.state) ||
    (value.stage.state === 'sealed' && value.candidate?.coverageComplete !== true && value.candidate?.sealed !== true)
  );
}

async function stopOnChangedSource(
  tx: CommandTransaction,
  actor: Actor,
  catalogueId: string,
  stage: HostedPublicationStagingCheckpoint,
): Promise<HostedPublicationStagingCheckpoint | null> {
  if (!['building', 'closing', 'ready', 'sealed'].includes(stage.state)) return null;
  const current = await hostedCatalogue(tx as AccessClient, catalogueId, true);
  if (
    current &&
    current.head_revision_id === stage.expectedHeadRevisionId &&
    current.publication_id === stage.expectedPublicationId
  )
    return null;
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  await tx.query(
    `UPDATE content.hosted_publication_staging SET status='failed',failure='stale_source'
     WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3
       AND status IN ('building','closing','ready','sealed')`,
    [route, catalogueId, stage.locator.stageId],
  );
  return readHostedPublicationStagingProgress(tx as AccessClient, actor, stage.locator);
}

/** Every mutation is an ordinary catalogue-home command. `runCommand` performs
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
  preparationAuthority?: HostedPublicationPreparationAuthority,
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
    let preparedActor: Actor = actor;
    let preparedCapture: Pick<DurableInitiatorRecord, 'originalAccount' | 'originalDelegation'> | null = null;
    const attempts = new WeakMap<CommandAttempt, PreparedAuthorization>();
    const authorization: CommandAuthorization = {
      action: baseAuthorization.action,
      resource: baseAuthorization.resource,
      denied: () => baseAuthorization.denied(),
      async prepare(attempt) {
        let admittedActor = actor;
        if (preparationAuthority) {
          if (!stageBinding) throw new TypeError('Hosted preparation worker requires a bound stage');
          const operation: DurableOperationAnchor = {
            route,
            id: stageBinding.stageId,
            sourceId: stageBinding.stageId,
            kind: HOSTED_PREPARATION_OPERATION,
          };
          admittedActor = await preparationAuthority.restoreInitiator(
            {
              operation,
              action: 'post:revise',
              anchor: {
                resource: baseAuthorization.resource,
                async validate(client, _time) {
                  const staged = (
                    await client.query<{ initiator_account_id: string; owner_epoch: string }>(
                      `SELECT initiator_account_id,owner_epoch::text AS owner_epoch
                       FROM content.hosted_publication_staging
                       WHERE route=$1 AND catalogue_id=$2 AND stage_id=$3`,
                      [route, catalogueId, stageBinding.stageId],
                    )
                  ).rows[0];
                  const current = await hostedCatalogue(client, catalogueId);
                  return Boolean(
                    staged &&
                    current &&
                    staged.initiator_account_id === actor.accountId &&
                    staged.owner_epoch === String(actor.authnEpoch) &&
                    current.thread_id === initial.thread_id,
                  );
                },
              },
              context: { pool: deps.pool, deadline: context.deadline },
            },
            attempt.time,
          );
        }
        const activeAuthorization =
          admittedActor === actor
            ? baseAuthorization
            : hostedPostAuthorization(deps, admittedActor, initial.thread_id, catalogueId, context, receipt);
        const evidence = await activeAuthorization.prepare!(attempt);
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
            staged.initiator_account_id !== admittedActor.accountId ||
            admittedActor.kind !== 'account' ||
            staged.owner_epoch !== String(admittedActor.authnEpoch)
          ) {
            throw new ContentNotFoundError();
          }
        }
        if (operation === 'start') {
          if (admittedActor.kind !== 'account') throw new ContentNotFoundError();
          preparedCapture = await captureDurableInitiator(
            commandAccessContext({ pool: deps.pool, deadline: context.deadline }, attempt),
            admittedActor,
          );
        }
        preparedActor = admittedActor;
        attempts.set(attempt, { authorization: activeAuthorization, evidence });
        return { authorization: activeAuthorization, evidence } satisfies PreparedAuthorization;
      },
      async authorize(tx, attempt, evidence) {
        const prepared = attempts.get(attempt) ?? (evidence as PreparedAuthorization);
        return prepared.authorization.authorize(tx, attempt, prepared.evidence);
      },
      async finalize(tx, attempt, evidence) {
        const prepared = attempts.get(attempt) ?? (evidence as PreparedAuthorization);
        await prepared.authorization.finalize?.(tx, attempt, prepared.evidence);
      },
    };
    return runCommand<HostedPublicationPreparationProgress>(
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
        const value = await work(tx, time, preparedActor, transactionId, preparedCapture);
        if (
          value.stage.state === 'cancelled' ||
          value.stage.state === 'expired' ||
          value.stage.state === 'failed' ||
          value.candidate?.sealed
        )
          await deleteHostedPublicationPreparationInitiator(tx as AccessClient, catalogueId, value.stageId);
        const next = needsPreparationWork(value) ? preparationWorkInput(catalogueId, value) : null;
        return {
          value,
          events: [
            {
              type: PREPARATION_EVENT,
              subject: catalogueId,
              data: { catalogueId, stageId: value.stageId },
            },
            ...(next ? [{ type: HOSTED_PUBLICATION_PREPARATION_WORK_EVENT, subject: catalogueId, data: next }] : []),
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
    async (tx, time, commandActor, transactionId, capture) => {
      const current = await hostedCatalogue(tx as AccessClient, catalogueId, true);
      if (!current) throw new ContentNotFoundError();
      if (
        current.head_revision_id !== input.expectedRevisionId ||
        current.publication_id !== input.expectedPublicationId
      )
        throw new RevisionPreconditionError();

      const expiresAt = new Date(Date.parse(authoritativeTimeValue(time)) + PREPARATION_LIFETIME_MS);
      const begun = await beginHostedPublicationStaging(tx as AccessClient, commandActor, {
        catalogueId,
        stageId: input.stageId,
        expectedHeadRevisionId: current.head_revision_id,
        expectedPublicationId: current.publication_id,
        mode: input.mode,
        expiresAt,
      });
      if (commandActor.kind !== 'account' || !capture) throw new ContentNotFoundError();
      const record = await writeHostedPublicationPreparationInitiator(tx as AccessClient, {
        catalogueId,
        stageId: input.stageId,
        actor: commandActor,
        transactionId,
        idempotencyKey: context.idempotencyKey,
        requestDigest: requestDigest(HOSTED_PREPARATION_START, commandActor, { catalogueId, input }),
        capture,
      });
      return { ...progress(catalogueId, begun.progress), durableInitiator: durableInitiatorCommitment(record) };
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
    async (tx, _time, commandActor) => {
      const batch = await appendHostedPublicationSelectionBatch(tx as AccessClient, commandActor, {
        ...locator(catalogueId, stageId),
        ...input,
      });
      const stage = await readHostedPublicationStagingProgress(
        tx as AccessClient,
        commandActor,
        locator(catalogueId, stageId),
      );
      return progress(catalogueId, stage, null, batch);
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
    async (tx, _time, commandActor) => {
      const stage = await freezeHostedPublicationSelection(
        tx as AccessClient,
        commandActor,
        locator(catalogueId, stageId),
      );
      return progress(catalogueId, stage);
    },
    { stageId, allowMissing: false },
  );
}

async function candidateAfterSourceSeal(
  tx: CommandTransaction,
  actor: Actor,
  stageId: string,
  catalogueId: string,
): Promise<HostedVersionReleaseCandidateCheckpoint> {
  const source = await sealHostedPublicationStaging(tx as AccessClient, actor, locator(catalogueId, stageId));
  const candidate = await beginHostedVersionReleaseCandidate(tx, actor, source.seal);
  return candidate.checkpoint;
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
  authority?: HostedPublicationPreparationAuthority,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'advance',
    { stageId, stepId },
    context,
    async (tx, _time, commandActor) => {
      const stageLocator = locator(catalogueId, stageId);
      const stage = await readHostedPublicationStagingProgress(tx as AccessClient, commandActor, stageLocator);
      const stale = await stopOnChangedSource(tx, commandActor, catalogueId, stage);
      if (stale) return progress(catalogueId, stale);

      if (stage.state === 'building' || stage.state === 'closing' || stage.state === 'collecting') {
        if (authority && stage.state === 'collecting') return progress(catalogueId, stage);
        if (authority && preparationWorkInput(catalogueId, progress(catalogueId, stage)).stepId !== stepId)
          return progress(catalogueId, stage);
        const advanced = await advanceHostedPublicationStaging(
          deps,
          tx as AccessClient,
          commandActor,
          stageLocator,
          stepId,
          context.deadline,
        );
        return progress(catalogueId, advanced.progress);
      }

      if (stage.state === 'ready') {
        if (authority && preparationWorkInput(catalogueId, progress(catalogueId, stage)).stepId !== stepId)
          return progress(catalogueId, stage);
        const source = await sealHostedPublicationStaging(tx as AccessClient, commandActor, stageLocator);
        const candidate = await beginHostedVersionReleaseCandidate(tx, commandActor, source.seal);
        const sealedStage = await readHostedPublicationStagingProgress(tx as AccessClient, commandActor, stageLocator);
        return progress(catalogueId, sealedStage, candidateProgress(candidate.checkpoint));
      }

      if (stage.state === 'sealed') {
        const checkpoint = await candidateAfterSourceSeal(tx, commandActor, stageId, catalogueId);
        const candidate = candidateProgress(checkpoint);
        if (authority && preparationWorkInput(catalogueId, progress(catalogueId, stage, candidate)).stepId !== stepId)
          return progress(catalogueId, stage, candidate);
        if (checkpoint.coverageComplete) return progress(catalogueId, stage, candidateProgress(checkpoint));
        const advanced = await applyHostedVersionReleaseCandidatePage(
          tx,
          commandActor,
          checkpoint.sourceSeal,
          checkpoint.afterSourceOrder,
        );
        return progress(catalogueId, stage, candidateProgress(advanced.checkpoint));
      }

      return progress(catalogueId, stage);
    },
    { stageId, allowMissing: false },
    authority,
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
    async (tx, _time, commandActor) => {
      const stage = await readHostedPublicationStagingProgress(
        tx as AccessClient,
        commandActor,
        locator(catalogueId, stageId),
      );
      if (stage.state !== 'sealed') return progress(catalogueId, stage);
      const candidate = await candidateAfterSourceSeal(tx, commandActor, stageId, catalogueId);
      return progress(catalogueId, stage, candidateProgress(candidate));
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
    async (tx, _time, commandActor) => {
      const stage = await cancelHostedPublicationStaging(
        tx as AccessClient,
        commandActor,
        locator(catalogueId, stageId),
      );
      return progress(catalogueId, stage);
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
  authority?: HostedPublicationPreparationAuthority,
) {
  return preparationCommand(
    deps,
    actor,
    catalogueId,
    'seal',
    { stageId },
    context,
    async (tx, _time, commandActor) => {
      const stageLocator = locator(catalogueId, stageId);
      const currentStage = await readHostedPublicationStagingProgress(tx as AccessClient, commandActor, stageLocator);
      const stale = await stopOnChangedSource(tx, commandActor, catalogueId, currentStage);
      if (stale) return progress(catalogueId, stale);
      const source = await sealHostedPublicationStaging(tx as AccessClient, commandActor, stageLocator);
      const candidate = await beginHostedVersionReleaseCandidate(tx, commandActor, source.seal);
      let checkpoint = candidate.checkpoint;
      if (checkpoint.coverageComplete && !checkpoint.sealed) {
        const sealed = await sealHostedVersionReleaseCandidate(tx, commandActor, candidate.checkpoint.sourceSeal);
        checkpoint = {
          ...checkpoint,
          placementCount: sealed.candidate.coverage.placementCount,
          rootCount: sealed.candidate.coverage.rootCount,
          chapterCount: sealed.candidate.coverage.chapterCount,
          sealed: true,
        };
      }
      const stage = await readHostedPublicationStagingProgress(tx as AccessClient, commandActor, stageLocator);
      return progress(catalogueId, stage, candidateProgress(checkpoint));
    },
    { stageId, allowMissing: false },
    authority,
  );
}
