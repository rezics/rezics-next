import type { Actor } from '../request/access.ts';
import {
  authoritativeTimeValue,
  noEffect,
  principalCommandIdentity,
  runCommand,
  type AuthoritativeTime,
  type CommandOutcome,
  type CommandTransaction,
} from '../command/command.ts';
import { requestDigest } from '../command/request.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { ContentNotFoundError, hostedPostAuthorization, RevisionPreconditionError } from './commands.ts';
import type { HostedCommandDependencies } from './hosted-chapters-commands.ts';
import { hostedCatalogue } from './hosted-chapters-store.ts';
import type { HostedCommandContext } from './hosted-chapters-model.ts';
import { snapshot } from './reads.ts';
import { advanceHostedMigrationInput, captureHostedMigrationInput } from './hosted-migration-input.ts';
import {
  HostedMigrationInputIncompleteError,
  HostedMigrationInputUnavailableError,
  InvalidHostedMigrationInputError,
  type HostedMigrationFrontier,
  type HostedMigrationInputCaptureResult,
  type HostedMigrationInputStatus,
} from './hosted-migration-input-model.ts';
import {
  HOSTED_VERSION_BUILDER_PAGE_MAX,
  applyHostedVersionBuilderPage,
  beginHostedVersionBuilder,
  sealHostedVersionBuilder,
} from './hosted-version-builder.ts';
import { type HostedVersionBuilderPage, type HostedVersionBuilderState } from './hosted-version-builder-model.ts';
import {
  beginHostedVersionDraftActivationCommand,
  commitHostedVersionDraftActivationCommand,
  pageHostedVersionDraftActivationCommand,
  type HostedVersionDraftActivationPageResult,
} from './hosted-version-draft-activation.ts';

export type HostedDraftConversionInput =
  | Readonly<{ step: 'capture'; expectedRevisionId: string }>
  | Readonly<{ step: 'begin'; inputId: string; expectedRevisionId: string }>
  | Readonly<{
      step: 'page';
      inputId: string;
      expectedRevisionId: string;
      cursor: HostedMigrationFrontier;
    }>
  | Readonly<{ step: 'seal'; inputId: string; expectedRevisionId: string }>
  | Readonly<{ step: 'materialize'; inputId: string; expectedRevisionId: string }>
  | Readonly<{ step: 'materializePage'; inputId: string; expectedRevisionId: string }>
  | Readonly<{ step: 'commit'; inputId: string; expectedRevisionId: string }>;

export type HostedDraftConversionProgress = Readonly<{
  catalogueId: string;
  inputId: string;
  phase: 'captured' | 'building' | 'sealed' | 'materializing' | 'ready-to-activate' | 'complete';
  nextStep: 'begin' | 'page' | 'seal' | 'materialize' | 'materializePage' | 'commit' | 'complete';
  frontier?: HostedMigrationFrontier;
  coverage?: Readonly<{ visited: string; expected: string; complete: boolean }>;
  revisionId?: string;
}>;

const BUILDER_BEGIN_KIND = 'content.hosted-catalogue.draft-conversion.builder.begin';
const BUILDER_PAGE_KIND = 'content.hosted-catalogue.draft-conversion.builder.page';
const BUILDER_SEAL_KIND = 'content.hosted-catalogue.draft-conversion.builder.seal';

type InputRow = Readonly<{
  route: number;
  catalogue_id: string;
  input_id: string;
  owner_account_id: string;
  source_revision_id: string;
  source_kind: 'snapshot' | 'prefix';
  base_revision_id: string;
  base_placement_count: string;
  base_root_count: string;
  source_high_water: string;
  expected_placement_count: string;
  frontier_segment: 'base' | 'prefix' | 'complete';
  after_ordinal: string;
  after_offset: string;
  raw_visited: string;
  coverage_complete: boolean;
  state: HostedMigrationInputStatus;
  expires_at: Date | string;
}>;

type ConversionBindingRow = Readonly<{
  owner_account_id: string;
  source_revision_id: string;
  head_revision_id: string;
  builder_source_revision_id: string | null;
  activation_expected_revision_id: string | null;
}>;

type RecordedCommand = CommandOutcome<unknown>;

export type HostedDraftConversionCommandResult = Readonly<{
  progress: HostedDraftConversionProgress;
  commands: readonly RecordedCommand[];
}>;

function requireAccount(actor: Actor): asserts actor is Extract<Actor, { kind: 'account' }> {
  if (actor.kind !== 'account') throw new ContentNotFoundError();
}

