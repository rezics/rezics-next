import { randomBytes } from 'node:crypto';
import type { Elysia } from 'elysia';
import { parseExposure } from '../access/gates/declaration.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createAccess } from '../access/index.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { assertDeclaredResourceTypes } from '../access/resource-roles.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import { accessRoutes } from '../access/routes.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { createRealmMembership } from '../community/membership.ts';
import { createRealmParticipationCheck, type RealmParticipationCheck } from '../community/participation.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { communityRoutes } from '../community/routes.ts';
import { systemClock } from '../clock.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import { ratingRoutes } from '../rating/routes.ts';
import { sourceStatisticRoutes } from '../rating/source-statistics.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { currentRealmDisclosureScope } from '../content/reads.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes, subjectReactionRoutes } from '../content/routes.ts';
import { realmOfItem } from '../content/realm-of-item.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessFactory, AccessRealmRoleReader, Actor, Resource } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
import { subjectRoutes } from '../semantic/http/subjects.ts';
import { subjectPageRoutes } from '../semantic/http/subject-pages.ts';
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

type ContentReadAssociation = Readonly<{ realmId: string | null }>;
type ContentReadProof = Readonly<{
  actor: Actor;
  action: string;
  resource: Resource;
  primary: unknown;
  association: ContentReadAssociation;
  realmResource?: Resource;
  realmEvidence?: unknown;
  valid: boolean;
}>;
const realmAwareAccesses = new WeakMap<Access, Access>();

/** A Realm's read grant gates every content item on its boards. Bind the
 * relationship before checkout, then recheck it with both read formulas at T. */
function realmAwareContentAccess(access: Access): Access {
  const existing = realmAwareAccesses.get(access);
  if (existing) return existing;
  const proofs = new WeakMap<object, ContentReadProof>();
  const wrapped = deriveAccess(access, {
    async prepare(actor, action, resource, context) {
      const primary = access.prepare ? await access.prepare(actor, action, resource, context) : undefined;
      if (action !== 'thread:read' && action !== 'post:read') return primary;

      const scope = currentRealmDisclosureScope();
      const kind = action === 'thread:read' ? 'thread' : 'post';
      const realmId =
        scope?.realmId !== undefined
          ? scope.realmId
          : await withConnection(context.pool, (connection) =>
              within(context.deadline, () =>
                realmOfItem(deadlineClient(connection, context.deadline), kind, resource.route, resource.id),
              ),
            );
      if (scope && scope.realmId === undefined) scope.realmId = realmId;
      const association: ContentReadAssociation = { realmId };
      let realmResource: Resource | undefined;
      let realmEvidence: unknown;
      let valid = true;
      if (association.realmId !== null) {
        const realmRoute = routeOf(association.realmId);
        valid = realmRoute !== null;
        if (realmRoute !== null) {
          if (
            scope?.realmResource?.route === realmRoute &&
            scope.realmResource.id === association.realmId &&
            scope.realmEvidencePrepared
          ) {
            realmResource = scope.realmResource;
            realmEvidence = scope.realmEvidence;
          } else {
            const preparedResource: Resource = {
              route: realmRoute,
              id: association.realmId,
              eligibility: realmReadEligibility({ route: realmRoute, id: association.realmId }),
            };
            realmResource = preparedResource;
            realmEvidence = access.prepare
              ? await access.prepare(actor, 'realm:read', preparedResource, context)
              : undefined;
            if (scope) {
              scope.realmResource = preparedResource;
              scope.realmEvidence = realmEvidence;
              scope.realmEvidencePrepared = true;
            }
          }
        }
      }
      const proof = Object.freeze({});
      proofs.set(proof, {
        actor,
        action,
        resource,
        primary,
        association,
        ...(realmResource ? { realmResource } : {}),
        ...(realmEvidence === undefined ? {} : { realmEvidence }),
        valid,
      });
      return proof;
    },
    async authorize(client, actor, action, resource, evidence, time) {
      const proof = typeof evidence === 'object' && evidence !== null ? proofs.get(evidence) : undefined;
      if (!proof) return access.authorize(client, actor, action, resource, evidence, time);
      if (
        proof.actor !== actor ||
        proof.action !== action ||
        proof.resource.route !== resource.route ||
        proof.resource.id !== resource.id ||
        !proof.valid
      )
        return false;
      const primaryAllowed = await access.authorize(client, actor, action, resource, proof.primary, time);
      if (!primaryAllowed) return false;

      const kind = action === 'thread:read' ? 'thread' : 'post';
      const scope = currentRealmDisclosureScope();
      if (scope?.realmId !== undefined && scope.realmId !== proof.association.realmId) return false;
      if (scope?.associationCheck) {
        if (!(await scope.associationCheck)) return false;
      } else {
        const associationCheck = realmOfItem(client, kind, resource.route, resource.id).then(
          (realmId) => realmId === proof.association.realmId,
        );
        if (scope) scope.associationCheck = associationCheck;
        if (!(await associationCheck)) return false;
      }
      if (proof.association.realmId === null) return true;
      if (!proof.realmResource) return false;
      if (scope?.accessCheck) return scope.accessCheck;
      const accessCheck = access.authorize(client, actor, 'realm:read', proof.realmResource, proof.realmEvidence, time);
      if (scope) scope.accessCheck = accessCheck;
      return accessCheck;
    },
  });
  const catalogue = resourceRoleCatalogue(access);
  if (catalogue) installResourceRoleCatalogue(wrapped, catalogue);
  realmAwareAccesses.set(access, wrapped);
  return wrapped;
}

