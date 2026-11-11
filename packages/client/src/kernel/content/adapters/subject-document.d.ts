import type { Pool } from 'pg';
import type { CommandTransaction } from '../../command/command.ts';
import type { RecordHistorySourceReference } from '../../history/contract/index.ts';
import type { Access, Actor } from '../../request/access.ts';
export type CurrentContentDocumentRuntime = Readonly<{
    pool: Pool;
    access: Access;
    routeKey: Uint8Array;
    now: () => number;
}>;
export type CurrentContentDocumentRequest = Readonly<{
    id: string;
    actor: Actor;
    deadline: number;
    maxSourceBytes?: number;
}>;
/** Native Semantic reads consume Content's current document authority through this adapter. */
export declare function readCurrentContentDocument(runtime: CurrentContentDocumentRuntime, request: CurrentContentDocumentRequest): Promise<{
    document: import("../document-read.ts").DocumentView;
    anchors: readonly import("../model.ts").AnchoredPosition[];
} | null>;
/** Resolve immutable source lineage from the actual Content owner row in the caller's native command. */
export declare function readContentDocumentHistorySource(tx: CommandTransaction, id: string): Promise<Extract<RecordHistorySourceReference, {
    kind: 'contribution';
}> | null>;
