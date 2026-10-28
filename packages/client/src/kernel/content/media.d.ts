import type { Pool } from 'pg';
import { type CommandOutcome, type CommandTransaction } from '../command/command.ts';
import type { Access, Actor, Resource } from '../request/access.ts';
import type { ImportedSource, Rights } from './imported-contract.ts';
import type { MediaId, PostId, ReadContext, RequestContext, RevisionId, ThreadId } from './model.ts';
import { type DownloadContext } from './media-download.ts';
import type { RealmParticipationCheck } from '../community/participation.ts';
export type MediaPurpose = 'post-image' | 'cover' | 'avatar';
export type MediaState = 'reserved' | 'uploaded' | 'available' | 'rejected';
export type MediaVariant = Readonly<{
    format: 'webp' | 'avif';
    width: number;
    height: number;
    mediaType: string;
    byteCount: number;
    sha256: string;
    key: string;
}>;
type MediaMetadataBase = Readonly<{
    id: MediaId;
    key: string;
    containerId: ThreadId | PostId;
    uploaderId: string;
    route: number;
    reservationRequestId: string;
    declaredSha256?: string;
    sha256: string | null;
    state: MediaState;
    claimedAt: string | null;
    erased: boolean;
    takenDown: boolean;
    securityRevision: string;
    collectionPending: boolean;
    createdAt: string;
    decision: string | null;
    variants: readonly MediaVariant[];
}>;
/** Browser reservations describe post images and avatars with measured-size inputs. Imported covers
 * remain unmeasured until the trusted fetch and processing path observes the bytes. */
export type MediaMetadata = (MediaMetadataBase & Readonly<{
    purpose: 'post-image' | 'avatar';
    mediaType: string;
    byteCount: number;
}>) | (MediaMetadataBase & Readonly<{
    purpose: 'cover';
    mediaType: string | null;
    byteCount: number | null;
    rights: Rights;
    source: ImportedSource;
}>);
type MediaReservationFields = Readonly<{
    purpose: 'post-image' | 'avatar';
    mediaType: string;
    byteCount: number;
    sha256?: string;
}>;
export type MediaReservationInput = MediaReservationFields & (Readonly<{
    containerId: ThreadId | PostId;
    newThread?: never;
}> | Readonly<{
    purpose: 'post-image';
    newThread: Readonly<{
        boardId: string;
        idempotencyKey: string;
    }>;
    containerId?: never;
}>);
export type NewThreadMediaTarget = Readonly<{
    thread: Resource;
    boardId: string;
}>;
export type MediaCompletionInput = Readonly<{
    containerId: ThreadId | PostId;
    reservationRequestId: string;
    byteCount: number;
    sha256: string;
}>;
export type MediaDependencies = Readonly<{
    pool: Pool;
    access: Access;
    realmParticipation?: RealmParticipationCheck;
    clock?: () => Date;
    /** Trusted per-request host context; never supplied by request JSON. */
    downloadContext?: DownloadContext;
}>;
export type DownloadVariant = 'original' | `webp-${number}` | `avif-${number}`;
export type DownloadDecision = Readonly<{
    allowed: true;
    key: string;
    sha256: string;
    mediaType: string;
    byteCount: number;
    publicCache: false;
    cacheControl: 'private, no-cache' | 'private, no-store';
}> | Readonly<{
    allowed: false;
}>;
type ClaimMediaBase = Readonly<{
    mediaIds: readonly MediaId[];
    containerId: ThreadId | PostId;
    author: Actor;
    boardId?: string;
}>;
export type ClaimMediaInput = ClaimMediaBase & (Readonly<{
    itemId: PostId;
    revisionId: RevisionId;
    reference?: never;
}> | Readonly<{
    reference: Readonly<{
        kind: 'semantic_candidate';
        subjectId: string;
        candidateId: string;
        revision: number;
    }>;
    itemId?: never;
    revisionId?: never;
}>);
export declare class NewThreadTargetExistsError extends Error {
    constructor();
}
export declare class InvalidMediaClaimError extends Error {
    constructor();
}
export declare class MediaUnavailableError extends Error {
    constructor();
}
export declare function reserveMedia(dependencies: MediaDependencies, actor: Actor, input: MediaReservationInput, context: RequestContext, newThreadTarget?: NewThreadMediaTarget): Promise<CommandOutcome<Readonly<{
    mediaId: MediaId;
}>>>;
export declare function completeMedia(dependencies: MediaDependencies, actor: Actor, mediaId: MediaId, input: MediaCompletionInput, context: RequestContext): Promise<CommandOutcome<Readonly<{
    mediaId: MediaId;
    state: 'uploaded';
}>>>;
export declare function readReservation(dependencies: MediaDependencies, mediaId: MediaId, context: ReadContext): Promise<MediaMetadata | null>;
export declare function claimMedia(transaction: CommandTransaction, input: ClaimMediaInput): Promise<void>;
export declare function decideDownload(dependencies: MediaDependencies, mediaId: MediaId, actor: Actor, variant: DownloadVariant): Promise<DownloadDecision>;
export declare function readMediaState(pool: Pool, mediaId: MediaId): Promise<MediaState | null>;
export declare function readCollectionFence(pool: Pool, mediaId: MediaId): Promise<boolean | null>;
export type { MediaStorage } from './media-storage.ts';
