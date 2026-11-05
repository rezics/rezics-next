export type EntryAnnotationCorrectionOperation<T> =
  | Readonly<{ op: 'preserve' }>
  | Readonly<{ op: 'clear' }>
  | Readonly<{ op: 'set'; value: T }>;

export type EntryAnnotationCorrectionSelection = Readonly<{
  subjectId: string;
  incarnationId: string;
  currentRevision: number;
  note: EntryAnnotationCorrectionOperation<string>;
  priority: EntryAnnotationCorrectionOperation<number>;
}>;

export type EntryAnnotationCorrectionInput = Readonly<{
  items: readonly EntryAnnotationCorrectionSelection[];
}>;

export type EntryAnnotationCorrectionItem = Readonly<{
  selected: Readonly<{ subjectId: string; incarnationId: string; currentRevision: number }>;
  eligibility: 'ready' | 'stale' | 'unavailable';
  current: Readonly<{ annotationRevision: number; note: string | null; priority: number | null }> | null;
  operation: Readonly<{
    note: EntryAnnotationCorrectionOperation<string>;
    priority: EntryAnnotationCorrectionOperation<number>;
  }> | null;
  outcome: 'accepted' | 'unchanged' | 'stale' | 'unavailable' | 'not-started';
}>;

export type EntryAnnotationCorrectionPage = Readonly<{
  reviewId: string;
  epoch: string;
  state: 'open' | 'confirmed' | 'cancelled' | 'expired';
  createdAt: string;
  expiresAt: string;
  total: number;
  page: number;
  pageCount: number;
  nextPage: number | null;
  items: readonly EntryAnnotationCorrectionItem[];
}>;

export type EntryAnnotationCorrectionCancelResult = Readonly<{
  reviewId: string;
  epoch: string;
  state: 'open' | 'confirmed' | 'cancelled' | 'expired';
  expiresAt: string;
}>;
