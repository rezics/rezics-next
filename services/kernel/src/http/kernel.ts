import { contentViewerActionResources } from '../content/viewer-actions.ts';
import { readCommerceMoneyPolicy, type CommerceMoneyPolicy } from '../commerce/money.ts';
import { mountContentEditionConsent } from '../content/edition-sale.ts';
import type { CurrentConsentReader } from '../access/auth-consent.ts';
import { createContentEditionBuyerFactReader } from '../commerce/content-edition-buyer-fact.ts';
import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import { NATIVE_CONTAINER_ACTIONS } from '../community/actions.ts';
import { assertReceiptKeyRing, configureReceiptKeys, readReceiptKeyRing } from '../command/receipt-key.ts';
import { randomBytes } from 'node:crypto';
import { zoneRoutes } from '../zones/http.ts';
import { zoneViewerActionResource } from '../zones/viewer-actions.ts';
import type { Elysia } from 'elysia';
import { parseExposure } from '../access/gates/declaration.ts';
import { deadlineClient, within } from '../access/authenticate.ts';
import { accessActionCatalogue, assertInternalActionDeclarations, createAccess } from '../access/index.ts';
import { deriveAccess } from '../access/derived-access.ts';
import { assertDeclaredResourceTypes } from '../access/resource-roles.ts';
import { installResourceRoleCatalogue, resourceRoleCatalogue } from '../access/resource-roles.ts';
import {
  compileViewerActionBindings,
  viewerActionBindingActions,
  viewerActionsRoutes,
  type ViewerActionResources,
  type ViewerActionBindings,
} from '../access/viewer-actions.ts';
import { contextViewerActionResource, subjectViewerActionResources } from '../semantic/viewer-actions.ts';
import { accountViewerActionResource } from '../access/account-viewer-actions.ts';
import { collectionViewerActionResource } from '../library/collection-reads.ts';
import { realmViewerActionResource } from '../community/realm.ts';
import { spaceViewerActionResource } from '../community/space.ts';
import { accessRoutes } from '../access/routes.ts';
import { erasureStatusRoutes } from '../access/erasure-status-route.ts';
import { exposureRoutes } from '../access/gates/routes.ts';
import { createRealmMembership } from '../community/membership.ts';
import { createRealmParticipationCheck, type RealmParticipationCheck } from '../community/participation.ts';
import { realmReadEligibility } from '../community/realm.ts';
import { communityRoutes } from '../community/routes.ts';
import { systemClock } from '../clock.ts';
import { payoutRoutes } from '../commerce/payout-routes.ts';
import { commerceRoutes, type CommerceDependencies } from '../commerce/routes.ts';
import { collectionRoutes } from '../library/collection-routes.ts';
import { continueRoutes } from '../library/continue-routes.ts';
import { feedRoutes } from '../content/feed-routes.ts';
import { personalLabelRoutes } from '../library/label-routes.ts';
import { pinRoutes } from '../library/pin-routes.ts';
import { progressRoutes } from '../library/progress-routes.ts';
import { diaryRoutes } from '../library/diary-routes.ts';
import { ratingRoutes } from '../rating/routes.ts';
import { sourceStatisticRoutes } from '../rating/source-statistics.ts';
import type { ContentBoardDependencies } from '../content/boards.ts';
import { currentRealmDisclosureScope } from '../content/reads.ts';
import { mediaRoutes } from '../content/media-routes.ts';
import { contentRoutes, subjectReactionRoutes } from '../content/routes.ts';
import { noticeRoutes } from '../content/notice-routes.ts';
import { realmOfItem } from '../content/realm-of-item.ts';
import type { TurnstileVerifier } from '../content/turnstile.ts';
import type { ContentRuntime } from '../content/runtime.ts';
import { bangumiImportRoutes } from '../library/list-import-bangumi-routes.ts';
import { malImportRoutes } from '../library/list-import-mal-routes.ts';
import { personalLibraryRoutes } from '../library/personal-routes.ts';
import { createDefaultShelfReads, type ShelfNativeReadBindings } from '../library/shelf-reader-defaults.ts';
import type { ShelfTypeDigest } from '../library/shelf-type-keys.ts';
import { createShelfMaintenanceOps } from '../library/shelf-maintenance-runtime.ts';
import { profileRoutes } from '../presentation/http/profiles.ts';
import type { Access, AccessConfig, AccessFactory, AccessRealmRoleReader, Actor, Resource } from '../request/access.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import { createWorkClient, type WorkClient } from '../work/client.ts';
import { recentSearchRoutes } from '../search/recent-searches.ts';
import { searchRoutes, type SearchService } from '../search/http/routes.ts';
import { configureDefinitionCatalogue, createNativeDefinitionCatalogue } from '../semantic/definition-catalogue.ts';
import { definitionRoutes } from '../semantic/http/definitions.ts';
import { contextRoutes } from '../semantic/http/contexts.ts';
import { bulkRoutes } from '../semantic/http/bulk.ts';
import { sourceRecordRoutes } from '../semantic/http/source-records.ts';
import { subjectRoutes } from '../semantic/http/subjects.ts';
import { providerReviewQueueRoutes } from '../semantic/http/provider-review-queue.ts';
import {
  createSubjectPagePublication,
  mountSubjectPagePublication,
  type SubjectPagePublication,
} from '../semantic/subject-page-publication.ts';
import { createSubjectPageFeed, type SubjectPageFeed } from '../semantic/subject-page-feed.ts';
import { subjectPageRoutes } from '../semantic/http/subject-pages.ts';
import { createApp } from './app.ts';
import { actionCatalogue } from './request.ts';
import { declareKernelWriteRates } from './write-rate-routes.ts';

