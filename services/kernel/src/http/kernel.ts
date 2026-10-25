import { randomBytes } from 'node:crypto';
import { createAccess } from '../access/index.ts';
import { accessRoutes } from '../access/routes.ts';
import { systemClock } from '../clock.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { contentRoutes } from '../content/routes.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import type { Access, AccessConfig } from '../request/access.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { subjectRoutes } from '../semantic/http/subjects.ts';
import { createApp } from './app.ts';
import { actionCatalogue } from './request.ts';
import { declareKernelWriteRates } from './write-rate-routes.ts';

export type KernelDependencies = Parameters<typeof createApp>[0] & {
  routeKey: Uint8Array;
  /** Trusted domain time only; authentication and request budgets retain real time. */
  clock?: () => Date;
  commerce?: CommerceDependencies;
  content?: ContentRuntime & Pick<ContentBoardDependencies, 'cursorNow'>;
  search?: SearchService;
};

/** The route key must stay the same across restarts, or retries lose their receipts. */
export function createKernel(dependencies: KernelDependencies) {
  const sourceClock = dependencies.clock ?? systemClock;
  const clock = () => {
    const instant = sourceClock();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new TypeError('Invalid command clock');
    return instant;
  };
  const factory = dependencies.access ?? createAccess;
  let access: Access | undefined;
  const resolveAccess = (config: AccessConfig) =>
    (access ??= typeof factory === 'function' ? factory(config) : factory);
  const tokens = dependencies.tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const app = definitionRoutes(
    subjectRoutes(createApp({ ...dependencies, access: resolveAccess, tokens }), dependencies),
    dependencies,
  );
  const payouts = payoutRoutes(app, {
    ...dependencies,
    access: () => resolveAccess({ actions: actionCatalogue(app) }),
  });
  const commercial = commerceRoutes(app, {
    pool: dependencies.pool,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(app) }),
    ...(dependencies.commerce === undefined ? {} : { commerce: dependencies.commerce }),
  });
  const contextual = contextRoutes(commercial as unknown as ReturnType<typeof definitionRoutes>, dependencies);
  const searched = searchRoutes(contextual, dependencies);
  const content = contentRoutes(searched as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    ...(dependencies.content?.cursorNow === undefined ? {} : { cursorNow: dependencies.content.cursorNow }),
    tokens,
    ...(dependencies.content?.fetchConfig === undefined ? {} : { fetchConfig: dependencies.content.fetchConfig }),
    ...(dependencies.content?.workflows === undefined ? {} : { workflows: dependencies.content.workflows }),
    ...(dependencies.content?.anonymousVerifier === undefined
      ? {}
      : { anonymousVerifier: dependencies.content.anonymousVerifier }),
    get access() {
      return resolveAccess({ actions: actionCatalogue(content) });
    },
  });
  const granted = accessRoutes(content as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(granted) }),
  });
  declareKernelWriteRates(granted);
  return granted as typeof granted &
    typeof content &
    typeof searched &
    typeof payouts &
    typeof commercial &
    typeof contextual;
}

/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
