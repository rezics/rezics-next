/** Bounded native inputs consumed by Content's current shelf-title composition. */
export const SEMANTIC_TITLE_INPUT_MAX_ORIGINALS = 100;
export const SEMANTIC_TITLE_INPUT_MAX_BYTES = 1_048_576;

export type SemanticTitleInputEntry = Readonly<{
  /** The exact original requested by Content, even when its current identity resolves elsewhere. */
  subjectId: string;
  sourceId: string;
  /** Current identity epoch and terminal Subject revision, encoded as `epoch:revision`. */
  sourceBasis: string;
  labels: Readonly<Record<string, string>>;
  originalLanguage: string | null;
}>;

export type SemanticTitleInputsObservation =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'current'; basis: string; entries: readonly SemanticTitleInputEntry[] }>;

/** Empty subjects observes the same ID-independent whole-source basis and returns no entries. */
export type SemanticTitleInputs = Readonly<{
  observe(input: {
    subjects: readonly string[];
    deadline: number;
  }): Promise<SemanticTitleInputsObservation>;
}>;
