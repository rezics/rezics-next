import type { Actor } from '../request/access.ts';
import {
  noEffect,
  preflightCommandReceipt,
  principalCommandIdentity,
  runCommand,
  type CommandAuthorization,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import { ContentNotFoundError, hostedPostAuthorization, RevisionPreconditionError } from './commands.ts';
import { snapshot } from './reads.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import {
  captureHostedPublicBaselineInput,
  hostedPublicBaselineActorBinding,
  readHostedPublicBaselineInputPage,
} from './hosted-public-baseline-input.ts';
import type {
  HostedPublicBaselineCaptureResult,
  HostedPublicBaselineFrontier,
  HostedPublicBaselineSource,
} from './hosted-public-baseline-input-model.ts';
import {
  HostedPublicBaselineInputIncompleteError,
  HostedPublicBaselineInputUnavailableError,
  InvalidHostedPublicBaselineInputError,
} from './hosted-public-baseline-input-model.ts';
import {
  HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX,
  applyHostedPublicBaselineBuildPage,
  beginHostedPublicBaselineBuild,
  sealHostedPublicBaselineBuild,
  type HostedPublicBaselineBuildState,
} from './hosted-public-baseline-build.ts';
import { HostedVersionBuilderError } from './hosted-version-builder-model.ts';
import {
  applyHostedVersionPublicBaselinePage,
  beginHostedVersionPublicBaseline,
  completeHostedVersionPublicBaseline,
  HostedVersionPublicBaselineError,
} from './hosted-version-public-baseline.ts';
import type { HostedVersionPublicBaselineCursor } from './hosted-version-public-baseline-model.ts';
import type { HostedCommandContext } from './hosted-chapters-model.ts';

type HostedLegacyPublicBaselineCommon = Readonly<{
  expectedRevisionId: string;
  expectedPublicationId: string;
}>;

export type HostedLegacyPublicBaselineInput = HostedLegacyPublicBaselineCommon &
  (
    | Readonly<{ step: 'startBuild' }>
    | Readonly<{ step: 'build'; frontier: HostedPublicBaselineFrontier }>
    | Readonly<{ step: 'seal'; frontier: HostedPublicBaselineFrontier }>
    | Readonly<{ step: 'receive'; frontier: HostedPublicBaselineFrontier }>
    | Readonly<{ step: 'apply'; cursor: HostedVersionPublicBaselineCursor }>
    | Readonly<{ step: 'complete' }>
  );

export type HostedLegacyPublicBaselineProgress = Readonly<{
  catalogueId: string;
  sourcePublicationId: string;
  expectedPlacementCount: number;
  nextStep: 'build' | 'seal' | 'receive' | 'apply' | 'complete' | 'done';
  buildFrontier: HostedPublicBaselineFrontier | null;
  sealFromFrontier: HostedPublicBaselineFrontier | null;
  receivingCursor: HostedVersionPublicBaselineCursor | null;
}>;

const ADVANCE_KIND = 'content.hosted-catalogue.public-baseline.advance';
const BUILD_STATE_KIND = 'content.hosted-catalogue.public-baseline.build-state';

type Catalogue = NonNullable<Awaited<ReturnType<typeof hostedCatalogue>>>;
type RequestActor = Extract<Actor, { kind: 'account' }>;

function requireAccount(actor: Actor): asserts actor is RequestActor {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
}

function progress(
  catalogueId: string,
  sourcePublicationId: string,
  expectedPlacementCount: number,
  nextStep: HostedLegacyPublicBaselineProgress['nextStep'],
  buildFrontier: HostedPublicBaselineFrontier | null = null,
  sealFromFrontier: HostedPublicBaselineFrontier | null = null,
  receivingCursor: HostedVersionPublicBaselineCursor | null = null,
): HostedLegacyPublicBaselineProgress {
  return {
    catalogueId,
    sourcePublicationId,
    expectedPlacementCount,
    nextStep,
    buildFrontier,
    sealFromFrontier,
    receivingCursor,
  };
}

