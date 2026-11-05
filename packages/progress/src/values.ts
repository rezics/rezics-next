import type { ProgressUnit } from './intent.ts';

/** A private, session-addressed journal. Its revision is independent of progress state and measures. */
export type ProgressSessionJournalDate = Readonly<{ year: number; month?: number; day?: number }>;
export type ProgressSessionJournalAssessment = Readonly<{ meaningRevision: 1; units: number | null }>;
export type ProgressSessionJournal = Readonly<{
  sessionId: string;
  revision: number;
  startDate: ProgressSessionJournalDate | null;
  finishDate: ProgressSessionJournalDate | null;
  reflection: string | null;
  assessment: ProgressSessionJournalAssessment;
}>;
export type ProgressSessionJournalPatch = Readonly<{
  revision: number;
  startDate?: ProgressSessionJournalDate | null;
  finishDate?: ProgressSessionJournalDate | null;
  reflection?: string | null;
  assessment?: Readonly<{ units: number }> | null;
}>;
/** Receipt-safe result of a journal edit; private field values are read on the session route. */
export type ProgressSessionJournalWrite = Readonly<{ sessionId: string; revision: number; changed: boolean }>;

/** A scalar value keeps its exact profile unit, total and nullable amount. */
export type ProgressScalarMeasure = { unit: ProgressUnit; total: string | null; amount: string | null };
export type ProgressMeasureDraft = { unit: ProgressUnit; total: string | null };

/** Immutable numeric facts supplied by the accepted profile; labels never define numeric meaning. */
export type NumericProfileMetadata = Readonly<{
  minimum?: string;
  maximum?: string;
  precision?: number;
}>;
export type ProgressUnitRules = NumericProfileMetadata &
  Readonly<{
    totalPolicy?: 'optional' | 'required' | 'forbidden';
  }>;

/** Descriptor input hints; step expresses precision, never a grid or a conversion ratio. */
export type ProgressInputRules = Readonly<{
  min?: string;
  max?: string;
  step: string;
  total: 'optional' | 'required' | 'forbidden';
}>;