export type KernelDependencies = Parameters<typeof createApp>[0] & {
  routeKey: Uint8Array;
  /** Trusted post-catalogue binding; runs before the host admits any request. */
  onAccessReady?: (access: Access) => void;
  /** Dedicated durable HMAC configuration, independent of ephemeral token defaults. */
  receiptKeys?: KeyRing;
  /** Trusted modules mount declarations before composition validation. */
  modules?: readonly ((app: ReturnType<typeof createApp>) => void)[];
  viewerActionResources?: ViewerActionResources;
  resourceRoles?: import('../access/resource-roles.ts').ResourceRoleCatalogue;
  /** Trusted domain time only; authentication and request budgets retain real time. */
  clock?: () => Date;
  commerce?: CommerceDependencies;
  moneyPolicy?: CommerceMoneyPolicy;
  content?: ContentRuntime &
    Pick<ContentBoardDependencies, 'cursorNow'> & {
      readConsent?: CurrentConsentReader;
    };
  search?: SearchService;
  /** Native shelf maintenance bindings; absence is a typed preparing response, never ready empty data. */
  shelves?: ShelfNativeReadBindings;
  /** Per-kernel private Type dictionary digest; defaults to SHA-256. */
  shelfTypeDigest?: ShelfTypeDigest;
  /** Optional entry preparation observation, after release of the source snapshots. */
  typeSourceObserved?: import('../library/type-preparation-contract.ts').TypePreparationSourceObserved;

  discovery?: import('../search/discovery-service.ts').DiscoverySearch;
  /** Trusted verifier binding; runtime secret/env composition belongs to the service. */
  reports?: { anonymousVerifier?: TurnstileVerifier };
  /** Enqueue-only client. Tests close the instance they pass. */
  workClient?: WorkClient;
  /** Test and deployment override for the kernel-registered current Realm role reader. */
  realmRoleReader?: AccessRealmRoleReader;
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
              eligibility: realmReadEligibility({
                route: realmRoute,
                id: association.realmId,
              }),
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

export class KernelAccessCompositionError extends Error {
  constructor() {
    super('Access was resolved before kernel composition finished');
    this.name = 'KernelAccessCompositionError';
  }
}

/** One Access per kernel, built on first use after composition from the complete
 * mounted catalogue; composition code receives Access lazily. Standalone test
 * compositions may supply their already-complete catalogue in resolveAccess.
 */
export function createKernelAccessResolver(options: {
  pool: Pool;
  tokens: KeyRing;
  clock: () => Date;
  access?: Access | AccessFactory;
  realmRoleReader?: AccessRealmRoleReader;
  /** Undefined until the kernel has mounted its last route. */
  composedActions?: () => AccessConfig['actions'] | undefined;
}): {
  resolveAccess: (config: AccessConfig) => Access;
  realmRoleReader: AccessRealmRoleReader;
} {
  const factory = options.access ?? createAccess;
  const contentEditionBuyerFactReader = createContentEditionBuyerFactReader({
    pool: options.pool,
    clock: options.clock,
  });
  let access: Access | undefined;
  let realmMembership: ReturnType<typeof createRealmMembership> | undefined;
  function membershipReader() {
    if (!realmMembership) {
      if (!access) throw new Error('Realm membership role reader is not installed');
      realmMembership = createRealmMembership({
        pool: options.pool,
        access,
        referenceKeys: options.tokens,
        clock: options.clock,
      });
    }
    return realmMembership.roleReader;
  }
  const realmRoleReader: AccessRealmRoleReader =
    options.realmRoleReader ??
    Object.assign(
      (client: Parameters<AccessRealmRoleReader>[0], input: Parameters<AccessRealmRoleReader>[1]) =>
        membershipReader()(client, input),
      {
        batch: ((client, input) => membershipReader().batch!(client, input)) as NonNullable<
          AccessRealmRoleReader['batch']
        >,
      },
    );
  const resolveAccess = (config: AccessConfig): Access => {
    if (typeof factory !== 'function') return (access = factory);
    if (access) return access;
    const actions = options.composedActions ? options.composedActions() : config.actions;
    if (!actions) throw new KernelAccessCompositionError();
    return (access = factory({
      ...config,
      actions,
      realmRoleReader,
      clock: options.clock,
      contentEditionBuyerFactReader,
    }));
  };
  return { resolveAccess, realmRoleReader };
}

/** The route key must stay the same across restarts, or retries lose their receipts. */
export function createKernel(dependencies: KernelDependencies): Kernel {
  if (dependencies.content?.readConsent)
    mountContentEditionConsent(dependencies.pool, dependencies.content.readConsent);
  const sourceClock = dependencies.clock ?? systemClock;
  const clock = () => {
    const instant = sourceClock();
    if (!(instant instanceof Date) || !Number.isFinite(instant.getTime())) throw new TypeError('Invalid command clock');
    return instant;
  };
  const tokens = dependencies.tokens ?? {
    current: 1,
    keys: new Map([[1, new Uint8Array(randomBytes(32))]]),
  };
  configureDefinitionCatalogue(dependencies.pool, tokens);
  const receiptKeys = readReceiptKeyRing(process.env, dependencies.receiptKeys);
  assertReceiptKeyRing(receiptKeys, tokens);
  configureReceiptKeys(dependencies.pool, receiptKeys);
  let composedActions: AccessConfig['actions'] | undefined;
  const accessFactory = typeof dependencies.access === 'function' ? dependencies.access : createAccess;
  const { resolveAccess, realmRoleReader } = createKernelAccessResolver({
    pool: dependencies.pool,
    tokens,
    clock,
    composedActions: () => composedActions,
    access:
      typeof dependencies.access === 'object'
        ? dependencies.access
        : (config) =>
            accessFactory({
              ...config,
              ...(dependencies.resourceRoles ? { resourceRoles: dependencies.resourceRoles } : {}),
            }),
    ...(dependencies.realmRoleReader === undefined ? {} : { realmRoleReader: dependencies.realmRoleReader }),
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
  let publication: SubjectPagePublication | undefined;
  let subjectPageFeed: SubjectPageFeed;
  function resolvePublication(): SubjectPagePublication {
    if (publication) return publication;
    const publicationConfig = {
      pool: dependencies.pool,
      access: resolveAccess({
        actions: actionCatalogue(subjects),
        realmRoleReader,
      }),
      clock: sourceClock,
      routeKey: dependencies.routeKey,
    };
    publication = createSubjectPagePublication(publicationConfig);
    subjectPageFeed = createSubjectPageFeed({
      ...publicationConfig,
      tokens,
      publication,
    });
    return publication;
  }
  subjectPageRoutes(subjects, {
    pool: dependencies.pool,
    feed: () => {
      resolvePublication();
      return subjectPageFeed;
    },
  });
  sourceRecordRoutes(subjects, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(subjects), realmRoleReader }),
  });
  providerReviewQueueRoutes(subjects, {
    pool: dependencies.pool,
    tokens,
    routeKey: dependencies.routeKey,
    workClient,
    access: () => resolveAccess({ actions: actionCatalogue(subjects), realmRoleReader }),
  });
  const batched = bulkRoutes(subjects, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(batched), realmRoleReader }),
  });
  const app = definitionRoutes(batched as unknown as ReturnType<typeof subjectRoutes>, {
    tokens,
    catalogue: () =>
      createNativeDefinitionCatalogue({
        pool: dependencies.pool,
        access: resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
      }),
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  profileRoutes(app, {
    ...dependencies,
    tokens,
    access: (config) => resolveAccess({ ...config, realmRoleReader }),
  });
  erasureStatusRoutes(app, {
    pool: dependencies.pool,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  payoutRoutes(app, {
    ...dependencies,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
  });
  const commercial = commerceRoutes(app, {
    moneyPolicy: dependencies.moneyPolicy ?? readCommerceMoneyPolicy(process.env),
    routeKey: dependencies.routeKey,
    pool: dependencies.pool,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(app), realmRoleReader }),
    ...(dependencies.commerce === undefined ? {} : { commerce: dependencies.commerce }),
  });
  let progress: ReturnType<typeof progressRoutes>;
  progress = progressRoutes(commercial as unknown as ReturnType<typeof definitionRoutes>, {
    routeKey: dependencies.routeKey,
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(progress), realmRoleReader }),
  });
  const diary = diaryRoutes(progress as unknown as ReturnType<typeof definitionRoutes>, {
    tokens,
    pool: dependencies.pool,
    clock,
    routeKey: dependencies.routeKey,
    access: () => resolveAccess({ actions: actionCatalogue(diary), realmRoleReader }),
  });
  const continued = continueRoutes(diary as unknown as ReturnType<typeof definitionRoutes>, {
    tokens,
    pool: dependencies.pool,
    clock,
    routeKey: dependencies.routeKey,
    ...(dependencies.search ? { search: dependencies.search } : {}),
    access: () => resolveAccess({ actions: actionCatalogue(continued), realmRoleReader }),
  });
  const feed = feedRoutes(continued as unknown as ReturnType<typeof definitionRoutes>, {
    tokens,
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    workClient,
    ...(dependencies.search ? { search: dependencies.search } : {}),
    ...(dependencies.discovery ? { discovery: dependencies.discovery } : {}),
    access: () => resolveAccess({ actions: actionCatalogue(feed), realmRoleReader }),
    contentAccess: () => realmAwareContentAccess(resolveAccess({ actions: actionCatalogue(feed), realmRoleReader })),
  });
  const contextual = contextRoutes(feed as unknown as ReturnType<typeof definitionRoutes>, {
    tokens,
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () =>
      resolveAccess({
        actions: actionCatalogue(contextual),
        realmRoleReader,
      }),
  });
  let searched: ReturnType<typeof searchRoutes>;
  searched = searchRoutes(contextual, {
    ...dependencies,
    clock,
    gateAccess: () => resolveAccess({ actions: actionCatalogue(searched), realmRoleReader }),
  });
  const anonymousVerifier = dependencies.reports?.anonymousVerifier ?? dependencies.content?.anonymousVerifier;
  const cursorNow = dependencies.content?.cursorNow ?? (() => clock().getTime());
  let contentAccess: Access | undefined;
  let realmParticipation: RealmParticipationCheck | undefined;
  let content: ReturnType<typeof contentRoutes>;
  const checkRealmParticipation: RealmParticipationCheck = (client, input, time) => {
    realmParticipation ??= createRealmParticipationCheck({
      pool: dependencies.pool,
      access: resolveAccess({
        actions: actionCatalogue(content),
        realmRoleReader,
      }),
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
  noticeRoutes(content as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    get access() {
      return contentDependencies.access;
    },
    clock,
  });
  subjectReactionRoutes(app as unknown as ReturnType<typeof createApp>, contentDependencies);
  const media = mediaRoutes(content as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    routeKey: dependencies.routeKey,
    realmParticipation: checkRealmParticipation,
    get access() {
      return resolveAccess({
        actions: actionCatalogue(granted),
        realmRoleReader,
      });
    },
  });
  const granted = accessRoutes(media as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    tokens,
    access: () => resolveAccess({ actions: actionCatalogue(granted), realmRoleReader }),
    realmRoleReader,
    grantResources: () => viewerResources,
  });
  const exposed = exposureRoutes(granted as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    clock,
    cursorKeys: tokens,
    access: () => resolveAccess({ actions: actionCatalogue(exposed), realmRoleReader }),
  });
  const community = communityRoutes(exposed as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(community), realmRoleReader }),
    tokens,
    workClient,
  });
  recentSearchRoutes(app as unknown as ReturnType<typeof createApp>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(zones), realmRoleReader }),
  });
  const personal = personalLibraryRoutes(community as unknown as ReturnType<typeof definitionRoutes>, {
    ...(dependencies.typeSourceObserved ? { typeSourceObserved: dependencies.typeSourceObserved } : {}),
    routeKey: dependencies.routeKey,
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(personal), realmRoleReader }),
    ...(dependencies.shelfTypeDigest === undefined ? {} : { shelfTypeDigest: dependencies.shelfTypeDigest }),
    shelves: () => {
      const access = resolveAccess({ actions: actionCatalogue(personal), realmRoleReader });
      return createDefaultShelfReads({
        pool: dependencies.pool,
        tokens,
        clock,
        access,
        maintenance: createShelfMaintenanceOps({
          pool: dependencies.pool,
          access,
          client: workClient,
          clock,
          ...(dependencies.shelfTypeDigest === undefined ? {} : { shelfTypeDigest: dependencies.shelfTypeDigest }),
        }),
        ...(dependencies.shelfTypeDigest === undefined ? {} : { shelfTypeDigest: dependencies.shelfTypeDigest }),
        ...dependencies.shelves,
      });
    },
  });
  const bangumi = bangumiImportRoutes(personal as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(bangumi), realmRoleReader }),
  });
  const mal = malImportRoutes(bangumi as unknown as ReturnType<typeof definitionRoutes>, {
    routeKey: dependencies.routeKey,
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(mal), realmRoleReader }),
  });
  const labels = personalLabelRoutes(mal as unknown as ReturnType<typeof definitionRoutes>, {
    routeKey: dependencies.routeKey,
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(labels), realmRoleReader }),
  });
  // Collection FULL facts use this server route key and the admitted route job deadline.
  const collections = collectionRoutes(labels as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    workClient,
    routeKey: dependencies.routeKey,
    tokens,
    clock,
    ...(dependencies.search ? { search: dependencies.search } : {}),
    access: () =>
      resolveAccess({
        actions: actionCatalogue(collections),
        realmRoleReader,
      }),
  });
  const pins = pinRoutes(collections as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(pins), realmRoleReader }),
  });
  let ratings: ReturnType<typeof ratingRoutes>;
  let sourceStatistics: ReturnType<typeof sourceStatisticRoutes>;
  ratings = ratingRoutes(pins as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    tokens,
    clock,
    access: () =>
      resolveAccess({
        actions: actionCatalogue(sourceStatistics),
        realmRoleReader,
      }),
  });
  declareKernelWriteRates(ratings);
  sourceStatistics = sourceStatisticRoutes(ratings as unknown as ReturnType<typeof definitionRoutes>, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    clock,
    access: () =>
      resolveAccess({
        actions: actionCatalogue(sourceStatistics),
        realmRoleReader,
      }),
  });
  const zones = zoneRoutes(sourceStatistics, {
    pool: dependencies.pool,
    routeKey: dependencies.routeKey,
    ...(dependencies.search ? { search: dependencies.search } : {}),
    tokens,
    clock,
    access: () => resolveAccess({ actions: actionCatalogue(zones), realmRoleReader }),
  });
  const viewerResources = new Map([
    ...subjectViewerActionResources,
    ...contentViewerActionResources,
    ['semantic.context', contextViewerActionResource],
    ['access.account', accountViewerActionResource],
    ['library.collection', collectionViewerActionResource],
    ['community.realm', realmViewerActionResource],
    ['community.space', spaceViewerActionResource],
    ['semantic.zone', zoneViewerActionResource],
  ]);
  for (const [type, resource] of dependencies.viewerActionResources ?? []) {
    if (viewerResources.has(type)) throw new Error(`${type}: duplicate viewer actions registration`);
    viewerResources.set(type, resource);
  }
  for (const module of dependencies.modules ?? []) module(zones as unknown as ReturnType<typeof createApp>);
  let viewerBindings: ViewerActionBindings;
  viewerActionsRoutes(zones as unknown as ReturnType<typeof createApp>, {
    pool: dependencies.pool,
    clock,
    resources: viewerResources,
    access: () => resolveAccess({ actions: actionCatalogue(zones), realmRoleReader }),
    bindings: () => viewerBindings,
  });
  declareKernelWriteRates(zones);
  viewerBindings = compileViewerActionBindings(zones.routes);
  for (const [type, resource] of viewerResources) {
    const actions = new Set([
      resource.readAction,
      ...(viewerBindings.get(type) ?? []).flatMap(viewerActionBindingActions),
    ]);
    if (actions.size > 64)
      throw new Error(`${type}: viewer actions exceed 64 candidate actions or 256 operation bindings`);
  }
  const parameterNames = new Map<string, { name: string; method: string; path: string }>();
  for (const route of zones.routes) {
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
        if (!first)
          parameterNames.set(key, {
            name,
            method: route.method,
            path: route.path,
          });
      }
    }
    if (route.hooks.detail?.hide === true) continue;
    try {
      parseExposure(route.hooks.detail);
    } catch (cause) {
      throw new Error(`${route.method.toUpperCase()} ${route.path}: invalid x-exposure declaration`, { cause });
    }
  }
  const actions = actionCatalogue(zones, NATIVE_CONTAINER_ACTIONS);
  const consentedScopeCount = accessActionCatalogue(actions).size;
  if (consentedScopeCount > MAX_CONSENTED_SCOPES)
    throw new Error(
      `Kernel action catalogue has ${consentedScopeCount} actions; consented scope bound is ${MAX_CONSENTED_SCOPES}`,
    );
  composedActions = actions;
  assertInternalActionDeclarations(actions);
  assertDeclaredResourceTypes(zones, dependencies.resourceRoles, actions);
  dependencies.onAccessReady?.(resolveAccess({ actions, realmRoleReader }));
  mountSubjectPagePublication(zones, resolvePublication);
  return zones as Kernel;
}