function requireRouteIdentity(catalogueId: string, expectedRevisionId: string, inputId?: string): number {
  const route = routeOf(catalogueId);
  if (
    route === null ||
    routeOf(expectedRevisionId) !== route ||
    (inputId !== undefined && routeOf(inputId) !== route)
  ) {
    throw new InvalidHostedMigrationInputError('Hosted draft conversion identities use different routes');
  }
  return route;
}

function inputFrontier(row: InputRow): HostedMigrationFrontier {
  if (row.frontier_segment === 'complete') return { segment: 'complete' };
  if (row.frontier_segment === 'prefix') return { segment: 'prefix', afterOffset: row.after_offset };
  return { segment: 'base', afterOrdinal: Number(row.after_ordinal) };
}

function captureFromInput(row: InputRow): HostedMigrationInputCaptureResult {
  return {
    inputId: row.input_id,
    source: {
      catalogueId: row.catalogue_id,
      revisionId: row.source_revision_id,
      kind: row.source_kind,
      baseRevisionId: row.base_revision_id,
      basePlacementCount: row.base_placement_count,
      baseRootCount: row.base_root_count,
      highWater: row.source_high_water,
      expectedPlacementCount: row.expected_placement_count,
    },
    frontier: inputFrontier(row),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : new Date(row.expires_at).toISOString(),
  };
}

