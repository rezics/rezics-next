/** Content consumes exact observations, never publication-derived authority. */
export const REALM_SUBJECT_DISCLOSURE_BATCH = 8;
export const REALM_SUBJECT_DISCLOSURE_FRESH_MS = 1000;
export type RealmSubjectCandidate = Readonly<{ threadId: string; openingPostId: string; subjectId: string }>;
export type RealmSubjectDisclosureInput = Readonly<{ realmId: string; candidates: readonly RealmSubjectCandidate[] }>;
export type RealmObservation<A> = Readonly<{ signature: string; anchors: readonly A[] }>;
export type RealmSubjectEvidence<A> =
  | Readonly<{
      state: 'positive';
      freshness: Readonly<{ before: string; final: string; expiresAt: number; anchors: readonly A[] }>;
    }>
  | Readonly<{ state: 'absent' | 'withheld' | 'unknown' }>;
export type RealmPreparedDisclosure<A> = Readonly<{ finish(): Promise<readonly RealmSubjectEvidence<A>[]> }>;
export type RealmPreparedThread<A> = Readonly<{
  state: 'positive' | 'absent' | 'withheld';
  signature: string | null;
  final(): Promise<RealmObservation<A> | null>;
}>;
export type RealmDisclosureContext = Readonly<{
  deadline: number;
  work: { readonly deadline: number; unavailable(dependency: string): never };
}>;
export type RealmDisclosurePorts<D, C extends RealmDisclosureContext, A> = Readonly<{
  now(): number;
  hash(value: unknown): string;
  principal(context: C): string;
  deadline(deadline: number): void;
  validate(input: RealmSubjectDisclosureInput): RealmSubjectDisclosureInput;
  failure(error: unknown): 'withheld' | 'unknown';
  parent(dependencies: D, realm: string, context: C): Promise<RealmObservation<A> | null>;
  subject(dependencies: D, subject: string, context: C): Promise<RealmObservation<A> | null>;
  thread(dependencies: D, candidate: RealmSubjectCandidate, realm: string, context: C): Promise<RealmPreparedThread<A>>;
  sameHome(before: RealmObservation<A>, after: RealmObservation<A>): boolean;
}>;
export type RealmWork = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  identityMetadataRows: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys: number;
  statements: number;
  bytes: number;
}>;
export type RealmSearchCandidate = Readonly<{ thread: string; opening: string; terminal: string | null }>;
export type RealmMembership = 'discussed' | 'not_published' | 'withheld' | 'unknown';
export type RealmSearchDisclosure<R, W> = {
  readonly bounds: Readonly<Record<'resolve' | 'current' | 'candidate' | 'subject', RealmWork>>;
  resolve(
    realm: string,
    context: { reader: R; work: W },
  ): Promise<{ state: 'ready'; dependency: string } | { state: 'concealed' | 'unavailable' }>;
  current(
    realm: string,
    dependency: string,
    context: { reader: R; work: W },
  ): Promise<'current' | 'changed' | 'concealed' | 'unavailable'>;
  candidate(
    candidate: RealmSearchCandidate,
    dependency: string,
    context: { reader: R; work: W },
  ): Promise<RealmMembership>;
  candidates(
    candidates: readonly RealmSearchCandidate[],
    dependency: string,
    context: { reader: R; work: W },
  ): Promise<readonly RealmMembership[]>;
  subject(
    subject: string,
    dependency: string,
    context: { reader: R; work: W },
  ): Promise<{ state: 'readable'; terminal: string } | { state: 'withheld' | 'unknown' }>;
};
export type RealmSearchPorts<P, R, W, D, C extends RealmDisclosureContext, S> = Readonly<{
  /** Missing independent reader authority is unavailable, including actorless work. */
  reader(pool: P, reader: R): D | undefined;
  withWork<T>(reader: R, work: W, maximum: RealmWork, run: (context: C) => Promise<T>): Promise<T>;
  dependency(realm: string, signature: string, ordinal: number): string;
  failure(error: unknown): 'unavailable' | 'concealed' | undefined;
  source(pool: P, disclosure: RealmSearchDisclosure<R, W>): S;
}>;
export type RealmCommunityBoard = Readonly<{
  id: string;
  realmId: string | null;
  securityRevision: string;
  availability: string;
}>;
export type RealmCommunityThread = Readonly<{ id: string; boardId: string; securityRevision: string }>;
export type RealmCommunitySelection =
  | Readonly<{ status: 'withheld'; reason: string }>
  | Readonly<{
      status: 'current';
      threadId: string;
      witness: Readonly<{
        boardId: string;
        realmId: string | null;
        threadSecurityRevision: string;
        boardSecurityRevision: string;
      }>;
    }>;
export type RealmRecent<T, M> = Readonly<{
  state: 'current';
  complete: boolean;
  threads: readonly Readonly<{
    thread: T;
    target: Readonly<{ kind: 'thread'; id: string; boardId: string }>;
    comments: M | { state: 'unavailable' };
  }>[];
}>;
export type RealmCommunityPorts<
  D,
  C,
  B extends RealmCommunityBoard,
  T extends RealmCommunityThread,
  M,
  S extends RealmCommunitySelection,
> = Readonly<{
  recent(
    dependencies: D,
    board: string,
    context: C,
  ): Promise<{ threads: readonly T[]; complete: boolean; current(): Promise<boolean> }>;
  activity(dependencies: D): {
    select(ids: readonly string[], context: C): Promise<readonly S[]>;
    confirm(selected: readonly S[], context: C): Promise<readonly S[]>;
  };
  comments(ids: readonly string[], selected: readonly S[], context: C): ReadonlyMap<string, M>;
  same(before: ReadonlyMap<string, M>, after: ReadonlyMap<string, M>): boolean;
  unavailable(): never;
}>;
