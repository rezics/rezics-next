/** A read's outcome held until the sequential check that owns it. Reads run
 * together, yet each failure surfaces at its original step: the error a
 * serial read would report, and an item that drops where it dropped. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

export const settle = <T>(promise: Promise<T>): Promise<Settled<T>> =>
  promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

export function unwrap<T>(result: Settled<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Start every read now; the returned values unwrap in argument order. */
export async function inOrder<T extends readonly unknown[]>(
  ...reads: { [K in keyof T]: T[K] | Promise<T[K]> }): Promise<T> {
  const settled = await Promise.all(reads.map(read => settle(Promise.resolve(read))));
  return settled.map(result => unwrap(result)) as unknown as T;
}
