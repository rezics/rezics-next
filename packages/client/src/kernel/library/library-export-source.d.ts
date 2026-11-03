import type { PoolClient } from 'pg';
import type { LibraryExportSectionV1, LibraryExportSectionV2, LibraryExportVersion } from './library-export-format.ts';
export { exportSections, exportSectionsV2 } from './library-export-format.ts';

export type JournalDate =
  | { year: number }
  | { year: number; month: number }
  | { year: number; month: number; day: number };

export type AnnotationExportRecord = {
  section: 'annotations';
  accountId: string;
  subjectId: string;
  entryIncarnationId: string | null;
  libraryProfilePin: unknown | null;
  annotationRevision: number;
  note: string | null;
  priority: number | null;
  annotationUpdatedAt: string | null;
};
export type ProvenanceExportRecord = {
  section: 'provenance';
  accountId: string;
  subjectId: string;
  entryIncarnationId: string | null;
  libraryProfilePin: unknown | null;
  observation: {
    provider: string;
    recordId: string;
    revision: number;
    privacy:
      | { status: 'absent' | 'cleared' }
      | { status: 'unknown'; sourceValue?: string }
      | { status: 'known'; meaning: 'private' | 'source_visible' };
    sourceCreated: ProvenanceTimestampFact;
    sourceUpdated: ProvenanceTimestampFact;
    recordedAt: string;
  };
};
export type ProvenanceTimestampFact =
  | { status: 'absent' | 'cleared' }
  | { status: 'unknown'; sourceValue?: string }
  | {
      status: 'known';
      value: string;
      precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
      zone: 'utc' | 'offset' | 'unknown';
    };
export type JournalExportRecord = {
  section: 'journals';
  accountId: string;
  sessionId: string;
  subjectId: string;
  versionSubjectId: string | null;
  state: string;
  progressRevision: number;
  libraryProfilePin: unknown | null;
  startedAt: string;
  completedAt: string | null;
  lastChangedAt: string | null;
  journal: {
    sessionId: string;
    revision: number;
    startDate: JournalDate | null;
    finishDate: JournalDate | null;
    reflection: string | null;
  };
};
export type ExistingExportRecord = Record<string, unknown> & { section: LibraryExportSectionV1 };
export type ExportRecord =
  | ExistingExportRecord
  | AnnotationExportRecord
  | ProvenanceExportRecord
  | JournalExportRecord;
export type ExportSeek = {
  section: number;
  parent: string;
  after: string;
  rows: number;
  bytes: number;
  sectionTotals?: [number, number][];
};
export declare const initialExportSeek: (version?: LibraryExportVersion) => ExportSeek;
export type ExportSourcePage = { records: ExportRecord[]; seek: ExportSeek; done: boolean; oversized: boolean };
export declare function readExportSourcePage(
  client: Pick<PoolClient, 'query'>,
  route: number,
  accountId: string,
  input: ExportSeek,
  capturedAt: string,
  version?: LibraryExportVersion,
): Promise<ExportSourcePage>;
