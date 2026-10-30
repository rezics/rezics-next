import type { Source } from '@rezics/definitions/bulk';
import type { Pool } from 'pg';
import { type CommandAuthorization } from '../command/command.ts';
import type { AccountActor } from '../request/access.ts';
export type SourceRecord = {
    name: string;
    url: string;
    licence?: {
        id: string;
        url?: string;
    };
    attribution?: string;
};
export type SourceRecordMetadataCommand = {
    source: string;
    external_id: string;
    metadata: SourceRecord;
    expected_metadata_revision: number | null;
};
export type SourceRecordMetadataResult = {
    record: SourceRecord;
    metadata_revision: number;
    effect: 'filled' | 'corrected' | 'noEffect';
};
export declare const SourceRecordSchema: import("typebox").TObject<{
    name: import("typebox").TString;
    url: import("typebox").TString;
    licence: import("typebox").TOptional<import("typebox").TObject<{
        id: import("typebox").TString;
        url: import("typebox").TOptional<import("typebox").TString>;
    }>>;
    attribution: import("typebox").TOptional<import("typebox").TString>;
}>;
export declare const SourceRecordMetadataCommandSchema: import("typebox").TObject<{
    source: import("typebox").TString;
    external_id: import("typebox").TString;
    metadata: import("typebox").TObject<{
        name: import("typebox").TString;
        url: import("typebox").TString;
        licence: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            url: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        attribution: import("typebox").TOptional<import("typebox").TString>;
    }>;
    expected_metadata_revision: import("typebox").TUnion<[import("typebox").TInteger, import("typebox").TNull]>;
}>;
export declare const SourceRecordMetadataResultSchema: import("typebox").TObject<{
    record: import("typebox").TObject<{
        name: import("typebox").TString;
        url: import("typebox").TString;
        licence: import("typebox").TOptional<import("typebox").TObject<{
            id: import("typebox").TString;
            url: import("typebox").TOptional<import("typebox").TString>;
        }>>;
        attribution: import("typebox").TOptional<import("typebox").TString>;
    }>;
    metadata_revision: import("typebox").TInteger;
    effect: import("typebox").TUnion<[import("typebox").TLiteral<"filled">, import("typebox").TLiteral<"corrected">, import("typebox").TLiteral<"noEffect">]>;
}>;
export declare class SourceRecordMetadataInputError extends Error {
}
export declare class SourceRecordMetadataConflictError extends Error {
}
/** Native metadata validation does not infer registration or rights from an alias or URL. */
export declare function validateSourceRecordMetadata(input: unknown): asserts input is SourceRecordMetadataCommand;
export declare const SOURCE_RECORD_METADATA = "source_record.set_metadata";
export declare const SOURCE_RECORD_METADATA_CHANGED = "com.rezics.source-record.metadata-changed.v1";
/** Independent tuple-home command. Authorization is prepared afresh by runCommand before every receipt read. */
export declare function writeSourceRecordMetadata(pool: Pool, options: {
    command: SourceRecordMetadataCommand;
    validated?: boolean;
    routeKey: Uint8Array;
    actor: AccountActor;
    authorization: CommandAuthorization;
    idempotencyKey: string;
    digest: Uint8Array;
    deadline: number;
    clock: () => Date;
}): Promise<{
    status: 200 | 201;
    value: SourceRecordMetadataResult;
    component: {
        partition: number;
        epoch: number;
        position: bigint;
    };
}>;
/** Exact already-disclosed tuples only. No claim, candidate or history discovery takes place here. */
export declare function readSourceRecords(pool: Pool, routeKey: Uint8Array, support: readonly Source[]): Promise<SourceRecord[]>;
