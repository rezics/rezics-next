export type PersonalEntryFieldChange<T> =
  | Readonly<{ op: 'unchanged' }>
  | Readonly<{ op: 'clear' }>
  | Readonly<{ op: 'set'; value: T }>;

export type PersonalEntryPrivacyValue =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{ status: 'known'; meaning: 'private' | 'source_visible' }>;
export type PersonalEntryPrivacy = PersonalEntryPrivacyValue | Readonly<{ status: 'cleared' }>;
export type PersonalEntryTimestampInput =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{ status: 'known'; value: string }>;
export type PersonalEntryTimestampValue =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'unknown'; sourceValue?: string }>
  | Readonly<{
      status: 'known';
      value: string;
      precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
      zone: 'utc' | 'offset' | 'unknown';
    }>;
export type PersonalEntryTimestamp = PersonalEntryTimestampValue | Readonly<{ status: 'cleared' }>;

export type PersonalEntryObservation = Readonly<{
  provider: string;
  recordId: string;
  revision: number;
  privacy: PersonalEntryPrivacy;
  sourceCreated: PersonalEntryTimestamp;
  sourceUpdated: PersonalEntryTimestamp;
  recordedAt: string;
}>;
export type PersonalEntry = Readonly<{
  subjectId: string;
  annotationRevision: number;
  note: string | null;
  priority: number | null;
  annotationUpdatedAt: string | null;
  sourceObservations: readonly PersonalEntryObservation[];
}>;

export type PersonalEntryGuard = Readonly<{ incarnationId: string; currentRevision: number }>;
export type PersonalEntryAnnotationWrite = Readonly<{
  revision: number;
  note: PersonalEntryFieldChange<string>;
  priority: PersonalEntryFieldChange<number>;
  /** Binds a correction to one existing entry incarnation and current revision. */
  entryGuard?: PersonalEntryGuard;
}>;
export type PersonalEntrySourceAdmission = Readonly<{
  provider: string;
  recordId: string;
  confirmReviewed: true;
  privacy: PersonalEntryPrivacyValue;
  sourceCreated: PersonalEntryTimestampInput;
  sourceUpdated: PersonalEntryTimestampInput;
}>;
export type PersonalEntrySourceCorrection = Readonly<{
  provider: string;
  recordId: string;
  revision: number;
  confirmReviewed: true;
  privacy: PersonalEntryFieldChange<PersonalEntryPrivacyValue>;
  sourceCreated: PersonalEntryFieldChange<PersonalEntryTimestampInput>;
  sourceUpdated: PersonalEntryFieldChange<PersonalEntryTimestampInput>;
}>;