/** Builds the Access resolver shared by production kernels and test compositions. */
export function createKernelAccessResolver(options: {
  pool: Pool;
  tokens: KeyRing;
  clock: () => Date;
  access?: Access | AccessFactory;
  realmRoleReader?: AccessRealmRoleReader;
}): { resolveAccess: (config: AccessConfig) => Access; realmRoleReader: AccessRealmRoleReader } {
  const factory = options.access ?? createAccess;
  let access: Access | undefined;
  let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
  const realmRoleReader: AccessRealmRoleReader =
    options.realmRoleReader ??
    ((client, input) => {
      if (!realmMembership) {
        if (!access) throw new Error('Realm membership role reader is not installed');
        realmMembership = createRealmMembership({
          pool: options.pool,
          access,
          referenceKeys: options.tokens,
          clock: options.clock,
        });
      }
      return realmMembership.roleReader(client, input);
    });
  const resolveAccess = (config: AccessConfig) =>
    (access ??=
      typeof factory === 'function' ? factory({ ...config, realmRoleReader, clock: options.clock }) : factory);
  return { resolveAccess, realmRoleReader };
}

/** The route key must stay the same across restarts, or retries lose their receipts. */
export function createKernel(dependencies: KernelDependencies): Kernel {
  const sourceClock = dependencies.clock ?? systemClock;
  const clock = () => {
    const instant = sourceClock();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new TypeError('Invalid command clock');
    return instant;
  };
  const tokens = dependencies.tokens ?? { current: 1, keys: new Map([[1, new Uint8Array(randomBytes(32))]]) };
  const { resolveAccess, realmRoleReader } = createKernelAccessResolver({
    pool: dependencies.pool,
    tokens,
    clock,
    ...(dependencies.access === undefined ? {} : { access: dependencies.access }),
  });
  let opened: Promise<WorkClient> | undefined;
  const workClient = (): Promise<WorkClient> => {
    if (dependencies.workClient) return Promise.resolve(dependencies.workClient);
    const url = dependencies.pool.options.connectionString;
    if (!url) return Promise.reject(new Error('Work client requires the pool connection string'));
    opened ??= createWorkClient(url);
    return opened;
  };
  const subjects = subjectRoutes(
    createApp({
      ...dependencies,
      access: (config) => realmAwareContentAccess(resolveAccess(config)),
      tokens,
      clock,
    }),
    {
      ...dependencies,
      clock,
      tokens,
      access: () => resolveAccess({ actions: actionCatalogue(subjects), realmRoleReader }),
    },
  );
  subjectPageRoutes(subjects as unknown as ReturnType<typeof createApp>);
  const batched = bulkRoutes(subjects, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(batched), realmRoleReader }),
  });
  const app = definitionRoutes(batched as unknown as ReturnType<typeof subjectRoutes>, {
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  profileRoutes(app, { ...dependencies, tokens });
  payoutRoutes(app, {
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
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(contextual), realmRoleReader }),
  });
  const searched = searchRoutes(contextual, dependencies);
  const anonymousVerifier = dependencies.reports?.anonymousVerifier ?? dependencies.content?.anonymousVerifier;
  const cursorNow = dependencies.content?.cursorNow ?? (() => clock().getTime());
  let contentAccess: Access | undefined;
  let realmParticipation: RealmParticipationCheck | undefined;
  let content: ReturnType<typeof contentRoutes>;
  const checkRealmParticipation: RealmParticipationCheck = (client, input, time) => {
    realmParticipation ??= createRealmParticipationCheck({
      pool: dependencies.pool,
      access: resolveAccess({ actions: actionCatalogue(content), realmRoleReader }),
    });
    return realmParticipation(client, input, time);
  };
  const contentDependencies = {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    cursorNow,
    tokens,
    ...(dependencies.content?.fetchConfig === undefined ? {} : { fetchConfig: dependencies.content.fetchConfig }),
    ...(dependencies.content?.workflows === undefined ? {} : { workflows: dependencies.content.workflows }),
    ...(anonymousVerifier === undefined ? {} : { anonymousVerifier }),
    realmParticipation: checkRealmParticipation,
    get access() {
      if (!contentAccess)
        contentAccess = realmAwareContentAccess(resolveAccess({ actions: actionCatalogue(content), realmRoleReader }));
      return contentAccess;
    },
  };
  content = contentRoutes(searched as unknown as ReturnType<typeof definitionRoutes>, contentDependencies);
  subjectReactionRoutes(app as unknown as ReturnType<typeof createApp>, contentDependencies);
  const media = mediaRoutes(content as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    routeKey: dependencies.routeKey,
    realmParticipation: checkRealmParticipation,
    get access() {
      return resolveAccess({ actions: actionCatalogue(granted), realmRoleReader });
    },
  });
  const granted = accessRoutes(media as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    tokens,
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
  let ratings: ReturnType<typeof ratingRoutes>;
  let sourceStatistics: ReturnType<typeof sourceStatisticRoutes>;
  ratings = ratingRoutes(collections as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(sourceStatistics), realmRoleReader }),
  });
  declareKernelWriteRates(ratings);
  sourceStatistics = sourceStatisticRoutes(ratings as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(sourceStatistics), realmRoleReader }),
  });
  declareKernelWriteRates(sourceStatistics);
  const parameterNames = new Map<string, { name: string; method: string; path: string }>();
  for (const route of sourceStatistics.routes) {
    const segments = route.path.split('/');
    for (const [position, segment] of segments.entries()) {
      if (segment.startsWith(':')) {
        const name = segment.slice(1);
        const key = JSON.stringify(
          segments.slice(0, position).map((prefixSegment) => (prefixSegment.startsWith(':') ? ':' : prefixSegment)),
        );
        const first = parameterNames.get(key);
        if (first && first.name !== name) {
          throw new Error(
            `${first.method.toUpperCase()} ${first.path} and ${route.method.toUpperCase()} ${route.path}: inconsistent path parameter name at position ${position}`,
          );
        }
        if (!first) parameterNames.set(key, { name, method: route.method, path: route.path });
      }
    }
    if (route.hooks.detail?.hide === true) continue;
    try {
      parseExposure(route.hooks.detail);
    } catch (cause) {
      throw new Error(`${route.method.toUpperCase()} ${route.path}: invalid x-exposure declaration`, { cause });
    }
  }
  assertDeclaredResourceTypes(sourceStatistics);
  return sourceStatistics as Kernel;
}

