import type {
  PersonalEntry,
  PersonalEntryAnnotationWrite,
  PersonalEntryPrivacyValue,
  PersonalEntrySourceAdmission,
  PersonalEntrySourceCorrection,
  PersonalEntryTimestampInput,
} from './entry-personal-model.ts';

export declare const ENTRY_IMPORT_METADATA_LIMITS: {
  readonly fields: 5;
  readonly reviewsPerRow: 2;
  readonly requestBytes: 2048;
  readonly reviewBytes: 32768;
  readonly rowBytes: 65536;
  readonly noteBytes: 4096;
  readonly privacyValueBytes: 192;
  readonly timestampBytes: 64;
  readonly responseBytes: 65536;
};

export type EntryImportMetadataField = 'note' | 'priority' | 'privacy' | 'sourceCreated' | 'sourceUpdated';
export type EntryImportMetadataProposal = Readonly<{
  state: 'value' | 'absent' | 'unknown' | 'empty' | 'invalid' | 'unsupported';
  sourceField: string | null;
  value?: string | number | PersonalEntryPrivacyValue | PersonalEntryTimestampInput;
  sourceValue?: string | number | boolean | null;
  mapping?: Readonly<{ id: string; label: string }>;
  reason?: string;
}>;
export type EntryImportMetadataProposals = Readonly<Record<EntryImportMetadataField, EntryImportMetadataProposal>>;
export type EntryImportMetadataSelection = Readonly<{
  field: EntryImportMetadataField;
  action: 'adopt' | 'clear';
  mapping?: string;
}>;
export type EntryImportMetadataFieldOutcome = Readonly<{
  field: EntryImportMetadataField;
  status: 'applied' | 'stale' | 'unsupported' | 'unattempted' | 'failed';
  reason?: string;
}>;
export type EntryImportMetadataOutcome = Readonly<{
  reviewToken: string;
  fields: readonly EntryImportMetadataFieldOutcome[];
}>;
export type EntryImportMetadataReview = Readonly<{
  token: string;
  requestDigest: string;
  sourceReviewToken: string;
  subjectId: string;
  clientId: string;
  requestedBy: string | null;
  annotationRevision: number;
  personalDigest: string;
  sourceDigest: string;
  profileDigest: string;
  incarnationId: string | null;
  confirmation?: Readonly<{
    fields: readonly EntryImportMetadataSelection[];
    selectionDigest: string;
    annotationKey: string;
    provenanceKey: string;
    annotationStarted: boolean;
    provenanceStarted: boolean;
    annotationStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
    provenanceStatus?: 'applied' | 'stale' | 'unsupported' | 'unattempted';
    annotationInput?: PersonalEntryAnnotationWrite & Readonly<{
      effect: boolean;
      expectedRevision: number;
      expectedNote: string | null;
      expectedPriority: number | null;
    }>;
    provenanceInput?: Readonly<{
      kind: 'admit';
      effect: true;
      value: PersonalEntrySourceAdmission;
    } | {
      kind: 'correct';
      effect: boolean;
      value: PersonalEntrySourceCorrection;
    }>;
    sourceObservationDigest?: string;
    outcome?: EntryImportMetadataOutcome;
  }>;
}>;
export type EntryImportMetadataView = Readonly<{
  status: 'current' | 'stale';
  reviewToken: string;
  sourceReviewToken: string;
  subjectId: string;
  personal: PersonalEntry;
  proposals: EntryImportMetadataProposals;
  outcome: EntryImportMetadataOutcome | null;
}>;

export type EntryImportMetadataReviewRequest = Readonly<{
  ordinal: number;
  sourceReviewToken: string;
}>;
export type EntryImportMetadataReviewResult = Readonly<{
  reviewToken: string;
}>;
export type EntryImportMetadataApplyRequest = Readonly<{
  ordinal: number;
  reviewToken: string;
  fields: readonly EntryImportMetadataSelection[];
}>;
export type BangumiMetadataReviewRequest = EntryImportMetadataReviewRequest;
export type BangumiMetadataReviewResult = EntryImportMetadataReviewResult & Readonly<{ ordinal: number }>;
export type VndbMetadataReviewRequest = EntryImportMetadataReviewRequest;
export type VndbMetadataReviewResult = EntryImportMetadataReviewResult & Readonly<{ ordinal: number }>;
export type AniListMetadataReviewRequest = EntryImportMetadataReviewRequest;
export type AniListMetadataReviewResult = EntryImportMetadataReviewResult & Readonly<{ ordinal: number }>;
export type MalMetadataReviewRequest = Readonly<{ row: number; sourceReviewToken: string }>;
export type MalMetadataReviewResult = EntryImportMetadataReviewResult & Readonly<{ id: string }>;
export type MalMetadataApplyRequest = Readonly<{
  row: number;
  reviewToken: string;
  fields: readonly EntryImportMetadataSelection[];
}>;
