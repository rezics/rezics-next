import { type LibraryArchiveManifest } from './library-export-format.ts';
import type { LibraryProfilePin } from './profile.ts';
/** Admission limits, independent of any eventual native copy command. */
export declare const COPY_ARCHIVE_LIMITS: {
    readonly bytes: number;
    readonly records: 100000;
    readonly holdings: 4096;
    readonly depth: 16;
    readonly recordBytes: 66000;
    readonly evidenceBytes: number;
    readonly page: 10;
    readonly cleanup: 100;
    readonly lifetimeDays: 7;
};
export type ArchivedHolding = {
    section: 'holdings';
    copy_id: string;
    subject_id: string;
    subject_id_reference: {
        id: string;
        href: string;
    };
    kind: string | null;
    status: string;
    library_profile_pin: LibraryProfilePin | null;
    kind_profile_pin: LibraryProfilePin | null;
    status_profile_pin: LibraryProfilePin | null;
    location: string | null;
    source: string | null;
    acquired_on: string | null;
    disposed_on: string | null;
    note: string | null;
    revision: number;
    created_at: string;
    updated_at: string;
};
/** The archive producer and all recovery consumers share one canonical manifest. */
export type CopyArchiveManifest = LibraryArchiveManifest;
export type ArchiveSectionCoverage = {
    section: string;
    records: number;
    recordBytes: number;
    support: 'evidence-only' | 'unsupported';
};
export type ArchivedProgressMeasure = {
    unit: string;
    amount: string | null;
    total: string | null;
};
export type ArchivedProgressSession = {
    section: 'sessions';
    session_id: string;
    subject_id: string;
    subject_id_reference: {
        id: string;
        href: string;
    };
    version_subject_id: string | null;
    version_subject_id_reference?: {
        id: string;
        href: string;
    };
    mode: string;
    unit: string;
    total: string | null;
    amount: string | null;
    additional_measures?: ArchivedProgressMeasure[];
    locator: string | null;
    position: string | null;
    completed_unit_count: number;
    episode_completed_count?: number;
    state: string;
    revision: number;
    library_profile_pin: unknown;
    started_at: string;
    completed_at: string | null;
    last_changed_at: string;
};
export type ArchivedProgressUnit = {
    section: 'units';
    unit_kind?: 'local' | 'episode';
    session_id: string;
    unit_id: string;
    added_at: string;
};
export type ParsedCopyArchive = {
    manifest: CopyArchiveManifest;
    coverage: ArchiveSectionCoverage[];
    holdings: {
        ordinal: number;
        evidence: ArchivedHolding;
    }[];
    progress: {
        ordinal: number;
        evidence: ArchivedProgressSession | ArchivedProgressUnit;
        sourceSessionId: string;
        sourceUnitId: string | null;
    }[];
};
/** Parse the installed Web artifact, never a synthetic row-list or an unfinished page. */
export declare function parseCopyArchive(bytes: Uint8Array): ParsedCopyArchive;
