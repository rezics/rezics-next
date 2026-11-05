/** Mounted personal-list additions while whole-Kernel declaration emission is pending.
 * Kernel's list-import-vndb routes remain the wire authority. No runtime client is replaced.
 */
export type VndbProgressSelection = {
  occurrence: { kind: 'existing'; sessionId: string } | { kind: 'start'; primaryUnit: string };
  measures: { field: string; action: 'adopt' | 'clear'; replace?: boolean }[];
};
export type VndbProgressResult = {
  occurrence: { sessionId: string; startedAt: string; transactionId: string; revision: number } | null;
  complete: boolean;
  measures: {
    field: string;
    unit: string | null;
    action: 'adopt' | 'clear';
    status:
      | 'applied'
      | 'cleared'
      | 'preserved'
      | 'missing'
      | 'unknown'
      | 'invalid'
      | 'unsupported'
      | 'stale'
      | 'failed'
      | 'unattempted';
    sourceAmount: string | null;
    currentAmount: string | null;
    reason: string | null;
  }[];
  readback: {
    sessionId: string;
    startedAt: string;
    transactionId: string;
    revision: number;
    state: string;
    mode: string;
    unit: string;
    amount: string | null;
    measures: { unit: string; amount: string | null }[];
  } | null;
};

type Method = (...args: never[]) => Promise<{ data: unknown }>;
type Data<M extends Method> = NonNullable<Awaited<ReturnType<M>>['data']>;
type Read<M extends Method, T> = Omit<Awaited<ReturnType<M>>, 'data'> & { data: T | null };
type Options<M extends Method, N extends number> = Parameters<M>[N] & { headers?: Record<string, string> };
type StateDecision<D> = D extends { state: unknown; action: infer A }
  ? Omit<D, 'action'> & { action: A | 'progress'; progress?: VndbProgressResult | null }
  : D;
type ScoreDecision<D> = D extends { nativeAdmission: unknown; status: infer S }
  ? Omit<D, 'nativeAdmission' | 'status'> & { nativeAdmission: 'conditional'; status: S | 'applying' }
  : D;
type ReviewInput<B> = B extends { action: 'state' } ? B & { progress?: VndbProgressSelection } : B;
type ProgressChoice = { ordinal: number; action: 'progress'; targetId?: string; progress: VndbProgressSelection };
type NativeScore<S> = S extends { admission: { reason: infer Reason } }
  ? Omit<S, 'admission'> & {
      admission: {
        status: 'conditional' | 'unavailable';
        reason: Exclude<Reason, 'conditional-admission-unavailable'> | null;
      };
    }
  : S;
type Row<R> = R extends { decision: infer D; scoreDecision: infer S; nativeScore: infer N }
  ? Omit<R, 'decision' | 'scoreDecision' | 'nativeScore'> & {
      decision: StateDecision<D>;
      scoreDecision: ScoreDecision<S>;
      nativeScore: NativeScore<N>;
    }
  : R;
type Page<P> = P extends { rows: (infer R)[] } ? Omit<P, 'rows'> & { rows: Row<R>[] } : P;
type Review<R> = StateDecision<ScoreDecision<R>>;
type Applied<A> = A extends { outcomes: (infer O)[] }
  ? Omit<A, 'outcomes'> & { outcomes: (O & { progress?: VndbProgressResult | null })[] }
  : A;

type Path = { get: Method; $review: { post: Method }; $apply: { post: Method } };
type BoundPath<P extends Path> = Omit<P, 'get' | '$review' | '$apply'> & {
  get(options?: Options<P['get'], 0>): Promise<Read<P['get'], Page<Data<P['get']>>>>;
  $review: {
    post(
      body: ReviewInput<Parameters<P['$review']['post']>[0]> | ProgressChoice,
      options: Options<P['$review']['post'], 1>,
    ): Promise<Read<P['$review']['post'], Review<Data<P['$review']['post']>>>>;
  };
  $apply: {
    post(
      body: Parameters<P['$apply']['post']>[0],
      options?: Options<P['$apply']['post'], 1>,
    ): Promise<Read<P['$apply']['post'], Applied<Data<P['$apply']['post']>>>>;
  };
};
type VndbSurface = (...args: never[]) => Path;
type HasProgress<S extends VndbSurface> = Extract<
  Parameters<ReturnType<S>['$review']['post']>[0],
  { action: 'progress' }
>;
type BoundSurface<S extends VndbSurface> = [HasProgress<S>] extends [never]
  ? Omit<S, keyof Function> & ((...args: Parameters<S>) => BoundPath<ReturnType<S>>)
  : S;

/** Yield to the generated route once it publishes the combined Progress and vote contract. */
export type PersonalVndbImports<C extends { vndb: VndbSurface }> = Omit<C, 'vndb'> & { vndb: BoundSurface<C['vndb']> };
