/** Run independent reads with bounded concurrency while retaining input order.
 * A failed operation or before-dispatch check stops queued work immediately;
 * already-started operations settle before the original failure is rethrown. */
export declare function boundedReadWindow<T, R>(values: readonly T[], concurrency: number, work: (value: T, index: number) => Promise<R>, beforeDispatch?: () => void): Promise<R[]>;
