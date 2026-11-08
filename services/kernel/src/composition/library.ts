import { createLibraryAccessPorts } from '../access/adapters/library.ts';
import { createNativeCopyAccountAdmission, nativeCopyAccountWork } from '../access/adapters/copy-account.ts';
import { nativeReleasedDefinitions, nativeCopyListContext } from '../semantic/adapters/index.ts';
import { decodeCursor, encodeCursor } from '../tokens/cursor.ts';
import { createLibraryObservationApplication } from '../semantic/index.ts';
import {
  createLibrarySubjectIdentityAdapter,
  observeLibrarySubjectSummaries,
  readLibraryIdentityMappings,
} from '../semantic/adapters/index.ts';
import {
  createLibraryAccountEligibilityAdapter,
  observeLibraryPublicAccount,
  observeLibraryAttributions,
} from '../access/adapters/library-presentation.ts';
import { createResourcePublicEligibility } from '../access/public-eligibility.ts';
import { observeLibrarySpaceSummary } from '../community/adapters/index.ts';
import { nativeFollowCountRuntime } from './library-follow-counts.ts';
import { createLibraryPreparationWork, nativeLibraryScopeWork } from '../search/adapters/index.ts';
/** Library process composition. Binds native SQL and foreign Access/Search/Semantic/Content adapters. */

import { commandAccessContext } from '../access/command-admission.ts';
import { GrantDeniedError } from '../access/resource-access-errors.ts';
import { createNativeCollectionRuleAccountAuthority } from '../access/adapters/collection-rule-authority.ts';
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
import { compileCurrentOwnerFilter } from '../search/current-filter-plan.ts';
import { createSearchScopeForService, type SearchService } from '../search/service-scope.ts';
import { routeOf } from '../route/route.ts';
import { ProblemError } from '../http/problem-error.ts';
import {
  createIdentityNativeApplication,
  createNativePublicOutputApplication,
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
  createLibraryCommandRunner,
  readLibraryProfileSourceObservation,
  readLibraryProfileAnchor,
  createAuthorizationAdapter,
  type AuthorizationAdapterPorts,
  createContentPublicationAdapter,
  type ContentPublicationAdapterPorts,
  createIdentityDisclosureAdapter,
  type IdentityDisclosureAdapterPorts,
  createIdentityNativeCatalog,
  createProgressOperationCatalog,
  createNativeSourceCaptureAdapter,
  readNativeCollectionScopeIdentity,
  createNativePublicOutputAdapter,
  observeNativePublicCollectionOutput,
  createNativeLibraryPresentation,
  createMembersPreparationAdapter,
  createSearchPreparationAdapter,
  type SearchPreparationAdapterPorts,
} from '../library/adapters/index.ts';
import { resolvePublicIdentityOutputCaptureDisposition } from '../semantic/identity-public-output-capture.ts';
import { createLibraryCollectionPolicyMethods } from '../access/adapters/collection-policy.ts';
import {
  bindLibraryDomain,
  bindLibraryCopy,
  requireLibraryCopyBinding,
  bindLibraryAccess,
  bindLibraryPresentation,
  peekLibraryDomain,
  peekLibraryPresentation,
  requireLibraryDomain,
  unbindLibraryDomain,
} from '../library/domain-binding.ts';
import {
  preparedSource,
  type LibraryCapabilities,
  type LibraryDomain,
  type NativeSourceIdentity,
  type PreparedCollectionSource,
  type PreparedSearchScope,
  type WorkAllowance,
  type WorkDimensions,
  type WorkReceipt,
} from '../library/contract/index.ts';
import { admissionTerm, sumAdmission, createProgressOperationBounds } from '../library/core/index.ts';

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
  const definitions = nativeReleasedDefinitions();
  return {
    readRelease: definitions.read,
    readActiveRelease: definitions.active,
    readIdentityMappings,
    durableInitiatorCommitment,
    within,
  };
}

function sourceAllowanceAfter(allowance: WorkAllowance, receipt: WorkReceipt): WorkAllowance {
  const remaining = { ...allowance.remaining };
  for (const axis of Object.keys(remaining) as (keyof WorkDimensions)[]) remaining[axis] -= receipt.used[axis];
  return { reservationId: allowance.reservationId, remaining };
}

function addSearchWork(first: WorkReceipt | null, second: WorkReceipt): WorkReceipt {
  if (!first) return second;
  const used: WorkDimensions = {
    candidateKeys: first.used.candidateKeys + second.used.candidateKeys,
    nativeRows: first.used.nativeRows + second.used.nativeRows,
    identityMetadataRows: first.used.identityMetadataRows + second.used.identityMetadataRows,
    emptySeeks: first.used.emptySeeks + second.used.emptySeeks,
    nativePoints: first.used.nativePoints + second.used.nativePoints,
    witnessKeys: first.used.witnessKeys + second.used.witnessKeys,
    statements: first.used.statements + second.used.statements,
    bytes: first.used.bytes + second.used.bytes,
  };
  return { reservationId: first.reservationId, used };
}

