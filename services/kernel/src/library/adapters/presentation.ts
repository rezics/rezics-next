import { createNativeBuiltinRuntime, readNativeBuiltinOriginalInputs } from './builtin-runtime.ts';
import type { Pool, PoolClient } from 'pg';
import type { Access, Actor, AccessContext } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import type { KernelClock } from '../../clock.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import type { ContributionAttribution } from '../../access/contract/index.ts';
import type { SubjectSummary, IdentityMapping } from '../../semantic/contract/index.ts';
import type {
  LibrarySemanticObservationCapability,
  LibrarySemanticSummaryObservation,
} from '../contract/semantic-observation.ts';
import { consumeFollowWork } from '../follow-operation-bounds.ts';
import { semanticObservationBound } from '../semantic-observation.ts';
import type { createResourcePublicEligibility } from '../../access/adapters/index.ts';
import { currentCommandWorkAssociation } from '../../command/work-context.ts';
import { ProblemError } from '../../http/problem-error.ts';
import {
  createBuiltinOwnerAdmission,
  createLibraryPresentationApplication,
  createSubjectAnchorApplication,
  createSubjectPresentationApplication,
} from '../application/index.ts';
import type {
  CurrentAccountEligibilityCapability,
  CurrentObservation,
  LibraryAccountSummary,
  LibraryTargetSummary,
  FollowingSpaceProjection,
  LibraryCursorCapability,
  SubjectIdentityCapability,
  SubjectReferenceObservation,
  WorkDimensions,
} from '../contract/index.ts';
import { createCollectionReads } from '../collection-reads.ts';
import { readNativeFullMembers } from './presentation-members.ts';

export type LibraryPresentationDependencies = {
  routeKey: Uint8Array;
  pool: Pool;
  access: Access;
  tokens: KeyRing;
  clock?: KernelClock;
};
export type LibraryIdentityContext = {
  pool: Pool;
  access: Access;
  actor: Actor;
  context: AccessContext;
  at?: AuthoritativeTime;
};
type SummaryContext = {
  pool: Pool;
  routeKey: Uint8Array;
  access: Access;
  actor: Actor;
  deadline: number;
  work?: AccessWorkAccounting;
};

/** Composition supplies real foreign adapters; this host owns no producer implementation or fallback. */
export type NativeLibraryPresentationPorts = {
  semanticObservations: LibrarySemanticObservationCapability;
  cursors: LibraryCursorCapability<KeyRing>;
  identity: SubjectIdentityCapability<
    LibraryIdentityContext,
    IdentityMapping,
    SubjectReferenceObservation & Readonly<{ work: WorkDimensions }>
  >;
  readMappings(
    pool: Pool,
    ids: readonly string[],
  ): Promise<
    import('../contract/semantic-observation.ts').LibrarySemanticObservationResult<readonly IdentityMapping[]>
  >;
  accountEligibility: CurrentAccountEligibilityCapability<Pick<PoolClient, 'query'>>;
  createResourcePublicEligibility: typeof createResourcePublicEligibility;
  observeSubjects(
    context: SummaryContext,
    ids: readonly string[],
  ): Promise<
    import('../contract/semantic-observation.ts').LibrarySemanticObservationResult<LibrarySemanticSummaryObservation>
  >;
  observeAccount(pool: Pool, id: string, deadline: number): Promise<CurrentObservation<LibraryAccountSummary | null>>;
  observeAttributions(
    pool: Pool,
    ids: readonly string[],
    deadline: number,
  ): Promise<CurrentObservation<ReadonlyMap<string, ContributionAttribution>>>;
  observeSpace(
    deps: { pool: Pool; access: Access; clock?: KernelClock },
    actor: Actor,
    id: string,
    type: string,
    deadline: number,
    work?: AccessWorkAccounting,
  ): Promise<CurrentObservation<LibraryTargetSummary | null>>;
};

