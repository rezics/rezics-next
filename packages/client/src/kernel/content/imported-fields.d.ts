import type { PoolClient } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { type ImportedFieldInput, type ImportedSource, type Rights } from './imported-contract.ts';
export type ImportedFieldResult = Readonly<{
    id: string;
    digest: string;
}>;
export type ImportedFieldView = ImportedFieldResult & Readonly<{
    subject: string;
    candidate: string;
    revision: number;
    source: ImportedSource;
    rights: Rights;
    language: string;
    availability: 'available' | 'erased';
    body: Buffer | null;
    /** True only for bounded reads whose bytes were withheld before returning to the caller. */
    bodyTooLarge?: boolean;
}>;
export type StoredImportedField = ImportedFieldView;
/** Append inside semantic's authorized command. This neither adopts nor publishes the proposal. */
export declare function appendImportedField(tx: CommandTransaction, input: ImportedFieldInput): Promise<ImportedFieldResult>;
/** LOW-LEVEL exact storage read, including erased tombstones. Never expose this as a public handler.
 * The public caller must independently check current semantic container/candidate disclosure
 * and the current source fence; possession of a document ID grants no publication permission.
 */
export declare function readImportedField(client: Pick<PoolClient, 'query'>, id: string): Promise<ImportedFieldView | null>;
/** Explicit-route form also rejects mismatched IDs before I/O. */
export declare function readImportedField(client: Pick<PoolClient, 'query'>, route: number, id: string): Promise<ImportedFieldView | null>;
/** Exact Content-owner read that withholds an oversized body in SQL before it reaches the application. */
export declare function readImportedFieldBounded(client: Pick<PoolClient, 'query'>, route: number, id: string, maximumBytes: number): Promise<ImportedFieldView | null>;
