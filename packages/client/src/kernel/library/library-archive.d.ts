import { type LibraryArchiveManifest, type LibraryExportSection } from './library-export-format.ts';
/** Consumer bounds, fixed before parsing. No upload, permission or effect is admitted here. */
export declare const LIBRARY_ARCHIVE_LIMITS: {
    readonly records: 100000;
    readonly recordBytes: number;
    readonly maxRecordBytes: 65536;
    readonly pageBytes: 120000;
    readonly pageRows: 16;
    readonly uploadBytes: number;
    readonly depth: 32;
    readonly sections: 17;
};
/** Installed private Collection recovery bounds; these are independent of each native command's own cap. */
export declare const LIBRARY_ARCHIVE_RECOVERY_LIMITS: {
    readonly retainedUploadsPerOwner: 2;
    readonly lifetimeMs: number;
    readonly selectedCollections: 1;
    readonly selectedOccurrences: 1000;
    readonly previewPage: 50;
    readonly applyCommands: 25;
    readonly cleanupRows: 100;
};
export declare const archiveMergeSections: readonly ['entries', 'labels', 'assignments', 'annotations', 'journals', 'provenance'];
type ObjectValue = Record<string, unknown>;
export type ArchiveRecord = ObjectValue & {
    section: LibraryExportSection;
};
export type ArchiveCoverage = {
    section: LibraryExportSection;
    capture: 'present' | 'empty';
    treatment: 'requires-explicit-mapping' | 'retained-unsupported';
    rows: number;
};
export type LibraryArchive = {
    manifest: LibraryArchiveManifest;
    records: ArchiveRecord[];
    coverage: ArchiveCoverage[];
    /** Envelope and record validation never establishes current identity, state or label admission. */
    fullRestoration: false;
};
export type ArchiveValidationCode = 'bounds' | 'invalid_json' | 'unsupported_version' | 'invalid_envelope' | 'incomplete_capture' | 'inconsistent_manifest' | 'invalid_record' | 'duplicate_record' | 'duplicate_label';
/** Stable reasons contain neither source values nor private names, including JSON parser errors. */
export declare class ArchiveValidationError extends Error {
    readonly code: ArchiveValidationCode;
    constructor(code: ArchiveValidationCode);
}
/** Decode the producer's completed {manifest,records} file into inert, loss-aware private evidence.
 * All native IDs, revisions, names, state vocabulary and accepting pins remain evidence only.
 */
export declare function decodeLibraryArchive(bytes: Uint8Array): LibraryArchive;
export {};