// The module inherits definition routes. Keep their existing schemas only once: intersecting
// another copy expands their response unions beyond the compiler's representable type size.
type ZoneComposition = Omit<ReturnType<typeof zoneRoutes>, '~Routes'> & {
  '~Routes': {
    v1: Pick<ReturnType<typeof zoneRoutes>['~Routes']['v1'], 'zones'>;
  };
};

type KernelComposition = ZoneComposition &
  ReturnType<typeof recentSearchRoutes> &
  ReturnType<typeof viewerActionsRoutes> &
  ReturnType<typeof sourceStatisticRoutes> &
  ReturnType<typeof ratingRoutes> &
  ReturnType<typeof collectionRoutes> &
  ReturnType<typeof continueRoutes> &
  ReturnType<typeof feedRoutes> &
  ReturnType<typeof pinRoutes> &
  ReturnType<typeof personalLabelRoutes> &
  ReturnType<typeof personalLibraryRoutes> &
  ReturnType<typeof bangumiImportRoutes> &
  ReturnType<typeof malImportRoutes> &
  ReturnType<typeof communityRoutes> &
  ReturnType<typeof exposureRoutes> &
  ReturnType<typeof subjectPageRoutes> &
  ReturnType<typeof bulkRoutes> &
  ReturnType<typeof sourceRecordRoutes> &
  ReturnType<typeof profileRoutes> &
  ReturnType<typeof accessRoutes> &
  ReturnType<typeof erasureStatusRoutes> &
  ReturnType<typeof mediaRoutes> &
  ReturnType<typeof contentRoutes> &
  ReturnType<typeof noticeRoutes> &
  ReturnType<typeof subjectReactionRoutes> &
  ReturnType<typeof searchRoutes> &
  ReturnType<typeof payoutRoutes> &
  ReturnType<typeof commerceRoutes> &
  ReturnType<typeof progressRoutes> &
  ReturnType<typeof diaryRoutes> &
  ReturnType<typeof contextRoutes> &
  ReturnType<typeof providerReviewQueueRoutes>;
export type Kernel = KernelComposition;

// Every route module inherits the same definition routes. Reuse their method types
// once: intersecting all inherited response unions can exceed TypeScript's union limit.
type ClientRoutes<Routes, Base> = {
  [Key in keyof Routes]: Key extends keyof Base
    ? Base[Key] extends { body: unknown; response: unknown }
      ? Base[Key]
      : ClientRoutes<Routes[Key], Base[Key]>
    : Routes[Key];
};

/** createKernel guarantees one parameter name for each route position. */
export type ClientKernel = Elysia<
  KernelComposition['~Prefix'],
  'local',
  KernelComposition['~Singleton'],
  KernelComposition['~Definitions'],
  KernelComposition['~Metadata'],
  ClientRoutes<KernelComposition['~Routes'], ReturnType<typeof definitionRoutes>['~Routes']>,
  KernelComposition['~Ephemeral'],
  KernelComposition['~Volatile']
>;