function receipt(
  kind: string,
  actor: RequestActor,
  catalogueId: string,
  input: unknown,
  context: HostedCommandContext,
) {
  return { kind, key: context.idempotencyKey, digest: requestDigest(kind, actor, { catalogueId, input }) };
}

function commandAuthorization(
  dependencies: HostedCommandDependencies,
  actor: RequestActor,
  catalogueId: string,
  threadId: string,
  context: HostedCommandContext,
  commandReceipt: ReturnType<typeof receipt>,
): CommandAuthorization {
  return hostedPostAuthorization(dependencies, actor, threadId, catalogueId, context, commandReceipt);
}

function assertExpected(
  current: Catalogue | null,
  threadId: string,
  catalogueId: string,
  input: HostedLegacyPublicBaselineCommon,
) {
  if (!current || current.thread_id !== threadId) throw new ContentNotFoundError();
  if (current.head_revision_id !== input.expectedRevisionId || current.publication_id !== input.expectedPublicationId)
    throw new RevisionPreconditionError();
  if (
    routeOf(input.expectedRevisionId) !== routeOf(catalogueId) ||
    routeOf(input.expectedPublicationId) !== routeOf(catalogueId)
  )
    throw new RevisionPreconditionError();
}

async function captureSource(
  dependencies: HostedCommandDependencies,
  actor: RequestActor,
  catalogueId: string,
  input: HostedLegacyPublicBaselineCommon,
  context: HostedCommandContext,
): Promise<HostedPublicBaselineCaptureResult> {
  const result = await captureHostedPublicBaselineInput(
    dependencies,
    actor,
    { catalogueId, expectedPublicationId: input.expectedPublicationId },
    context,
  );
  return result.value;
}

async function buildState(
  dependencies: HostedCommandDependencies,
  actor: RequestActor,
  catalogueId: string,
  threadId: string,
  input: HostedLegacyPublicBaselineCommon,
  context: HostedCommandContext,
  capture: HostedPublicBaselineCaptureResult,
): Promise<HostedPublicBaselineBuildState> {
  const commandReceipt = receipt(BUILD_STATE_KIND, actor, catalogueId, input, context);
  const authorization = commandAuthorization(dependencies, actor, catalogueId, threadId, context, commandReceipt);
  const outcome = await runCommand<HostedPublicBaselineBuildState>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(capture.source.route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt: commandReceipt,
      authorization,
    },
    async (tx) => {
      assertExpected(await hostedCatalogue(tx, catalogueId, true), threadId, catalogueId, input);
      const source = await tx.query<{ input_id: string }>(
        `SELECT input_id FROM content.hosted_version_builder_source
         WHERE route=$1 AND catalogue_id=$2 AND source_kind='public' AND publication_id=$3 AND actor_binding=$4`,
        [
          capture.source.route,
          catalogueId,
          capture.source.publicationId,
          Buffer.from(capture.source.actorBinding, 'hex'),
        ],
      );
      if (!source.rows[0]) throw new RevisionPreconditionError();
      return noEffect(await beginHostedPublicBaselineBuild(tx, capture));
    },
  );
  return outcome.value;
}

async function sealedFrontier(tx: CommandTransaction, state: HostedPublicBaselineBuildState) {
  const result = await tx.query<{ from_after_ordinal: string }>(
    `SELECT from_after_ordinal::text
     FROM content.hosted_version_builder_page
     WHERE route=$1 AND catalogue_id=$2 AND input_id=$3 AND coverage_complete=true`,
    [state.source.route, state.source.catalogueId, state.buildId],
  );
  const ordinal = result.rows[0]?.from_after_ordinal;
  if (ordinal === undefined) throw new RevisionPreconditionError();
  return { afterOrdinal: Number(ordinal) };
}

async function sourcePage(
  dependencies: HostedCommandDependencies,
  actor: RequestActor,
  source: HostedPublicBaselineSource,
  frontier: HostedPublicBaselineFrontier,
  context: HostedCommandContext,
) {
  return readHostedPublicBaselineInputPage(
    dependencies,
    actor,
    source,
    { frontier, limit: HOSTED_PUBLIC_BASELINE_BUILD_PAGE_MAX },
    context,
  );
}

