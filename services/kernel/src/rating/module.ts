import type { Pool } from 'pg';
import type { Access } from '../request/access.ts';
import type { WorkModule } from '../work/registry.ts';
import type { RatingCapabilities } from './contract/capabilities.ts';
import { createNativeRatingCapabilities } from './adapters/native.ts';
import { ratingRoutes, ratingRouteDeclarations } from './routes.ts';
import {
  sourceStatisticRoutes,
  sourceStatisticRouteDeclarations,
  createSourceStatisticCommands,
} from './source-statistics.ts';
import { sourceClassificationRouteDeclarations } from './source-classification-routes.ts';
import { createSourceClassificationProducer } from './source-classification.ts';
import { createRatingWorkModule, ratingWorkDeclarations } from './work-module.ts';
import { createIdentityRatingRepairProducer } from '../semantic/identity-rating-repair-producer.ts';
import { createRatingIdentityRepairCommands } from './identity-repair.ts';
import type { RatingIdentityProducer } from './segment-identity-guard.ts';
import { createVoteCommands } from './votes.ts';
import { createClassificationBallotCommands } from './classification-ballot.ts';
import { createRealmRatingQuestion } from './question-authoring.ts';
import { updateQuestionLabel } from './question-label.ts';
import { retireRealmRatingQuestion, restoreRealmRatingQuestion } from './question-lifecycle.ts';
import { readQuestionManagementPage } from './question-management.ts';
import { createOwnVotesReader } from './own-votes-page.ts';
import { createClassificationBallotOwnPageReader } from './classification-ballot-own-page.ts';
import { readAggregateFigure, readRatingPopulationPage } from './aggregate-read.ts';
import { readSubjectPublicFigure } from './public-figure-http.ts';
import { createRealmRankSource, createRealmRankOrderSource } from './realm-rank.ts';
import { RATING_EVENTS } from './events.ts';

export { createNativeRatingCapabilities } from './adapters/native.ts';
export type { RatingCapabilities, RatingAmbient } from './contract/capabilities.ts';

export type RatingHttpApp = ReturnType<typeof ratingRoutes> & ReturnType<typeof sourceStatisticRoutes>;

type HttpDependencies = Omit<Parameters<typeof ratingRoutes>[1], 'pool' | 'capabilities'>;
type ApplicationDependencies = Omit<HttpDependencies, 'access'> & { access: Access };

/** One declaration supplies the native HTTP, event, permission and durable-work inventories. */
export function createRatingDefinition() {
  const routes = {
    native: ratingRouteDeclarations(),
    classifications: sourceClassificationRouteDeclarations(),
    providers: sourceStatisticRouteDeclarations(),
  };
  const http = [
    ...Object.values(routes.classifications),
    ...Object.values(routes.native),
    ...Object.values(routes.providers),
  ];
  return {
    name: 'rating' as const,
    routes,
    http,
    events: RATING_EVENTS(),
    permissions: [...new Set(http.map((route) => route.options.detail['x-action']))],
    work: ratingWorkDeclarations(),
  };
}
export type RatingDefinition = ReturnType<typeof createRatingDefinition>;

/** The host lends its resources. Construction opens no connection and starts no process or service. */
export function createRatingModule(options: {
  pool: Pool;
  capabilities: RatingCapabilities;
  definition?: RatingDefinition;
  producer?: RatingIdentityProducer;
}) {
  const { pool, capabilities } = options;
  const definition = options.definition ?? createRatingDefinition();
  const dependencies = (config: ApplicationDependencies) => ({
    ...config,
    pool,
    capabilities,
    clock: capabilities.clock,
  });
  return {
    definition,
    capabilities,
    /** Handler adapters consume the exact declarations that composition inspected. */
    mount(app: Parameters<typeof ratingRoutes>[0], config: HttpDependencies) {
      const supplied = { ...config, pool, capabilities, clock: capabilities.clock };
      const native = ratingRoutes(app, supplied, definition.routes.native, definition.routes.classifications);
      return sourceStatisticRoutes(
        native as unknown as Parameters<typeof sourceStatisticRoutes>[0],
        supplied,
        definition.routes.providers,
      ) as RatingHttpApp;
    },
    /** Commands share the same supplied effects as their HTTP and durable adapters. */
    application(config: ApplicationDependencies) {
      const supplied = dependencies(config);
      return {
        votes: createVoteCommands(supplied),
        identityRepair: createRatingIdentityRepairCommands({
          ...supplied,
          producer: options.producer ?? createIdentityRatingRepairProducer(),
        }),
        classifications: createClassificationBallotCommands(supplied),
        providers: createSourceStatisticCommands(supplied),
        sourceClassifications: createSourceClassificationProducer(supplied),
        ownVotes: createOwnVotesReader(supplied),
        ownClassifications: createClassificationBallotOwnPageReader(supplied),
        realmRanks: createRealmRankSource(supplied),
        realmRankOrder: createRealmRankOrderSource(supplied),
        createQuestion: (...args: Tail<Parameters<typeof createRealmRatingQuestion>>) =>
          createRealmRatingQuestion(supplied, ...args),
        updateQuestionLabel: (...args: Tail<Parameters<typeof updateQuestionLabel>>) =>
          updateQuestionLabel(supplied, ...args),
        retireQuestion: (...args: Tail<Parameters<typeof retireRealmRatingQuestion>>) =>
          retireRealmRatingQuestion(supplied, ...args),
        restoreQuestion: (...args: Tail<Parameters<typeof restoreRealmRatingQuestion>>) =>
          restoreRealmRatingQuestion(supplied, ...args),
        questionManagement: (...args: Tail<Parameters<typeof readQuestionManagementPage>>) =>
          readQuestionManagementPage(supplied, ...args),
        aggregate: (input: Parameters<typeof readAggregateFigure>[1]) => readAggregateFigure(pool, input),
        populations: (input: Parameters<typeof readRatingPopulationPage>[1]) => readRatingPopulationPage(pool, input),
        figure: (subjectId: string, deadline: number) => readSubjectPublicFigure(pool, subjectId, deadline),
      };
    },
    work(counter?: Parameters<typeof createRatingWorkModule>[0]): WorkModule {
      return createRatingWorkModule(counter, capabilities, definition.work);
    },
  };
}

type Tail<Items extends unknown[]> = Items extends [unknown, ...infer Rest] ? Rest : never;

/** Native workers defer construction until the work host lends its clock, environment and resource lifetime. */
export const ratingNativeWorkModule: WorkModule = {
  name: 'rating',
  register(context) {
    return createRatingModule({
      pool: context.pool,
      capabilities: createNativeRatingCapabilities({ clock: context.clock }),
    })
      .work()
      .register(context);
  },
};
