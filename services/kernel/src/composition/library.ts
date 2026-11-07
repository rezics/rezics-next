import { createNativeCopyAccountAdmission } from '../access/adapters/index.ts';
import { nativeReleasedDefinitions, nativeCopyListContext } from '../semantic/adapters/index.ts';
import {
  createLibrarySubjectIdentityAdapter,
  observeLibrarySubjectSummaries,
  readLibraryIdentityMappings,
} from '../semantic/adapters/index.ts';
import {
  createLibraryAccountEligibilityAdapter,
  observeLibraryPublicAccount,
  observeLibraryAttributions,
  createResourcePublicEligibility,
} from '../access/adapters/index.ts';
import { observeLibrarySpaceSummary } from '../community/adapters/index.ts';
import { nativeFollowCountRuntime } from './library-follow-counts.ts';
import { createLibraryPreparationWork, nativeLibraryScopeWork } from '../search/adapters/index.ts';
/** Library process composition. Binds native SQL and foreign Access/Search/Semantic/Content adapters. */

import { commandAccessContext } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import accountCommandState from '../access/account-command-state.sql';
import type { AuthoritativeTime } from '../command/command.ts';
import { accessCheck, accessCommandAuthorization, type Access, type Actor } from '../request/access.ts';
import type { Pool } from 'pg';
import type { FilterDocument } from '@rezics/filter';
import { deadlineClient, within } from '../access/authenticate.ts';
import { accessRoot } from '../access/derived-access.ts';
import { admitGroup, PlatformClosedError } from '../access/gates/admission.ts';
import { fenceOperationalAccount } from '../access/account-share.ts';
import { durableInitiatorCommitment } from '../access/durable-initiator-capture.ts';
import { systemClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { checkMediaObject } from '../content/cover-reference.ts';
import { decideDownload } from '../content/media.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { activeRelease, readRelease } from '../semantic/definitions.ts';
import { compileCurrentOwnerFilter } from '../search/current-filter-plan.ts';
import { createSearchScopeForService, type SearchService } from '../search/service-scope.ts';
import { routeOf } from '../route/route.ts';
import {
  createIdentityNativeApplication,
  createLibraryApplications,
  createCollectionMutationApplication,
} from '../library/application/index.ts';
import {
  admitCollectionPublicationStep,
  retireNativeCollectionCapturePage,
  purgeSavedCollectionPage,
  createNativeCollectionPublicationEpisodes,
  readBuiltinPublicationRule,
  createNativeCollectionMutationPorts,
  createNativeCopyPorts,
  createAuthorizationAdapter,
  type AuthorizationAdapterPorts,
  createContentPublicationAdapter,
  type ContentPublicationAdapterPorts,
  createIdentityDisclosureAdapter,
  type IdentityDisclosureAdapterPorts,
  createIdentityNativeCatalog,
  createProgressOperationCatalog,
  createNativeSourceCaptureAdapter,
  createNativeLibraryPresentation,
  createSearchPreparationAdapter,
  type SearchPreparationAdapterPorts,
} from '../library/adapters/index.ts';
import { createLibraryCollectionPolicyMethods } from '../access/adapters/collection-policy.ts';
import {
  bindLibraryDomain,
  bindLibraryPresentation,
  peekLibraryDomain,
  requireLibraryDomain,
  unbindLibraryDomain,
} from '../library/domain-binding.ts';
import {
  preparedSource,
  type LibraryCapabilities,
  type LibraryDomain,
  type PreparedCollectionSource,
  type PreparedSearchScope,
} from '../library/contract/index.ts';
import { admissionTerm, sumAdmission } from '../library/core/index.ts';

function nativeAuthorizationPorts(): AuthorizationAdapterPorts {
  const collectionPolicy = createLibraryCollectionPolicyMethods();
  return {
    async admitCollectionRead(input) {
      try {
        await admitGroup({
          pool: input.pool,
          access: () => accessRoot(input.access),
          actor: input.actor,
          group: 'collections',
          clientAction: 'collection:read',
          deadline: input.deadline,
          clock: () => new Date(authoritativeTimeValue(input.at)),
          time: input.at,
        });
      } catch (error) {
        if (error instanceof PlatformClosedError) return false;
        throw error;
      }
      const check = await accessCheck(
        input.access,
        input.actor,
        'collection:read',
        { route: input.route, id: input.collectionId },
        { pool: input.pool, deadline: input.deadline, time: input.at },
      );
      return withConnection(input.pool, (client) => check(deadlineClient(client, input.deadline), input.at));
    },
    async fenceAccount(tx, accountId) {
      await fenceOperationalAccount(tx as Parameters<typeof fenceOperationalAccount>[0], accountId);
    },
    isLifecycleDenied(error) {
      return error instanceof Error && error.name === 'LifecycleDeniedError';
    },
    commandAuthorization(...args) {
      return (accessCommandAuthorization as (...values: readonly unknown[]) => Promise<unknown>)(...args);
    },
    deadlineClient(client, deadline) {
      return deadlineClient(client as Parameters<typeof deadlineClient>[0], deadline) as typeof client;
    },
    within(deadline, work) {
      return within(deadline, work);
    },
    specializeCollectionList(input) {
      return collectionPolicy.specializeCollectionList(input);
    },
    collectionAuthorizationPreparation() {
      return collectionPolicy.collectionAuthorizationPreparation();
    },
  };
}

function nativeIdentityDisclosurePorts(): IdentityDisclosureAdapterPorts {
  return { readRelease, readActiveRelease: activeRelease, readIdentityMappings, durableInitiatorCommitment, within };
}

function nativeSearchPreparationPorts(search?: unknown): SearchPreparationAdapterPorts {
  return {
    async prepareScope(input) {
      const service = (input.search as SearchService | undefined) ?? (search as SearchService | undefined);
      if (!service) throw new TypeError('The registered Search service is not configured.');
      const scope = createSearchScopeForService(service, {
        access: input.access,
        actor: input.actor,
        routeKey: input.routeKey,
        nativeT: input.nativeT,
        deadline: input.deadline,
      } as Parameters<typeof createSearchScopeForService>[1]);
      const prepared = await scope.prepare(
        input.filter as FilterDocument,
        {
          releaseDigest: input.releaseDigest,
          order: input.identity ? { kind: 'id', source: input.identity } : { kind: 'id' },
          allowance: input.allowance,
          readOnly: true,
        } as Parameters<typeof scope.prepare>[1],
      );
      return { prepared, work: scope.work(prepared), scope } as PreparedSearchScope;
    },
    filterLeaves(filter) {
      return compileCurrentOwnerFilter(filter as FilterDocument).leaves.map((leaf) =>
        leaf.kind === 'owner' ? ('owner' as const) : ('catalogue' as const),
      );
    },
  };
}

function nativeContentPublicationPorts(options: LibraryComposeOptions): ContentPublicationAdapterPorts {
  const { pool, access } = options;
  return {
    async readableCover(input) {
      if (!pool || !access || !input.routeKey || input.actor.kind !== 'account' || routeOf(input.mediaId) === null)
        return null;
      const reference = await withConnection(pool, (client) =>
        checkMediaObject(deadlineClient(client, input.deadline), input.mediaId, 'cover'),
      );
      const variant = reference?.variants?.[0];
      if (
        !reference ||
        !variant ||
        !reference.width ||
        !reference.height ||
        !reference.placeholder ||
        !reference.credit
      )
        return null;
      const decision = await decideDownload(
        {
          pool,
          access,
          clock: options.clock ?? systemClock,
          downloadContext: { deadline: input.deadline, routeKey: input.routeKey },
        },
        input.mediaId,
        input.actor as Actor,
        `${variant.format}-${variant.width}`,
      );
      if (!decision.allowed) return null;
      const current = await withConnection(pool, (client) =>
        checkMediaObject(deadlineClient(client, input.deadline), input.mediaId, 'cover'),
      );
      if (JSON.stringify(current) !== JSON.stringify(reference)) return null;
      return {
        media: reference.id,
        width: reference.width,
        height: reference.height,
        placeholder: { ...reference.placeholder },
        variants: reference.variants!.map((value) => ({ ...value })),
        focalPoint: reference.focalPoint ? { ...reference.focalPoint } : null,
        credit: {
          rightsHolder: reference.credit.rightsHolder,
          via: { ...reference.credit.via },
          license: reference.credit.license,
          obligations: [...reference.credit.obligations],
        },
      };
    },
  };
}

export type LibraryComposeOptions = Readonly<{
  pool?: Pool;
  access?: Access;
  search?: unknown;
  routeKey?: Uint8Array;
  clock?: () => Date;
  ordinaryPage?: boolean;
  sourceCapture?: LibraryCapabilities['sourceCapture'];
  capabilities?: Partial<LibraryCapabilities>;
  scopeWork?: import('../library/adapters/index.ts').NativeScopeWork;
  preparationWork?: import('../library/adapters/index.ts').NativePreparationWorkFactory;
}>;

function stubSource(): PreparedCollectionSource {
  return {
    [preparedSource]: true,
    observation: {
      collectionId: '',
      route: 0,
      incarnation: '',
      revision: 0,
      authority: { kind: 'curated' },
      stamp: { partition: 0, epoch: 0, position: 0n },
      basis: { digest: '', identity: { digest: '' }, query: null, profilePins: [], projection: null },
    },
  };
}

function nativeLibraryPresentation() {
  return createNativeLibraryPresentation({
    identity: createLibrarySubjectIdentityAdapter(),
    readMappings: readLibraryIdentityMappings,
    accountEligibility: createLibraryAccountEligibilityAdapter(),
    createResourcePublicEligibility,
    observeSubjects: observeLibrarySubjectSummaries,
    observeAccount: observeLibraryPublicAccount,
    observeAttributions: observeLibraryAttributions,
    observeSpace: observeLibrarySpaceSummary,
  });
}

/** Preloads install the same native presentation as server/worker without a placeholder Collection Source. */
export function composeLibraryPresentation(): void {
  bindLibraryPresentation(nativeLibraryPresentation());
}

export function composeLibraryDomain(options: LibraryComposeOptions = {}): ReturnType<typeof bindLibraryDomain> {
  const identityNative =
    options.capabilities?.identityNative ?? createIdentityNativeApplication(createIdentityNativeCatalog());
  const sourceCapture =
    options.sourceCapture ??
    options.capabilities?.sourceCapture ??
    (options.pool && options.access
      ? createNativeSourceCaptureAdapter({
          pool: options.pool,
          access: options.access,
          ...(options.ordinaryPage !== undefined ? { ordinaryPage: options.ordinaryPage } : {}),
        })
      : {
          async prepare(input) {
            return {
              source: stubSource(),
              work: {
                reservationId: input.allowance.reservationId,
                used: {
                  candidateKeys: 0,
                  nativeRows: 0,
                  identityMetadataRows: 0,
                  emptySeeks: 0,
                  nativePoints: 0,
                  witnessKeys: 0,
                  statements: 0,
                  bytes: 0,
                },
              },
            };
          },
        });
  const extras: { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {};
  if (options.search !== undefined) extras.search = options.search;
  if (options.access !== undefined) extras.access = options.access;
  if (options.routeKey !== undefined) extras.routeKey = options.routeKey;
  const capabilities: LibraryCapabilities & { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {
    authorization:
      options.capabilities?.authorization ??
      createAuthorizationAdapter({ access: options.access, pool: options.pool, ports: nativeAuthorizationPorts() }),
    identityDisclosure:
      options.capabilities?.identityDisclosure ??
      createIdentityDisclosureAdapter({ pool: options.pool, ports: nativeIdentityDisclosurePorts() }),
    searchPreparation:
      options.capabilities?.searchPreparation ??
      createSearchPreparationAdapter(nativeSearchPreparationPorts(options.search)),
    contentPublication:
      options.capabilities?.contentPublication ??
      createContentPublicationAdapter(nativeContentPublicationPorts(options)),
    identityNative,
    progressCatalog: options.capabilities?.progressCatalog ?? createProgressOperationCatalog(),
    collectionRetentionNative: options.capabilities?.collectionRetentionNative ?? {
      retireCapture(tx, input) {
        return retireNativeCollectionCapturePage(tx as Parameters<typeof retireNativeCollectionCapturePage>[0], input);
      },
      purgeSaved(tx, input) {
        return purgeSavedCollectionPage(tx as Parameters<typeof purgeSavedCollectionPage>[0], input);
      },
    },
    collectionPublicationNative: options.capabilities?.collectionPublicationNative ?? {
      createCommands(config) {
        return createNativeCollectionPublicationEpisodes(
          config as Parameters<typeof createNativeCollectionPublicationEpisodes>[0],
          { commandAccessContext, deadlineClient, denied: () => new GrantDeniedError() },
        );
      },
      readBuiltinRule(client, route, collectionId) {
        return readBuiltinPublicationRule(
          client as Parameters<typeof readBuiltinPublicationRule>[0],
          route,
          collectionId,
        );
      },
      admitStep(tx, locator) {
        return admitCollectionPublicationStep(tx as Parameters<typeof admitCollectionPublicationStep>[0], locator);
      },
    },
    collectionRuleAuthority: options.capabilities?.collectionRuleAuthority ?? {
      async readAccount(client, route, accountId) {
        const row = await accountCommandState.run(client as Parameters<typeof accountCommandState.run>[0], {
          route,
          account_id: accountId,
        });
        return row ? { ...row, minimumAuthnEpoch: BigInt(row.minimumAuthnEpoch) } : null;
      },
      async admitGroup(input) {
        await admitGroup({
          pool: input.pool as Pool,
          access: () => input.access as Access,
          actor: input.actor,
          group: input.action === 'progress_session:read' ? 'reading_progress' : 'personal_library',
          clientAction: input.action,
          deadline: input.deadline,
          clock: () => new Date(authoritativeTimeValue(input.at as AuthoritativeTime)),
        });
      },
      compileOwnerFilter(filter) {
        compileCurrentOwnerFilter(filter as FilterDocument);
      },
      denied() {
        return new GrantDeniedError();
      },
    },
    collectionMutations:
      options.capabilities?.collectionMutations ??
      createCollectionMutationApplication(createNativeCollectionMutationPorts()),
    sourceCapture,
    accountAdmission:
      options.capabilities?.accountAdmission ?? sumAdmission([admissionTerm('composition', { statements: 1 })]),
    ...extras,
  };
  const previous = peekLibraryDomain();
  return bindLibraryDomain({
    ...createLibraryApplications(capabilities),
    copyContext: nativeCopyListContext(),
    copyPorts: (config) =>
      createNativeCopyPorts(config, {
        account: createNativeCopyAccountAdmission(config),
        definitions: nativeReleasedDefinitions(),
      }),
    presentation: nativeLibraryPresentation(),
    followCounts: nativeFollowCountRuntime(),
    preparationWork: options.preparationWork ?? previous?.preparationWork ?? createLibraryPreparationWork,
    scopeWork: options.scopeWork ?? previous?.scopeWork ?? nativeLibraryScopeWork,
  });
}

export { peekLibraryDomain, bindLibraryDomain, requireLibraryDomain, unbindLibraryDomain };