async function baselineBuildId(
  tx: CommandTransaction,
  catalogueId: string,
  publicationId: string,
  actor: RequestActor,
): Promise<string> {
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  const result = await tx.query<{ build_id: string }>(
    `SELECT build_id
     FROM content.hosted_version_public_baseline
     WHERE route=$1 AND catalogue_id=$2 AND source_publication_id=$3 AND actor_binding=$4`,
    [route, catalogueId, publicationId, Buffer.from(hostedPublicBaselineActorBinding(actor), 'hex')],
  );
  const buildId = result.rows[0]?.build_id;
  if (!buildId) throw new RevisionPreconditionError();
  return buildId;
}

function mapPrecondition(error: unknown): never {
  if (error instanceof RevisionPreconditionError || error instanceof ContentNotFoundError) throw error;
  if (error instanceof HostedPublicBaselineInputUnavailableError) throw new ContentNotFoundError();
  if (
    error instanceof HostedPublicBaselineInputIncompleteError ||
    error instanceof InvalidHostedPublicBaselineInputError
  )
    throw new RevisionPreconditionError();
  if (error instanceof HostedVersionBuilderError && error.code !== 'invalid-tree')
    throw new RevisionPreconditionError();
  if (error instanceof HostedVersionPublicBaselineError && error.code !== 'invalid-tree')
    throw new RevisionPreconditionError();
  throw error;
}

