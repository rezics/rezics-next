import { LIBRARY_EXPORT_FORMAT } from './library-export-format.ts';
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
type CopyArchiveManifestBase = {
    format: typeof LIBRARY_EXPORT_FORMAT;
    exportId: string;
    capturedAt: string;
    expiresAt: string;
    privacy: 'private';
    completeness: 'supported-native-facts';
    sections: string[];
    omissions: Record<string, string>;
    fullExport: false;
    rows: number;
    recordBytes: number;
};
/** Original manifests and all section totals remain evidence, including unsupported provider rows. */
export type CopyArchiveManifest = CopyArchiveManifestBase & ({
    version: 1;
} | {
    version: 2;
    coverage: 'private-library-owner-facts-v2';
    sectionTotals: Record<string, {
        rows: number;
        recordBytes: number;
    }>;
} | {
    version: 4;
    coverage: 'private-library-owner-facts-v4';
    sectionTotals: Record<string, {
        rows: number;
        recordBytes: number;
    }>;
} | {
    version: 3;
    coverage: 'private-library-owner-facts-v3';
    sectionTotals: Record<string, {
        rows: number;
        recordBytes: number;
    }>;
});
export type ArchiveSectionCoverage = {
    section: string;
    records: number;
    /** Absent on uploads retained before per-section byte accounting was installed. */
    recordBytes?: number;
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
    state: string;
    revision: number;
    library_profile_pin: unknown;
    started_at: string;
    completed_at: string | null;
    last_changed_at: string;
};
export type ArchivedProgressUnit = {
    section: 'units';
    session_id: string;
    unit_id: string;
    added_at: string;
};
export type ParsedCopyArchive = {
    manifest: CopyArchiveManifest;
    coverage: (ArchiveSectionCoverage & {
        recordBytes: number;
    })[];
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
export {};
