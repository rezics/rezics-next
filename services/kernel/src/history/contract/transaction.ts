/**
 * Opaque native handles. The Kernel command runtime, the database pool and the Work client create these
 * values. History contracts name them without importing a driver or a foreign module; each native adapter
 * narrows a handle to its concrete type at the composition boundary.
 */
/** The command transaction handle: the native `query` surface. Assignable to and from the Kernel command type. */
export type HistoryTransaction = { query<R = any>(...args: any[]): Promise<any> };
export type HistoryPool = object;
export type HistoryWorkClient = object;
export type HistoryWorkContext = object;
/** A callback parameter compared bivariantly, so native callbacks with narrower handles still bind. */
export type HistoryCallback<Args extends unknown[], Result> = {
  bivarianceHack(...args: Args): Result;
}['bivarianceHack'];
/** A foreign owner's nominal value that History carries without reading it (for example a Semantic work token). */
export type HistoryHandle = object;
