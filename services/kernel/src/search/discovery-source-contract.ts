/** JSON-shaped continuation values are data only; policy validity and native evidence stay with each source. */
export type SerializableContinuation =
  | null
  | boolean
  | number
  | string
  | readonly SerializableContinuation[]
  | Readonly<Record<string, SerializableContinuation>>;

/** A source's page keeps output, resumability, coverage and freshness as separate observations. */
export type SourcePage<Item, Continuation extends SerializableContinuation, Coverage, Freshness> = Readonly<{
  items: readonly Item[];
  /** Null means exhausted. A non-null continuation must make bounded progress when resumed. */
  next: Continuation | null;
  /** Coverage describes this source's own admitted population, not permission to disclose its items. */
  coverage: Coverage;
  /** Freshness describes the source observation and is not a substitute for current native disclosure. */
  freshness: Freshness;
}>;

/** The admitted plan is supplied by the owning service; continuation carries no policy or native authority. */
export interface Source<Plan, Item, Continuation extends SerializableContinuation, Coverage, Freshness> {
  read(admittedPlan: Plan, continuation: Continuation | null): Promise<SourcePage<Item, Continuation, Coverage, Freshness>>;
}