function nativeSearchPreparationPorts(search?: unknown, pool?: Pool): SearchPreparationAdapterPorts {
  return {
    async prepareScope(input) {
      const service = (input.search as SearchService | undefined) ?? (search as SearchService | undefined);
      if (!service) throw new TypeError('The registered Search service is not configured.');
      let identity: NativeSourceIdentity | undefined =
        preparedSource in input.identity ? undefined : (input.identity as NativeSourceIdentity);
      let identityWork: WorkReceipt | null = null;
      if (preparedSource in input.identity) {
        if (!pool) throw new TypeError('Resolving a captured Library Source requires its native pool.');
        const captured = input.identity as PreparedCollectionSource;
        const resolved = await readNativeCollectionScopeIdentity(pool, {
          route: captured.observation.route,
          collectionId: captured.observation.collectionId,
          deadline: input.deadline,
          allowance: input.allowance,
        });
        if (
          !resolved.identity ||
          resolved.identity.route !== captured.observation.route ||
          resolved.identity.collectionId !== captured.observation.collectionId ||
          resolved.identity.incarnation !== captured.observation.incarnation
        )
          throw new TypeError('The captured Library Source has no current native Search identity.');
        identity = resolved.identity;
        identityWork = resolved.work;
      }
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
          order: identity ? { kind: 'id', source: identity } : { kind: 'id' },
          allowance: identityWork ? sourceAllowanceAfter(input.allowance, identityWork) : input.allowance,
          readOnly: true,
        } as Parameters<typeof scope.prepare>[1],
      );
      return {
        prepared,
        work: addSearchWork(identityWork, scope.work(prepared)),
        scope,
      } as PreparedSearchScope;
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

function nativeLibraryPresentation(semanticObservations: LibraryCapabilities['semanticObservations']) {
  return createNativeLibraryPresentation({
    semanticObservations,
    cursors: { decode: decodeCursor, encode: encodeCursor },
    identity: createLibrarySubjectIdentityAdapter(semanticObservations),
    readMappings: (pool, ids) => readLibraryIdentityMappings(semanticObservations, pool, ids),
    accountEligibility: createLibraryAccountEligibilityAdapter(),
    createResourcePublicEligibility,
    observeSubjects: (context, ids) => observeLibrarySubjectSummaries(semanticObservations, context, ids),
    observeAccount: observeLibraryPublicAccount,
    observeAttributions: observeLibraryAttributions,
    observeSpace: observeLibrarySpaceSummary,
  });
}

/** One native producer set serves every Copy factory and its reached profile reads. */
function composeLibraryCopies(): void {
  const definitions = nativeReleasedDefinitions();
  const work = {
    ...createProgressOperationBounds(createProgressOperationCatalog()),
    account: nativeCopyAccountWork(),
  };
  const profileSource = {
    observe: (deps: Parameters<typeof readLibraryProfileSourceObservation>[0], subjectId: string) =>
      readLibraryProfileSourceObservation(deps, subjectId, definitions),
    anchor: readLibraryProfileAnchor,
  };
  const producers = (config: Parameters<typeof createNativeCopyPorts>[0]) => ({
    account: createNativeCopyAccountAdmission(config),
    commands: createLibraryCommandRunner(config),
    definitions,
    profileSource,
    work,
  });
  bindLibraryCopy({
    producers,
    work,
    ports: (config) => createNativeCopyPorts(config, producers(config), { decode: decodeCursor, encode: encodeCursor }),
  });
}

/** Preloads install the same native presentation as server/worker without a placeholder Collection Source. */
export function composeLibraryPresentation(): void {
  composeLibraryCopies();
  bindLibraryAccess(createLibraryAccessPorts());
  const semanticObservations = peekLibraryDomain()?.semanticObservations ?? createLibraryObservationApplication();
  bindLibraryPresentation(nativeLibraryPresentation(semanticObservations));
}

export function composeLibraryDomain(options: LibraryComposeOptions = {}): ReturnType<typeof bindLibraryDomain> {
  composeLibraryCopies();
  bindLibraryAccess(createLibraryAccessPorts());
  const previous = peekLibraryDomain();
  const semanticObservations =
    options.capabilities?.semanticObservations ??
    previous?.semanticObservations ??
    peekLibraryPresentation()?.semanticObservations ??
    createLibraryObservationApplication();
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
          async prepare() {
            throw new ProblemError('dependency_unavailable');
          },
        });
  const extras: { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {};
  if (options.search !== undefined) extras.search = options.search;
  if (options.access !== undefined) extras.access = options.access;
  if (options.routeKey !== undefined) extras.routeKey = options.routeKey;
  const capabilities: LibraryCapabilities & { search?: unknown; access?: unknown; routeKey?: Uint8Array } = {
    semanticObservations,
    authorization:
      options.capabilities?.authorization ??
      createAuthorizationAdapter({ access: options.access, pool: options.pool, ports: nativeAuthorizationPorts() }),
    identityDisclosure:
      options.capabilities?.identityDisclosure ??
      createIdentityDisclosureAdapter({ pool: options.pool, ports: nativeIdentityDisclosurePorts() }),
    searchPreparation:
      options.capabilities?.searchPreparation ??
      createSearchPreparationAdapter(nativeSearchPreparationPorts(options.search, options.pool)),
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
      ...createNativeCollectionRuleAccountAuthority(),
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
  const nativePublicOutput = createNativePublicOutputApplication(
    createNativePublicOutputAdapter({
      observe: observeNativePublicCollectionOutput,
      lockDisposition: resolvePublicIdentityOutputCaptureDisposition,
    }),
  );
  const applications = createLibraryApplications(capabilities);
  return bindLibraryDomain({
    ...applications,
    nativePublicOutput,
    membersPreparation: createMembersPreparationAdapter(applications),
    copyContext: nativeCopyListContext(),
    copyPorts: requireLibraryCopyBinding().ports,
    presentation: nativeLibraryPresentation(semanticObservations),
    followCounts: nativeFollowCountRuntime(),
    preparationWork: options.preparationWork ?? previous?.preparationWork ?? createLibraryPreparationWork,
    scopeWork: options.scopeWork ?? previous?.scopeWork ?? nativeLibraryScopeWork,
  });
}

export { peekLibraryDomain, bindLibraryDomain, requireLibraryDomain, unbindLibraryDomain };