export function createNativeLibraryPresentation(ports: NativeLibraryPresentationPorts) {
  const identity: NativeLibraryPresentationPorts['identity'] = {
    ...ports.identity,
    async readMappings(context, ids) {
      const observed = await consumeFollowWork(
        'identity.mapping',
        semanticObservationBound(ports.semanticObservations.follow.mappingWork(ids)),
        () => ports.semanticObservations.follow.readMappings(context.pool, ids),
        (result) => semanticObservationBound(result.work),
      );
      return observed.value as readonly IdentityMapping[];
    },
    async prepareReference(context, id) {
      const read = await ports.identity.prepareReference(context, id);
      return async () => {
        const observed = await consumeFollowWork(
          'identity.reference',
          semanticObservationBound(ports.semanticObservations.follow.subjectReferenceWork(id)),
          read,
          (result) => semanticObservationBound(result.work),
        );
        return observed;
      };
    },
  };
  async function observeSubjects(context: SummaryContext, ids: readonly string[]) {
    const observed = await consumeFollowWork(
      'identity.summary',
      semanticObservationBound(ports.semanticObservations.follow.subjectSummaryWork(ids)),
      () => ports.observeSubjects(context, ids),
      (result) => semanticObservationBound(result.work),
    );
    return {
      summaries: observed.value.summaries as ReadonlyMap<string, SubjectSummary | null>,
      current: async () => {
        const current = await consumeFollowWork(
          'identity.summary.current',
          semanticObservationBound(ports.semanticObservations.follow.subjectSummaryCurrentWork(ids)),
          () => observed.value.current(),
          (result) => semanticObservationBound(result.work),
        );
        return current.value;
      },
    };
  }
  const readMappings = async (pool: Pool, ids: readonly string[]) => {
    const observed = await consumeFollowWork(
      'identity.mapping',
      semanticObservationBound(ports.semanticObservations.follow.mappingWork(ids)),
      () => ports.readMappings(pool, ids),
      (result) => semanticObservationBound(result.work),
    );
    return observed.value;
  };
  return {
    semanticObservations: ports.semanticObservations,
    builtins: (config: Parameters<typeof createNativeBuiltinRuntime>[1]) => createNativeBuiltinRuntime(ports, config),
    builtinOriginalInputs: (pool: Pool, accountId: string, after: string | null, limit: number) =>
      readNativeBuiltinOriginalInputs(ports, pool, accountId, after, limit),
    identity: createSubjectAnchorApplication(identity),
    readMappings,
    admitOwner: createBuiltinOwnerAdmission(ports.accountEligibility),
    fullMembers(
      deps: LibraryPresentationDependencies,
      actor: Actor,
      id: string,
      options: { cursor?: string; limit?: number; languages?: readonly string[] },
      deadline: number,
    ) {
      return readNativeFullMembers(deps, ports, actor, id, options, deadline);
    },
    fullView<T>(
      deps: LibraryPresentationDependencies,
      actor: Actor,
      view: string | undefined,
      body: T,
      options: {
        deadline: number;
        follow?: true;
        withholdChangedSource?: true;
        nativeFollowTargets?: readonly import('../contract/index.ts').NativeFollowTargetAdapter[];
        followingSpaces?: (
          actor: Actor,
          ids: readonly string[],
          deadline: number,
        ) => Promise<ReadonlyMap<string, FollowingSpaceProjection>>;
      },
    ) {
      const { deadline } = options;
      const work = currentCommandWorkAssociation()?.access;
      const context = { ...deps, actor, deadline, ...(work ? { work } : {}) };
      const unavailable = () => new ProblemError('dependency_unavailable');
      const withholdChangedSource = options.follow === true || options.withholdChangedSource === true;
      const subjects = createSubjectPresentationApplication(ports.identity, {
        observe: (ids) => observeSubjects(context, ids),
        unavailable,
      });
      const full = createLibraryPresentationApplication<SubjectSummary, ContributionAttribution>({
        subjects: (ids) => subjects({ ...context, context }, ids, withholdChangedSource),
        account: (id) => ports.observeAccount(deps.pool, id, deadline),
        attributions: (ids) => ports.observeAttributions(deps.pool, ids, deadline),
        async target(id, type) {
          if (type !== 'collection')
            return ports.observeSpace(deps, actor, id, type, deadline, options.follow ? work : undefined);
          const reads = createCollectionReads(deps);
          async function read() {
            try {
              const value = options.follow
                ? await reads.readCollectionSummary(actor, id, deadline, work)
                : await reads.readCollection(actor, id, deadline);
              return value.title === null ? null : { id, type, label: value.title };
            } catch (error) {
              if (error instanceof ProblemError && error.code === 'not_found') return null;
              throw error;
            }
          }
          const value = await read();
          return { value, current: async () => JSON.stringify(await read()) === JSON.stringify(value) };
        },
        unavailable,
      });
      return full(view, body, {
        withholdChangedSource,
        ...(options.nativeFollowTargets
          ? { nativeFollowTargets: { adapters: options.nativeFollowTargets, actor, deadline } }
          : {}),
        ...(options.followingSpaces
          ? {
              followingSpaces: (ids: readonly string[]) => options.followingSpaces!(actor, ids, deadline),
            }
          : {}),
      });
    },
  };
}

export type NativeLibraryPresentation = ReturnType<typeof createNativeLibraryPresentation>;