/** Advance one bounded legacy-publication preparation page or lifecycle transition. */
export async function advanceHostedLegacyPublicBaseline(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedLegacyPublicBaselineInput,
  context: HostedCommandContext,
) {
  requireAccount(actor);
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();

  const initial = (await snapshot(dependencies, catalogueId, context, (client) => hostedCatalogue(client, catalogueId)))
    .value;
  if (!initial) throw new ContentNotFoundError();

  const commandReceipt = receipt(ADVANCE_KIND, actor, catalogueId, input, context);
  const authorization = commandAuthorization(
    dependencies,
    actor,
    catalogueId,
    initial.thread_id,
    context,
    commandReceipt,
  );
  const options = {
    ...principalCommandIdentity(actor),
    partition: partitionOf(route),
    deadline: context.deadline,
    clock: dependencies.clock,
    receipt: commandReceipt,
    authorization,
  };

  const replay = await preflightCommandReceipt<HostedLegacyPublicBaselineProgress>(dependencies.pool, options);
  if (replay) return replay;

  try {
    assertExpected(initial, initial.thread_id, catalogueId, input);

    const run = <T>(body: (tx: CommandTransaction) => Promise<T>) =>
      runCommand<T>(dependencies.pool, options, async (tx) => {
        assertExpected(await hostedCatalogue(tx, catalogueId, true), initial.thread_id, catalogueId, input);
        return noEffect(await body(tx));
      });

    if (input.step === 'startBuild') {
      const capture = await captureSource(dependencies, actor, catalogueId, input, context);
      return run(async (tx) => {
        const state = await beginHostedPublicBaselineBuild(tx, capture);
        if (!state.coverageComplete)
          return progress(
            catalogueId,
            state.source.publicationId,
            state.source.expectedPlacementCount,
            'build',
            state.frontier,
          );
        const fromFrontier = await sealedFrontier(tx, state);
        return progress(
          catalogueId,
          state.source.publicationId,
          state.source.expectedPlacementCount,
          state.sealed ? 'receive' : 'seal',
          state.frontier,
          fromFrontier,
        );
      });
    }

    if (input.step === 'build' || input.step === 'seal' || input.step === 'receive') {
      const capture = await captureSource(dependencies, actor, catalogueId, input, context);
      const state = await buildState(dependencies, actor, catalogueId, initial.thread_id, input, context, capture);

      if (input.step === 'build') {
        if (state.sealed || state.frontier.afterOrdinal !== input.frontier.afterOrdinal)
          throw new RevisionPreconditionError();
        const result = await sourcePage(dependencies, actor, state.source, input.frontier, context);
        const page = { buildId: state.buildId, fromFrontier: input.frontier, result };
        return run(async (tx) => {
          const applied = await applyHostedPublicBaselineBuildPage(tx, page);
          return progress(
            catalogueId,
            state.source.publicationId,
            state.source.expectedPlacementCount,
            result.coverage.complete ? 'seal' : 'build',
            applied.state.frontier,
            result.coverage.complete ? input.frontier : null,
          );
        });
      }

      if (input.step === 'seal') {
        if (state.frontier.afterOrdinal !== state.source.expectedPlacementCount - 1)
          throw new RevisionPreconditionError();
        const result = await sourcePage(dependencies, actor, state.source, input.frontier, context);
        const page = { buildId: state.buildId, fromFrontier: input.frontier, result };
        return run(async (tx) => {
          const facts = await sealHostedPublicBaselineBuild(tx, page);
          return progress(
            catalogueId,
            facts.source.publicationId,
            facts.source.expectedPlacementCount,
            'receive',
            { afterOrdinal: facts.source.expectedPlacementCount - 1 },
            input.frontier,
          );
        });
      }

      if (!state.sealed || state.frontier.afterOrdinal !== state.source.expectedPlacementCount - 1)
        throw new RevisionPreconditionError();
      const result = await sourcePage(dependencies, actor, state.source, input.frontier, context);
      const page = { buildId: state.buildId, fromFrontier: input.frontier, result };
      return run(async (tx) => {
        const facts = await sealHostedPublicBaselineBuild(tx, page);
        const receiving = await beginHostedVersionPublicBaseline(tx, facts);
        return progress(
          catalogueId,
          receiving.sourcePublicationId,
          Number(receiving.placementCount),
          'apply',
          null,
          null,
          receiving.cursor,
        );
      });
    }

    if (input.step === 'apply') {
      return run(async (tx) => {
        const buildId = await baselineBuildId(tx, catalogueId, input.expectedPublicationId, actor);
        const applied = await applyHostedVersionPublicBaselinePage(tx, catalogueId, buildId, input.cursor);
        return progress(
          catalogueId,
          input.expectedPublicationId,
          Number(applied.state.placementCount),
          applied.state.status === 'complete' ? 'complete' : 'apply',
          null,
          null,
          applied.state.cursor,
        );
      });
    }

    const completed = await run(async (tx) => {
      const buildId = await baselineBuildId(tx, catalogueId, input.expectedPublicationId, actor);
      const baseline = await completeHostedVersionPublicBaseline(tx, catalogueId, buildId);
      return progress(catalogueId, baseline.sourcePublicationId, Number(baseline.snapshot.placementCount), 'done');
    });
    return completed;
  } catch (error) {
    mapPrecondition(error);
  }
}

/** Bind the completed receiver candidate to the exact author and retained publication in the point transaction. */
export async function completedHostedLegacyPublicBaseline(
  tx: CommandTransaction,
  actor: Actor,
  catalogueId: string,
  publicationId: string,
) {
  requireAccount(actor);
  const route = routeOf(catalogueId);
  if (route === null) throw new ContentNotFoundError();
  const result = await tx.query<{ build_id: string }>(
    `SELECT build_id
     FROM content.hosted_version_public_baseline
     WHERE route=$1 AND catalogue_id=$2 AND source_publication_id=$3 AND actor_binding=$4
       AND status='complete' AND coverage_complete=true
     FOR SHARE`,
    [route, catalogueId, publicationId, Buffer.from(hostedPublicBaselineActorBinding(actor), 'hex')],
  );
  const buildId = result.rows[0]?.build_id;
  if (!buildId) return null;
  try {
    return await completeHostedVersionPublicBaseline(tx, catalogueId, buildId);
  } catch (error) {
    if (
      error instanceof HostedVersionPublicBaselineError &&
      ['source-mismatch', 'stale-source', 'incomplete-source', 'stale-frontier'].includes(error.code)
    )
      throw new RevisionPreconditionError();
    throw error;
  }
}
