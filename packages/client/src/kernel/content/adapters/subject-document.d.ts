import type { Pool } from 'pg';
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
