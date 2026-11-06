import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
export type RecordPurgeReference = Readonly<{
    subjectId: string;
    candidateId: string;
    revision: number;
    documentId: string | null;
    deletionGeneration: string;
}>;
export type ResourceRecordPurgeReference = Readonly<{
    kind: 'context';
    contextId: string;
    deletionGeneration: string;
}> | Readonly<{
    kind: 'zone';
    zoneId: string;
    deletionGeneration: string;
}>;
export type NativeRecordPurgeReference = RecordPurgeReference | ResourceRecordPurgeReference;
declare const recordPurgeAuthority: unique symbol;
export type RecordPurgeAuthority = {
    readonly [recordPurgeAuthority]: true;
};
export type RecordPurgeSource = Readonly<{
    reference: NativeRecordPurgeReference;
    disposition: 'ordinary-deletion';
    sourceVersion: string;
    deletionTransactionId: string;
    deletionCommittedAt: string;
    purgeAfter: string;
}>;
export declare function prepareRecordPurgeAuthority(deps: Readonly<{
    pool: Pool;
    clock?: () => Date;
}>, ref: NativeRecordPurgeReference, context: Readonly<{
    deadline: number;
}>): Promise<RecordPurgeAuthority | null>;
export declare function readRecordPurgeAuthoritySource(deps: Readonly<{
    pool: Pool;
    clock?: () => Date;
}>, authority: RecordPurgeAuthority, context: Readonly<{
    deadline: number;
}>): Promise<RecordPurgeSource | null>;
export declare function lockRecordPurgeAuthoritySource(tx: CommandTransaction, authority: RecordPurgeAuthority): Promise<RecordPurgeSource | null>;
export {};
