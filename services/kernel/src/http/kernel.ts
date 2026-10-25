import { randomBytes } from 'node:crypto';
import { parseExposure } from '../access/gates/declaration.ts';
import { assertDeclaredResourceTypes } from '../access/resource-roles.ts';
import { createAccess } from '../access/index.ts';
import { accessRoutes } from '../access/routes.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { createRealmMembership } from '../community/membership.ts';
import { communityRoutes } from '../community/routes.ts';
import { systemClock } from '../clock.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes } from '../content/routes.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessRealmRoleReader } from '../request/access.ts';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
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
  /** Trusted verifier binding; runtime secret/env composition belongs to the service. */
  reports?: { anonymousVerifier?: TurnstileVerifier };
  /** Enqueue-only client. Tests close the instance they pass. */
  workClient?: WorkClient;
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
  const tokens = dependencies.tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  let access: Access | undefined;
  let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
  const realmRoleReader: AccessRealmRoleReader = (client, input) => {
    if (!realmMembership) {
      if (!access) throw new Error('Realm membership role reader is not installed');
      realmMembership = createRealmMembership({ pool: dependencies.pool, access, referenceKeys: tokens, clock });
    }
    return realmMembership.roleReader(client, input);
  };
  const resolveAccess = (config: AccessConfig) =>
    (access ??= typeof factory === 'function' ? factory({ ...config, realmRoleReader, clock }) : factory);
  let opened: Promise<WorkClient> | undefined;
  const workClient = (): Promise<WorkClient> => {
    if (dependencies.workClient) return Promise.resolve(dependencies.workClient);
    const url = dependencies.pool.options.connectionString;
    if (!url) return Promise.reject(new Error('Work client requires the pool connection string'));
    opened ??= createWorkClient(url);
    return opened;
  };
  const subjects = subjectRoutes(createApp({ ...dependencies, access: resolveAccess, tokens, clock }), {
    ...dependencies,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(subjects), realmRoleReader }),
  });
  const batched = bulkRoutes(subjects, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    access: () => resolveAccess({ actions: actionCatalogue(batched), realmRoleReader }),
  });
  const app = definitionRoutes(batched as unknown as ReturnType<typeof subjectRoutes>, {
    pool: dependencies.pool,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  const presentation = profileRoutes(app, { ...dependencies, tokens });
  const payouts = payoutRoutes(app, {
    ...dependencies,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  const commercial = commerceRoutes(app, {
    pool: dependencies.pool,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
    ...(dependencies.commerce === undefined ? {} : { commerce: dependencies.commerce }),
  });
  let progress: ReturnType<typeof progressRoutes>;
  progress = progressRoutes(commercial as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(progress), realmRoleReader }),
  });
  const contextual = contextRoutes(progress as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    access: () => resolveAccess({ actions: actionCatalogue(contextual), realmRoleReader }),
  });
  const searched = searchRoutes(contextual, dependencies);
  const anonymousVerifier = dependencies.reports?.anonymousVerifier ?? dependencies.content?.anonymousVerifier;
  const cursorNow = dependencies.content?.cursorNow ?? (() => clock().getTime());
  const content = contentRoutes(searched as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    cursorNow,
    tokens,
    ...(dependencies.content?.fetchConfig === undefined ? {} : { fetchConfig: dependencies.content.fetchConfig }),
    ...(dependencies.content?.workflows === undefined ? {} : { workflows: dependencies.content.workflows }),
    ...(anonymousVerifier === undefined ? {} : { anonymousVerifier }),
    get access() {
      return resolveAccess({ actions: actionCatalogue(content), realmRoleReader });
    },
  });
  const media = mediaRoutes(content as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    routeKey: dependencies.routeKey,
    get access() {
      return resolveAccess({ actions: actionCatalogue(granted), realmRoleReader });
    },
  });
  const granted = accessRoutes(media as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(granted), realmRoleReader }),
  });
  const exposed = exposureRoutes(granted as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
  });
  const community = communityRoutes(exposed as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(community), realmRoleReader }),
    tokens,
    workClient,
  });
  const personal = personalLibraryRoutes(community as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(personal), realmRoleReader }),
  });
  const collections = collectionRoutes(personal as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(collections), realmRoleReader }),
  });
  declareKernelWriteRates(collections);
  const parameterNames = new Map<string, { name: string; method: string; path: string }>();
  for (const route of collections.routes) {
    const prefix: string[] = [];
    for (const [position, segment] of route.path.split('/').entries()) {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        const key = JSON.stringify([prefix, position]);
        const first = parameterNames.get(key);
        if (first && first.name !== name) {
          throw new Error(
            `${first.method.toUpperCase()} ${first.path} and ${route.method.toUpperCase()} ${route.path}: inconsistent path parameter name at position ${position}`,
          );
        }
        if (!first) parameterNames.set(key, { name, method: route.method, path: route.path });
        prefix.push(':');
      } else {
        prefix.push(segment);
      }
    }
    if (route.hooks.detail?.hide === true) continue;
    try {
      parseExposure(route.hooks.detail);
    } catch (cause) {
      throw new Error(`${route.method.toUpperCase()} ${route.path}: invalid x-exposure declaration`, { cause });
    }
  }
  assertDeclaredResourceTypes(collections);
  return collections as typeof collections &
    typeof personal &
    typeof community &
    typeof exposed &
    typeof batched &
    typeof presentation &
    typeof granted &
    typeof media &
    typeof content &
    typeof searched &
    typeof payouts &
    typeof commercial &
    typeof progress &
    typeof contextual;
}

/** The app's type is the Eden contract. */
export type Kernel = ReturnType<typeof createKernel>;
