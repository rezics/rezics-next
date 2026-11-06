import { createRatingCounter, type RatingCounter } from '../access/rating-counter.ts';
import type { WorkContext, WorkModule, WorkService } from '../work/registry.ts';
import type { Effect } from '../events/effects.ts';
import type { RatingCapabilities } from './contract/capabilities.ts';
import { createNativeRatingCapabilities } from './adapters/native.ts';
import { createRatingAggregateEffect } from './aggregate-effect.ts';
import { createClassificationBallotRelay } from './classification-ballot-projector.ts';
import { createVoterEligibilityEffect } from './eligibility.ts';
import { createPopulationTotalEffect } from './population-total.ts';
import { createPublicFigureDrainEffect, resumeRealmRankPublication } from './public-figure.ts';
import { registerRatingSegmentWork, createRatingSegmentJobEffect, RATING_SEGMENT_WORKFLOW } from './segment-job.ts';
import { createVoterRealmsEffect } from './voter-realms.ts';
import {
  registerRatingSubjectMergeWork,
  createRatingSubjectMergeJobEffect,
  RATING_SUBJECT_MERGE_WORKFLOW,
} from './merge-job.ts';
import { startRelays } from '../events/relays.ts';

export { createRatingIdentityRepairCommands } from './identity-repair.ts';
export { createIdentityRepairRead } from './identity-repair-read.ts';
export {
  admitIdentityRepairGeneration,
  continueIdentityRepairGeneration,
  runIdentityRepairGeneration,
} from './identity-repair-run.ts';
export {
  createInstalledIdentityRepairCommands,
  createNativeIdentityRepairHost,
} from './adapters/identity-repair.ts';
export const RATING_COUNTER_SECRET_ENV = 'KERNEL_RATING_COUNTER_SECRET';

type Runtime = Readonly<{ context: WorkContext; counter: RatingCounter; capabilities: RatingCapabilities }>;
type EffectDeclaration = Readonly<{ name: string; requiresClient?: boolean; create(runtime: Runtime): Effect }>;
type WorkflowDeclaration = Readonly<{ name: string; register(runtime: Runtime): void }>;
type ServiceDeclaration = Readonly<{ name: string; start(runtime: Runtime): WorkService | Promise<WorkService> }>;

/** Descriptions and factories are collected before the work host starts any service. */
export function ratingWorkDeclarations() {
  const effects: readonly EffectDeclaration[] = [
    {
      name: 'rating_aggregate',
      create: ({ context, counter, capabilities }) => createRatingAggregateEffect(context.pool, counter, capabilities),
    },
    {
      name: 'rating_population_total',
      create: ({ context, capabilities }) => createPopulationTotalEffect(context.pool, capabilities),
    },
    {
      name: 'rating_public_figure',
      create: ({ context, capabilities }) => createPublicFigureDrainEffect(context.pool, capabilities),
    },
    {
      name: 'rating_voter_realms',
      create: ({ context, capabilities }) => createVoterRealmsEffect(context.pool, capabilities),
    },
    {
      name: 'rating_voter_eligibility',
      create: ({ context, capabilities }) => createVoterEligibilityEffect(context.pool, capabilities),
    },
    {
      name: 'rating_segment_job',
      requiresClient: true,
      create: ({ context, capabilities }) => createRatingSegmentJobEffect(context.pool, context.client, capabilities),
    },
    {
      name: 'rating_subject_merge_job',
      requiresClient: true,
      create: ({ context }) => createRatingSubjectMergeJobEffect(context.pool, context.client),
    },
  ];
  return {
    effects,
    workflows: [
      {
        name: RATING_SEGMENT_WORKFLOW,
        register: ({ context, counter, capabilities }) =>
          registerRatingSegmentWork(context, counter, capabilities, false),
      },
      {
        name: RATING_SUBJECT_MERGE_WORKFLOW,
        register: ({ context, capabilities }) => registerRatingSubjectMergeWork(context, capabilities, false),
      },
    ] satisfies readonly WorkflowDeclaration[],
    services: [
      {
        name: 'rating.realm-rank-publication',
        async start({ context, capabilities }) {
          await resumeRealmRankPublication(context.pool, capabilities);
          return { async stop() {} };
        },
      },
      {
        name: 'rating.classification-ballot-relay',
        start: ({ context, capabilities }) =>
          startRelays(context.pool, [createClassificationBallotRelay(context.pool, capabilities.clock, capabilities)]),
      },
    ] satisfies readonly ServiceDeclaration[],
  };
}

function counterSecret(value: string | undefined): Uint8Array {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error(`${RATING_COUNTER_SECRET_ENV} must be configured as base64url`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value || decoded.byteLength < 32)
    throw new Error(`${RATING_COUNTER_SECRET_ENV} must contain at least 32 bytes`);
  return new Uint8Array(decoded);
}

/** Pools, clients and process shutdown belong to the host. It starts and reverses our declared services. */
export function createRatingWorkModule(
  ratingCounter?: RatingCounter,
  capabilities?: RatingCapabilities,
  declarations = ratingWorkDeclarations(),
): WorkModule {
  return {
    name: 'rating',
    register(context) {
      const runtime: Runtime = {
        context,
        counter:
          ratingCounter ?? createRatingCounter({ secret: counterSecret(context.env[RATING_COUNTER_SECRET_ENV]) }),
        capabilities: capabilities ?? createNativeRatingCapabilities({ clock: context.clock }),
      };
      context.addEffects(
        declarations.effects
          .filter((declaration) => !declaration.requiresClient || context.client)
          .map((declaration) => declaration.create(runtime)),
      );
      // Direct adapter callers may collect only effects. Native composition supplies the work client.
      if (context.client) {
        for (const workflow of declarations.workflows) workflow.register(runtime);
        for (const service of declarations.services) context.addService(() => service.start(runtime));
      }
    },
  };
}

/** Compatibility registration is inert until its host supplies the runtime. */
export const ratingWorkModule: WorkModule = {
  name: 'rating',
  register: (context) => createRatingWorkModule().register(context),
};
