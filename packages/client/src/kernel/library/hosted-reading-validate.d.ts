import { type HostedReadingAddress, type HostedReadingClearInput, type HostedReadingDocumentPosition, type HostedReadingSaveInput } from './contract/hosted-reading.ts';
export declare const HOSTED_READING_UUID: RegExp;
export type HostedReadingRow = Readonly<{
    catalogue_id: string;
    publication_revision_id: string;
    occurrence_id: string;
    target_revision_id: string;
    target_sha256: string;
    document_block_id: string | null;
    document_offset: number | null;
    revision: string;
}>;
export declare function hostedReadingUuid(value: unknown): value is string;
export declare function hostedReadingPositionFromRow(blockId: string | null, offset: number | null): HostedReadingDocumentPosition | null;
export declare function addressFromRow(row: HostedReadingRow): HostedReadingAddress;
export declare function parseHostedReadingPosition(value: unknown): HostedReadingDocumentPosition | null;
export declare function validateHostedReadingSave(value: unknown): HostedReadingSaveInput;
export declare function validateHostedReadingClear(value: unknown): HostedReadingClearInput;
