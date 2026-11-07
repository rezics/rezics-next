/** Independent current Realm/Space binding and read evidence, never publication ownership. */
export type ScopeEvidenceObservation<A> = Readonly<{ signature: string; anchors: readonly A[] }>;
export type ScopeEvidenceHost<D, C, Client, A> = Readonly<{
  hash(value: unknown): string;
  snapshot<T>(
    dependencies: D,
    id: string,
    context: C,
    run: (client: Client) => Promise<T>,
  ): Promise<{ value: T; anchor: A }>;
  point<I extends Record<string, unknown>, R extends Record<string, unknown>>(
    client: Client,
    operation: string,
    statement: { sql: string; params: readonly string[]; '~reylo': { input: I; element: R } },
    input: I,
    keys?: number,
  ): Promise<R | null>;
  time(client: Client): Promise<string>;
}>;
