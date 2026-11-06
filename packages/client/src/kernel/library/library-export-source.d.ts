import type { PoolClient } from 'pg';
import { type LibraryExportSectionV1, type LibraryExportVersion } from './library-export-format.ts';
export { exportSections, exportSectionsV2, exportSectionsV3, exportSectionsV4 } from './library-export-format.ts';
type JournalDate = {
    year: number;
} | {
    year: number;
    month: number;
} | {
    year: number;
    month: number;
    day: number;
};
type PrivacyFact = {
    status: 'absent' | 'cleared';
} | {
    status: 'unknown';
    sourceValue?: string;
} | {
    status: 'known';
    meaning: 'private' | 'source_visible';
};
type TimestampFact = {
    status: 'absent' | 'cleared';
} | {
    status: 'unknown';
    sourceValue?: string;
} | {
    status: 'known';
    value: string;
    precision: 'year' | 'month' | 'day' | 'minute' | 'second' | 'fraction';
    zone: 'utc' | 'offset' | 'unknown';
};
type ExistingExportRecord = Record<string, unknown> & {
    section: LibraryExportSectionV1;
};
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
        privacy: PrivacyFact;
        sourceCreated: TimestampFact;
        sourceUpdated: TimestampFact;
        recordedAt: string;
    };
};
export type JournalExportRecordV2 = {
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
export type JournalExportRecordV3 = Omit<JournalExportRecordV2, 'journal'> & {
    journal: JournalExportRecordV2['journal'] & {
        assessment: {
            meaningRevision: 1;
            units: number | null;
        };
    };
};
export type JournalExportRecord = JournalExportRecordV2 | JournalExportRecordV3;
export type ProviderExportRecord = {
    section: 'vndbUploads';
    upload_id: string;
    state: 'active' | 'cancelled';
    expires_at: string;
} | {
    section: 'anilistUploads';
    upload_id: string;
    cancelled: boolean | null;
    score_format: string | null;
    row_count: number | null;
} | {
    section: 'vndbEvidence' | 'anilistEvidence';
    upload_id: string;
    ordinal: number;
    evidence: unknown;
};
export type ExportRecord = ExistingExportRecord | AnnotationExportRecord | ProvenanceExportRecord | JournalExportRecord | ProviderExportRecord;
export type ExportSeek = {
    section: number;
    parent: string;
    after: string;
    rows: number;
    bytes: number;
    sectionTotals?: [number, number][];
};
export declare const initialExportSeek: (version?: LibraryExportVersion) => ExportSeek;
export type ExportSourcePage = {
    records: ExportRecord[];
    seek: ExportSeek;
    done: boolean;
    oversized: boolean;
};
export declare function readExportSourcePage(client: Pick<PoolClient, 'query'>, route: number, accountId: string, input: ExportSeek, capturedAt: string, version?: LibraryExportVersion): Promise<ExportSourcePage>;
