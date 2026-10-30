import { type HistoryArtifactType } from './contracts.ts';
export declare const MAX_LOCATOR_BYTES = 256;
export declare const MAX_SCOPE_ACCOUNTS = 64;
type ReceiptLocator = Readonly<{
    artifactType: 'command-receipt/v1';
    partitionNo: number;
    principalKind: 'account' | 'anonymous';
    principalId: string;
    commandKindId: number;
    keyVersion: number;
    keyToken: string;
}>;
type OutboxLocator = Readonly<{
    artifactType: 'outbox-event/v1';
    partitionNo: number;
    position: bigint;
    eventSeq: number;
}>;
type WorkLocator = Readonly<{
    artifactType: 'durable-work/v1';
    workId: string;
}>;
export type HistoryLocator = ReceiptLocator | OutboxLocator | WorkLocator;
export type AccountReference = Readonly<{
    accountRoute: number;
    accountId: string;
    roles: number;
}>;
export type HistoryScope = Readonly<{
    artifactType: HistoryArtifactType;
    accounts: readonly AccountReference[];
}>;
/** Closed key shapes exclude raw command keys, handles, payloads and authorization material. */
export declare function validateLocator(type: HistoryArtifactType, value: unknown): HistoryLocator;
/** Binary v1: version:u8, artifact-tag:u8; integers are unsigned big endian. Receipt: partition:u16,
 * principal-kind:u8 (account=1, anonymous=0), UUID:16, command-kind:u32, key-version:u16, HMAC:32.
 * Outbox: partition:u16, position:u64, sequence:u16. Work: opaque ASCII ID (remainder). */
export declare function encodeLocator(locator: HistoryLocator): Uint8Array;
export declare function decodeLocator(type: HistoryArtifactType, input: Uint8Array): HistoryLocator;
export declare function validateScope(type: HistoryArtifactType, value: unknown): HistoryScope;
export {};