type KernelComposition = ReturnType<typeof sourceStatisticRoutes> &
  ReturnType<typeof ratingRoutes> &
  ReturnType<typeof collectionRoutes> &
  ReturnType<typeof personalLibraryRoutes> &
  ReturnType<typeof communityRoutes> &
  ReturnType<typeof exposureRoutes> &
  ReturnType<typeof subjectPageRoutes> &
  ReturnType<typeof bulkRoutes> &
  ReturnType<typeof profileRoutes> &
  ReturnType<typeof accessRoutes> &
  ReturnType<typeof mediaRoutes> &
  ReturnType<typeof contentRoutes> &
  ReturnType<typeof subjectReactionRoutes> &
  ReturnType<typeof searchRoutes> &
  ReturnType<typeof payoutRoutes> &
  ReturnType<typeof commerceRoutes> &
  ReturnType<typeof progressRoutes> &
  ReturnType<typeof contextRoutes>;

export type Kernel = KernelComposition;

/** createKernel guarantees one parameter name for each route position. */
export type ClientKernel = Elysia<
  KernelComposition['~Prefix'],
  'local',
  KernelComposition['~Singleton'],
  KernelComposition['~Definitions'],
  KernelComposition['~Metadata'],
  KernelComposition['~Routes'],
  KernelComposition['~Ephemeral'],
  KernelComposition['~Volatile']
>;
