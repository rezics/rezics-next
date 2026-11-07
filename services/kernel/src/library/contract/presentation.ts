import type { GrantedAccount, LibraryActor, LibraryAccountActor } from './actors.ts';

/** A caller owns one bounded neighbourhood, including duplicate stored occurrences. */
export const LIBRARY_SUBJECT_PAGE_LIMIT = 100;
export const LIBRARY_PRESENTATION_CONCURRENCY = 4;

export type ResolvedSubject = { subjectId: string; requestedSubjectId: string | null };
export type SubjectIdentityObservation =
  | Readonly<{ state: 'mapped'; terminal: string; epoch: bigint }>
  | Readonly<{ state: 'absent' | 'pending' }>
  | Readonly<{ state: 'unavailable'; reason: 'bootstrap' | 'missing-owner' | 'moved-owner' }>;
export type SubjectReferenceObservation =
  | Readonly<{ state: 'present' | 'absent' }>
  | Readonly<{ state: 'redirect'; from: string; to: string }>;

export class SubjectIdentityUnavailableError extends Error {
  constructor(public readonly reason: 'bootstrap' | 'missing-owner' | 'moved-owner') {
    super(`Current subject identity is unavailable: ${reason}`);
  }
}

/** Mapping is only a hint. Both original and terminal retain their native authorization. */
export interface SubjectIdentityCapability<
  Context,
  Mapping extends SubjectIdentityObservation,
  Reference extends SubjectReferenceObservation = SubjectReferenceObservation,
> {
  validId(id: string): boolean;
  redirected(from: string, to: string): Error;
  readMappings(context: Context, ids: readonly string[]): Promise<readonly Mapping[]>;
  prepareReference(context: Context, id: string): Promise<() => Promise<Reference>>;
}

export type CurrentObservation<Value> = Readonly<{ value: Value; current(): Promise<boolean> }>;
export type LibraryAccountSummary = { id: string; handle: string | null; displayName: string | null };
export type LibraryTargetSummary = { id: string; type: string; label: string };

/** Concrete disclosed vocabulary is supplied by its producer, never copied into Library's contract. */
export interface LibraryPresentationCapability<Summary, Attribution> {
  subjects(ids: readonly string[]): Promise<CurrentObservation<ReadonlyMap<string, Summary | null>>>;
  account(id: string): Promise<CurrentObservation<LibraryAccountSummary | null>>;
  attributions(ids: readonly string[]): Promise<CurrentObservation<ReadonlyMap<string, Attribution>>>;
  target(id: string, type: string): Promise<CurrentObservation<LibraryTargetSummary | null>>;
  unavailable(): Error;
}

export interface SubjectPresentationCapability<Summary> {
  observe(ids: readonly string[]): Promise<
    Readonly<{
      summaries: ReadonlyMap<string, Summary | null>;
      current(): Promise<boolean>;
    }>
  >;
  unavailable(): Error;
}

export interface CurrentAccountEligibilityCapability<Client> {
  routeOf(id: string): number | null;
  readAccount(client: Client, route: number, id: string): Promise<GrantedAccount | null>;
}

export type BuiltinReadScope = 'collection:read' | 'collection:update' | 'collection:delete';
export type BuiltinOwnerAdmission<Client> = (
  client: Client,
  actor: LibraryActor,
  scope?: BuiltinReadScope,
) => Promise<LibraryAccountActor | null>;

export type FollowingSpaceDestination =
  | Readonly<{ kind: 'space'; spaceId: string; address: string }>
  | Readonly<{ kind: 'realm'; realmId: string }>
  | Readonly<{ kind: 'unavailable' }>;
export type FollowingSpaceActions =
  | Readonly<{
      status: 'available';
      resourceType: 'community.space' | 'community.realm';
      resourceId: string;
      viewerActions: Readonly<{ action: string; operations: string[] }>[];
    }>
  | Readonly<{ status: 'unavailable' }>;
export type FollowingSpaceProjection = Readonly<{
  target: Readonly<{ id: string; type: 'space'; label: string }> | null;
  destination: FollowingSpaceDestination;
  actions: FollowingSpaceActions;
}>;

export type LibraryEmbedding<T, Summary, Attribution> = T extends readonly (infer R)[]
  ? LibraryEmbedding<R, Summary, Attribution>[]
  : T extends object
    ? { [K in keyof T]: LibraryEmbedding<T[K], Summary, Attribution> } & (T extends { subjectId: string }
        ? { subject?: Summary | null }
        : object) &
        (T extends { versionSubjectId: string | null } ? { versionSubject?: Summary | null } : object) &
        (T extends { curatorAccountId: string } ? { curator?: LibraryAccountSummary | null } : object) &
        (T extends { accountId: string }
          ? { account?: LibraryAccountSummary | null; attribution?: Attribution | null }
          : object) &
        (T extends { targetId: string } ? { target?: Summary | LibraryTargetSummary | null } : object) &
        (T extends { targetId: string; targetType: string }
          ? { destination?: FollowingSpaceDestination; actions?: FollowingSpaceActions }
          : object)
    : T;
