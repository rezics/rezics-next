import { createNativeBuiltinRuntime, readNativeBuiltinOriginalInputs } from './builtin-runtime.ts';
import type { Pool, PoolClient } from 'pg';
import type { Access, Actor, AccessContext } from '../../request/access.ts';
import type { AccessWorkAccounting } from '../../access/work.ts';
import type { KernelClock } from '../../clock.ts';
import type { AuthoritativeTime } from '../../command/command.ts';
import type { KeyRing } from '../../tokens/seal.ts';
import type { ContributionAttribution } from '../../access/contract/index.ts';
import type { SubjectSummary, IdentityMapping } from '../../semantic/contract/index.ts';
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
  SubjectIdentityCapability,
  FollowingSpaceProjection,
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
  identity: SubjectIdentityCapability<LibraryIdentityContext, IdentityMapping>;
  readMappings(pool: Pool, ids: readonly string[]): Promise<readonly IdentityMapping[]>;
  accountEligibility: CurrentAccountEligibilityCapability<Pick<PoolClient, 'query'>>;
  createResourcePublicEligibility: typeof createResourcePublicEligibility;
  observeSubjects(
    context: SummaryContext,
    ids: readonly string[],
  ): Promise<{
    summaries: ReadonlyMap<string, SubjectSummary | null>;
    current(): Promise<boolean>;
  }>;
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
  return {
    builtins: (config: Parameters<typeof createNativeBuiltinRuntime>[1]) => createNativeBuiltinRuntime(ports, config),
    builtinOriginalInputs: (pool: Pool, accountId: string, after: string | null, limit: number) =>
      readNativeBuiltinOriginalInputs(ports, pool, accountId, after, limit),
    identity: createSubjectAnchorApplication(ports.identity),
    readMappings: ports.readMappings,
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
        observe: (ids) => ports.observeSubjects(context, ids),
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
