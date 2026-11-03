import type { PoolClient } from 'pg';
export declare const exportSections: readonly [...string[], "units", "history", "occurrences", "malEvidence"];
export type ExportRecord = Record<string, unknown>;
export type ExportSeek = {
    section: number;
    parent: string;
    after: string;
    rows: number;
    bytes: number;
};
export declare const initialExportSeek: () => ExportSeek;
export type ExportSourcePage = {
    records: ExportRecord[];
    seek: ExportSeek;
    done: boolean;
    oversized: boolean;
};
export declare function readExportSourcePage(client: Pick<PoolClient, 'query'>, route: number, accountId: string, input: ExportSeek, capturedAt: string): Promise<ExportSourcePage>;
