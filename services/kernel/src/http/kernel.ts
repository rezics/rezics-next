import { randomBytes } from 'node:crypto';
import { parseExposure } from '../access/gates/declaration.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { createAccess } from '../access/index.ts';
import {
  assertDeclaredResourceTypes,
  installResourceRoleCatalogue,
  resourceRoleCatalogue,
} from '../access/resource-roles.ts';
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
import type { ContentBoardDependencies } from '../content/boards.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes } from '../content/routes.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { installRealmParticipationCheck, withRealmIndexedReads } from '../content/media-parent.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessRealmRoleReader, Actor, Resource } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
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

type ContentReadAssociation = Readonly<{ found: boolean; realmId: string | null }>;
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

const threadRealmRead = `SELECT b.realm_id
  FROM content.thread t
  JOIN content.board b ON b.route=get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
    AND b.board_id=t.board_id
  WHERE t.route=$1 AND t.thread_id=$2`;
const postRealmRead = `SELECT b.realm_id
  FROM content.post p
  JOIN content.thread t ON t.route=p.route AND t.thread_id=p.thread_id
  JOIN content.board b ON b.route=get_byte(uuid_send(t.board_id), 10) * 256 + get_byte(uuid_send(t.board_id), 11)
    AND b.board_id=t.board_id
  WHERE p.route=$1 AND p.post_id=$2`;

/** A Realm's read grant gates every content item on its boards. Bind the
 * relationship before checkout, then recheck it with both read formulas at T. */
function realmAwareContentAccess(access: Access): Access {
  const existing = realmAwareAccesses.get(access);
  if (existing) return existing;
  const proofs = new WeakMap<object, ContentReadProof>();
  const wrapped: Access = {
    authenticate: access.authenticate.bind(access),
    ...(access.replayAuthorization ? { replayAuthorization: access.replayAuthorization.bind(access) } : {}),
    async prepare(actor, action, resource, context) {
      const primary = access.prepare
        ? await withRealmIndexedReads(context.pool, () => access.prepare!(actor, action, resource, context))
        : undefined;
      if (action !== 'thread:read' && action !== 'post:read') return primary;

      const statement = action === 'thread:read' ? threadRealmRead : postRealmRead;
      const result = await withConnection(context.pool, (connection) =>
        within(context.deadline, () =>
          deadlineClient(connection, context.deadline).query<{ realm_id: string | null }>(statement, [
            resource.route,
            resource.id,
          ]),
        ),
      );
      const row = result.rows[0];
      const association: ContentReadAssociation =
        result.rows.length === 1 && row ? { found: true, realmId: row.realm_id } : { found: false, realmId: null };
      let realmResource: Resource | undefined;
      let realmEvidence: unknown;
      let valid = true;
      if (association.realmId !== null) {
        const realmRoute = routeOf(association.realmId);
        valid = realmRoute !== null;
        if (realmRoute !== null) {
          const preparedResource: Resource = {
            route: realmRoute,
            id: association.realmId,
            eligibility: realmReadEligibility({ route: realmRoute, id: association.realmId }),
          };
          realmResource = preparedResource;
          realmEvidence = access.prepare
            ? await withRealmIndexedReads(context.pool, () =>
                access.prepare!(actor, 'realm:read', preparedResource, context),
              )
            : undefined;
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
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL plan_cache_mode = force_custom_plan');
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

      const statement = action === 'thread:read' ? threadRealmRead : postRealmRead;
      const current = await client.query<{ realm_id: string | null }>(statement, [resource.route, resource.id]);
      const row = current.rows[0];
      if (current.rows.length !== 1 || !row || row.realm_id !== proof.association.realmId || !proof.association.found)
        return false;
      if (proof.association.realmId === null) return true;
      if (!proof.realmResource) return false;
      return access.authorize(client, actor, 'realm:read', proof.realmResource, proof.realmEvidence, time);
    },
  };
  const catalogue = resourceRoleCatalogue(access);
  if (catalogue) installResourceRoleCatalogue(wrapped, catalogue);
  realmAwareAccesses.set(access, wrapped);
  return wrapped;
}

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
    return (async () => {
      await client.query('BEGIN READ ONLY');
      try {
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL plan_cache_mode = force_custom_plan');
        const result = await realmMembership!.roleReader(client, input);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Preserve the original Realm role read failure.
        }
        throw error;
      }
    })();
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
  const subjects = subjectRoutes(
    createApp({
      ...dependencies,
      access: (config) => realmAwareContentAccess(resolveAccess(config)),
      tokens,
      clock,
    }),
    {
      ...dependencies,
      tokens,
      access: () => resolveAccess({ actions: actionCatalogue(subjects), realmRoleReader }),
    },
  );
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
  content = contentRoutes(searched as unknown as ReturnType<typeof definitionRoutes>, {
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
      if (!contentAccess) {
        contentAccess = realmAwareContentAccess(resolveAccess({ actions: actionCatalogue(content), realmRoleReader }));
        installRealmParticipationCheck(contentAccess, checkRealmParticipation);
      }
      return contentAccess;
    },
  });
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
  collections.wrap((fetch) => async (request, ...rest) => {
    const path = new URL(request.url).pathname;
    const contentRequest =
      /^\/v1\/(?:threads|posts|boards|media)(?:\/|$)/.test(path) || /^\/v1\/realms\/[^/]+\/boards(?:\/|$)/.test(path);
    if (!contentRequest) return fetch(request, ...rest);
    return withRealmIndexedReads(dependencies.pool, async () => await fetch(request, ...rest));
  });
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
