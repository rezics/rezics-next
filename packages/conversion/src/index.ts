import type { SourceClassificationProjection } from './source-classification.ts';

export type SourceId = 'bangumi' | 'vndb' | 'openlibrary' | 'wikidata';

export type SourceRecord<T = Record<string, unknown>> = {
  source: SourceId;
  key: string;
  revision: string | null;
  payload: T;
};

export type ConversionInput<T = unknown> = {
  external_id: string;
  record_revision: string | null;
  record: T;
};

export type ConversionDiagnostic = {
  pointer: string;
  code: string;
  sourceVocabularyGap?: import('./source-vocabulary.ts').SourceVocabularyGap;
};

export type {
  BangumiVocabularyRow,
  NativeIdentity,
  ResolvedConcept,
  ResolvedScheme,
  SourceRowOrigin,
  SourceVocabularyBindings,
  SourceVocabularyGap,
  SourceVocabularyInput,
  SourceVocabularyMetadata,
  SourceVocabularyProvider,
  SourceVocabularyRequest,
  SourceVocabularyResult,
  SourceVocabularyRow,
  VndbVocabularyRow,
} from './source-vocabulary.ts';

export type ConvertedRecord<Proposal = unknown> = {
  source: SourceId;
  external_id: string;
  record_revision: string | null;
  converter_revision: string;
  proposals: readonly Proposal[];
  diagnostics: readonly ConversionDiagnostic[];
  sourceClassification?: SourceClassificationProjection;
};

export { projectSourceClassification, validateSourceClassificationProjection } from './source-classification.ts';
export type {
  SourceClassificationCoverage,
  SourceClassificationProjection,
  SourceClassificationProvenance,
  SourceClassificationValue,
} from './source-classification.ts';

export class ConversionError extends Error {
  readonly code: string;
  readonly pointer: string;

  constructor(code: string, pointer: string) {
    super(code);
    this.name = 'ConversionError';
    this.code = code;
    this.pointer = pointer;
  }
}
