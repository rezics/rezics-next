import { randomBytes } from 'node:crypto';
import { createAccess } from '../access/index.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import type { Access, AccessConfig } from '../request/access.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { subjectRoutes } from '../semantic/http/subjects.ts';
import { createApp } from './app.ts';
import { actionCatalogue } from './request.ts';

export type KernelDependencies = Parameters<typeof createApp>[0] & {
  routeKey: Uint8Array;
  commerce?: CommerceDependencies;
};

/** The route key must stay the same across restarts, or retries lose their receipts. */
export function createKernel(dependencies: KernelDependencies) {
  const factory = dependencies.access ?? createAccess;
  let access: Access | undefined;
  const resolveAccess = (config: AccessConfig) =>
    (access ??= typeof factory === 'function' ? factory(config) : factory);
  const tokens = dependencies.tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const app = definitionRoutes(
    subjectRoutes(createApp({ ...dependencies, access: resolveAccess, tokens }), dependencies),
    dependencies,
  );
  const payouts = payoutRoutes(app, dependencies);
  const commerce = commerceRoutes(app, {
    pool: dependencies.pool,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(app) }),
    ...(dependencies.commerce === undefined ? {} : { commerce: dependencies.commerce }),
  });
  const kernel = contextRoutes(commerce as unknown as ReturnType<typeof definitionRoutes>, dependencies);
  return kernel as unknown as typeof commerce & typeof payouts & typeof kernel;
}

/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
