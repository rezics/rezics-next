export const SEMANTIC_TITLE_PROVENANCE_MAX_BYTES = 1_048_576;

/** Exact Semantic support for each current Library title input. */
export type SemanticTitleProvenanceOrigin =
  | Readonly<{ kind: 'native' }>
  | Readonly<{ kind: 'agent'; subject: string }>
  | Readonly<{
      kind: 'imported';
      route: number;
      source: string;
      external_id: string;
      field_group: 'facts' | 'summary' | 'cover';
    }>;

export type SemanticTitleProvenanceSupport =
  | Readonly<{ kind: 'term'; revision: number; slot: string; sequence: number }>
  | Readonly<{ kind: 'statement'; revision: number; candidate: string }>;

export type SemanticTitleFieldBinding = Readonly<{
  value: string;
  origin: SemanticTitleProvenanceOrigin;
  support: SemanticTitleProvenanceSupport;
}>;

export type SemanticTitleProvenanceEntry = Readonly<{
  /** Exact original key supplied by Content. */
  subjectId: string;
  /** Current one-hop terminal and the identity/revision evidence from the title observer. */
  source: Readonly<{ subjectId: string; identityEpoch: string; terminalRevision: number }>;
  sourceBasis: string;
  labels: Readonly<Record<string, SemanticTitleFieldBinding>>;
  originalLanguage: SemanticTitleFieldBinding | null;
}>;

export type SemanticTitleProvenanceObservation =
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'current'; basis: string; entries: readonly SemanticTitleProvenanceEntry[] }>;

/** Empty subjects observes the same whole-source basis with no field bindings. */
export type SemanticTitleProvenance = Readonly<{
  observe(input: { subjects: readonly string[]; deadline: number }): Promise<SemanticTitleProvenanceObservation>;
}>;