async function readInputForBuilder(
  tx: CommandTransaction,
  actor: Extract<Actor, { kind: 'account' }>,
  catalogueId: string,
  inputId: string,
  expectedRevisionId: string,
  time: AuthoritativeTime,
): Promise<InputRow> {
  const route = requireRouteIdentity(catalogueId, expectedRevisionId, inputId);
  const row = (
    await tx.query<InputRow>(
      `SELECT route,catalogue_id,input_id,owner_account_id,source_revision_id,source_kind,
              base_revision_id,base_placement_count::text,base_root_count::text,source_high_water::text,
              expected_placement_count::text,frontier_segment,after_ordinal::text,after_offset::text,
              raw_visited::text,coverage_complete,state,expires_at
       FROM content.hosted_migration_input
       WHERE route=$1 AND catalogue_id=$2 AND input_id=$3
       FOR UPDATE`,
      [route, catalogueId, inputId],
    )
  ).rows[0];
  if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
  if (row.source_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();
  if (row.state === 'cancelled' || row.state === 'expired' || row.state === 'source_erased') {
    throw new HostedMigrationInputUnavailableError();
  }
  if (row.state === 'incomplete') throw new HostedMigrationInputIncompleteError();
  if (row.state !== 'open' && row.state !== 'complete' && row.state !== 'consumed') {
    throw new HostedMigrationInputUnavailableError();
  }
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.getTime() : Date.parse(row.expires_at);
  if (row.state !== 'consumed' && expiresAt <= Date.parse(authoritativeTimeValue(time))) {
    throw new HostedMigrationInputUnavailableError();
  }
  return row;
}

/** The page cursor is only a replay precondition; ownership and source identity come from retained native rows. */
async function readConversionBinding(
  dependencies: HostedCommandDependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  catalogueId: string,
  inputId: string,
  expectedRevisionId: string,
  context: HostedCommandContext,
): Promise<ConversionBindingRow> {
  const route = requireRouteIdentity(catalogueId, expectedRevisionId, inputId);
  const observed = await snapshot(
    dependencies,
    catalogueId,
    context,
    async (client) =>
      (
        await client.query<ConversionBindingRow>(
          `SELECT i.owner_account_id,i.source_revision_id,c.head_revision_id,
                b.source_revision_id AS builder_source_revision_id,
                a.expected_revision_id AS activation_expected_revision_id
         FROM content.hosted_catalogue c
         JOIN content.hosted_migration_input i
           ON i.route=c.route AND i.catalogue_id=c.catalogue_id
         LEFT JOIN content.hosted_version_builder b
           ON b.route=i.route AND b.catalogue_id=i.catalogue_id AND b.input_id=i.input_id
         LEFT JOIN content.hosted_version_draft_activation a
           ON a.route=i.route AND a.catalogue_id=i.catalogue_id AND a.input_id=i.input_id
         WHERE c.route=$1 AND c.catalogue_id=$2 AND i.input_id=$3`,
          [route, catalogueId, inputId],
        )
      ).rows[0] ?? null,
  );
  const row = observed.value;
  if (!row || row.owner_account_id !== actor.accountId) throw new ContentNotFoundError();
  if (row.source_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();
  return row;
}

async function runBuilderCommand<T>(
  dependencies: HostedCommandDependencies,
  actor: Extract<Actor, { kind: 'account' }>,
  catalogueId: string,
  expectedRevisionId: string,
  context: HostedCommandContext,
  kind: string,
  receiptInput: unknown,
  body: (tx: CommandTransaction, time: AuthoritativeTime) => Promise<T>,
): Promise<CommandOutcome<T>> {
  const route = requireRouteIdentity(catalogueId, expectedRevisionId);
  const receipt = {
    kind,
    key: context.idempotencyKey,
    digest: requestDigest(kind, actor, receiptInput),
  };
  const observed = await snapshot(dependencies, catalogueId, context, (client) => hostedCatalogue(client, catalogueId));
  if (!observed.value || routeOf(observed.value.thread_id) !== route) throw new ContentNotFoundError();
  const authorization = hostedPostAuthorization(
    dependencies,
    actor,
    observed.value.thread_id,
    catalogueId,
    context,
    receipt,
  );
  return runCommand<T>(
    dependencies.pool,
    {
      ...principalCommandIdentity(actor),
      partition: partitionOf(route),
      deadline: context.deadline,
      clock: dependencies.clock,
      receipt,
      authorization,
    },
    async (tx, { time }) => {
      const current = await hostedCatalogue(tx, catalogueId, true);
      if (!current || current.thread_id !== observed.value!.thread_id) throw new ContentNotFoundError();
      if (current.head_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();
      return noEffect(await body(tx, time));
    },
  );
}

function builderCoverage(state: HostedVersionBuilderState, visited: string) {
  return {
    visited,
    expected: state.identity.expectedPlacementCount,
    complete: state.coverageComplete,
  } as const;
}

function activationProgress(
  catalogueId: string,
  inputId: string,
  result: HostedVersionDraftActivationPageResult,
): HostedDraftConversionProgress {
  const complete = result.state.status === 'complete';
  return {
    catalogueId,
    inputId,
    phase: complete ? 'ready-to-activate' : 'materializing',
    nextStep: complete ? 'commit' : 'materializePage',
  };
}

/** Execute exactly the requested bounded step and return only author progress, never source page items. */
export async function runHostedDraftConversionStep(
  dependencies: HostedCommandDependencies,
  actor: Actor,
  catalogueId: string,
  input: HostedDraftConversionInput,
  context: HostedCommandContext,
): Promise<HostedDraftConversionCommandResult> {
  requireAccount(actor);
  requireRouteIdentity(catalogueId, input.expectedRevisionId, 'inputId' in input ? input.inputId : undefined);

  if (input.step === 'capture') {
    const captured = await captureHostedMigrationInput(
      dependencies,
      actor,
      { catalogueId, expectedRevisionId: input.expectedRevisionId },
      context,
    );
    return {
      progress: {
        catalogueId,
        inputId: captured.value.inputId,
        phase: 'captured',
        nextStep: 'begin',
        frontier: captured.value.frontier,
        coverage: {
          visited: '0',
          expected: captured.value.source.expectedPlacementCount,
          complete: false,
        },
      },
      commands: [captured],
    };
  }

  const inputId = input.inputId;
  const expectedRevisionId = input.expectedRevisionId;

  if (input.step === 'begin') {
    const command = await runBuilderCommand(
      dependencies,
      actor,
      catalogueId,
      expectedRevisionId,
      context,
      BUILDER_BEGIN_KIND,
      { catalogueId, inputId, expectedRevisionId },
      async (tx, time) => {
        const current = await hostedCatalogue(tx, catalogueId, true);
        if (!current || current.head_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();
        const row = await readInputForBuilder(tx, actor, catalogueId, inputId, expectedRevisionId, time);
        const state = await beginHostedVersionBuilder(tx, captureFromInput(row));
        return {
          state,
          visited: row.raw_visited,
        };
      },
    );
    return {
      progress: {
        catalogueId,
        inputId,
        phase: 'building',
        nextStep: command.value.state.coverageComplete ? 'seal' : 'page',
        frontier: command.value.state.frontier,
        coverage: builderCoverage(command.value.state, command.value.visited),
      },
      commands: [command],
    };
  }

  if (input.step === 'page') {
    const binding = await readConversionBinding(dependencies, actor, catalogueId, inputId, expectedRevisionId, context);
    if (binding.builder_source_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();

    const advanced = await advanceHostedMigrationInput(
      dependencies,
      actor,
      catalogueId,
      inputId,
      { frontier: input.cursor, limit: HOSTED_VERSION_BUILDER_PAGE_MAX },
      context,
    );
    if (!advanced.sourceCurrent) throw new RevisionPreconditionError();
    if (advanced.status === 'incomplete') throw new HostedMigrationInputIncompleteError();
    if (advanced.status !== 'open' && advanced.status !== 'complete') {
      throw new HostedMigrationInputUnavailableError();
    }
    const page: HostedVersionBuilderPage = {
      inputId,
      fromFrontier: input.cursor,
      result: advanced,
    };
    const built = await runBuilderCommand(
      dependencies,
      actor,
      catalogueId,
      expectedRevisionId,
      context,
      BUILDER_PAGE_KIND,
      { catalogueId, inputId, expectedRevisionId, fromFrontier: input.cursor },
      (tx) => applyHostedVersionBuilderPage(tx, page),
    );
    const nextStep = advanced.coverage.complete ? 'seal' : 'page';
    return {
      progress: {
        catalogueId,
        inputId,
        phase: 'building',
        nextStep,
        frontier: built.value.state.frontier,
        coverage: {
          visited: advanced.coverage.visited,
          expected: advanced.coverage.expected,
          complete: advanced.coverage.complete,
        },
      },
      commands: [built],
    };
  }

  if (input.step === 'seal') {
    const command = await runBuilderCommand(
      dependencies,
      actor,
      catalogueId,
      expectedRevisionId,
      context,
      BUILDER_SEAL_KIND,
      { catalogueId, inputId, expectedRevisionId },
      async (tx, time) => {
        const row = await readInputForBuilder(tx, actor, catalogueId, inputId, expectedRevisionId, time);
        const capture = captureFromInput(row);
        const state = await beginHostedVersionBuilder(tx, capture);
        const page: HostedVersionBuilderPage = {
          inputId,
          fromFrontier: state.frontier,
          result: {
            inputId,
            status: row.state,
            source: capture.source,
            sourceCurrent: true,
            frontier: capture.frontier,
            coverage: {
              visited: row.raw_visited,
              expected: row.expected_placement_count,
              complete: row.coverage_complete,
            },
            items: [],
          },
        };
        const facts = await sealHostedVersionBuilder(tx, page);
        return {
          expected: facts.source.expectedPlacementCount,
          visited: facts.placementCount.toString(),
        };
      },
    );
    return {
      progress: {
        catalogueId,
        inputId,
        phase: 'sealed',
        nextStep: 'materialize',
        coverage: { visited: command.value.visited, expected: command.value.expected, complete: true },
      },
      commands: [command],
    };
  }

  if (input.step === 'materialize') {
    const binding = await readConversionBinding(dependencies, actor, catalogueId, inputId, expectedRevisionId, context);
    if (binding.builder_source_revision_id !== expectedRevisionId) throw new RevisionPreconditionError();
    const command = await beginHostedVersionDraftActivationCommand(
      dependencies,
      actor,
      { catalogueId, inputId, expectedRevisionId },
      context,
    );
    return {
      progress: {
        catalogueId,
        inputId,
        phase: 'materializing',
        nextStep: 'materializePage',
      },
      commands: [command],
    };
  }

  if (input.step === 'materializePage') {
    const binding = await readConversionBinding(dependencies, actor, catalogueId, inputId, expectedRevisionId, context);
    if (
      binding.builder_source_revision_id !== expectedRevisionId ||
      binding.activation_expected_revision_id !== expectedRevisionId
    ) {
      throw new RevisionPreconditionError();
    }
    const command = await pageHostedVersionDraftActivationCommand(
      dependencies,
      actor,
      { catalogueId, inputId },
      context,
    );
    return {
      progress: activationProgress(catalogueId, inputId, command.value),
      commands: [command],
    };
  }

  if (input.step === 'commit') {
    const binding = await readConversionBinding(dependencies, actor, catalogueId, inputId, expectedRevisionId, context);
    if (
      binding.builder_source_revision_id !== expectedRevisionId ||
      binding.activation_expected_revision_id !== expectedRevisionId
    ) {
      throw new RevisionPreconditionError();
    }
    const command = await commitHostedVersionDraftActivationCommand(
      dependencies,
      actor,
      { catalogueId, inputId, expectedRevisionId },
      context,
    );
    return {
      progress: {
        catalogueId,
        inputId,
        phase: 'complete',
        nextStep: 'complete',
        coverage: {
          visited: command.value.state.source.expectedPlacementCount,
          expected: command.value.state.source.expectedPlacementCount,
          complete: true,
        },
        revisionId: command.value.revisionId,
      },
      commands: [command],
    };
  }

  const exhaustive: never = input;
  throw new TypeError(`Unhandled hosted draft conversion step: ${JSON.stringify(exhaustive)}`);
}
