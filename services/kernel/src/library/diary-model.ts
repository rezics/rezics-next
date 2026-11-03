/** Compact private occurrence; identifiers are retained native facts, never catalogue disclosure. */
export type DiaryOccurrence = {
  id: string;
  subjectId: string;
  versionSubjectId: string | null;
  state: 'active' | 'completed' | 'abandoned';
  revision: number;
  recordedStartedAt: string;
  recordedCompletedAt: string | null;
  /** Historical-date ownership is optional and is not installed by this reader. */
  reportedDates: { availability: 'unavailable' };
  subject: DiarySubject | null;
  versionSubject: DiarySubject | null;
};

/** A bounded, authorized label only; full catalogue and accepted progress meaning belong to detail. */
export type DiarySubject = { id: string; label: string | null; language: string | null };

export type DiaryPage = {
  occurrences: DiaryOccurrence[];
  order: 'recorded_started_desc_id_desc';
  next: string | null;
  /** Retain until leaving the journey, including on the final page, for explicit cancellation. */
  continuation: string | null;
  expiresAt: string | null;
};

export const DIARY_LIMIT = 25;
export const DIARY_LIFETIME_MS = 15 * 60_000;
export const DIARY_PAYLOAD_BYTES = 65_536;
