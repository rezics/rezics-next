import type { Pool } from 'pg';
import type { CommandOutcome, CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { MediaId, PostId, ReadContext, RequestContext, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type MediaPurpose = 'post-image';
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
export type MediaMetadata = Readonly<{
  id: MediaId;
  key: string;
  containerId: ThreadId | PostId;
  uploaderId: string;
  route: number;
  purpose: MediaPurpose;
  mediaType: string;
  byteCount: number;
  reservationRequestId: string;
  declaredSha256?: string;
  sha256: string | null;
  state: MediaState;
  claimedAt: string | null;
  erased: boolean;
  collectionPending: boolean;
  createdAt: string;
  decision: string | null;
  variants: readonly MediaVariant[];
}>;
export type MediaReservationInput = Readonly<{
  containerId: ThreadId | PostId;
  purpose: MediaPurpose;
  mediaType: string;
  byteCount: number;
  sha256?: string;
}>;
export type MediaCompletionInput = Readonly<{
  containerId: ThreadId | PostId;
  reservationRequestId: string;
  byteCount: number;
  sha256: string;
}>;
export type MediaDependencies = Readonly<{ pool: Pool; access: Access }>;
export type DownloadVariant = 'original' | `webp-${number}` | `avif-${number}`;
export type DownloadDecision =
  | Readonly<{
      allowed: true;
      key: string;
      sha256: string;
      mediaType: string;
      byteCount: number;
      publicCache: false;
      cacheControl: 'private, no-cache' | 'private, no-store';
    }>
  | Readonly<{ allowed: false }>;
export type ClaimMediaInput = Readonly<{
  mediaIds: readonly MediaId[];
  containerId: ThreadId | PostId;
  author: Actor;
  itemId: PostId;
  revisionId: string;
}>;
export function reserveMedia(
  _dependencies: MediaDependencies,
  _actor: Actor,
  _input: MediaReservationInput,
  _context: RequestContext,
): Promise<CommandOutcome<Readonly<{ mediaId: MediaId }>>> {
  throw unfinishedPort('reserveMedia');
}
export function completeMedia(
  _dependencies: MediaDependencies,
  _actor: Actor,
  _mediaId: MediaId,
  _input: MediaCompletionInput,
  _context: RequestContext,
): Promise<CommandOutcome<Readonly<{ mediaId: MediaId; state: 'uploaded' }>>> {
  throw unfinishedPort('completeMedia');
}
export function readReservation(
  _dependencies: MediaDependencies,
  _mediaId: MediaId,
  _context: ReadContext,
): Promise<MediaMetadata | null> {
  throw unfinishedPort('readReservation');
}
export function claimMedia(_transaction: CommandTransaction, _input: ClaimMediaInput): Promise<void> {
  throw unfinishedPort('claimMedia');
}
export function decideDownload(
  _dependencies: MediaDependencies,
  _mediaId: MediaId,
  _actor: Actor,
  _variant: DownloadVariant,
): Promise<DownloadDecision> {
  throw unfinishedPort('decideDownload');
}
export function readMediaState(_pool: Pool, _mediaId: MediaId): Promise<MediaState | null> {
  throw unfinishedPort('readMediaState');
}
export function readCollectionFence(_pool: Pool, _mediaId: MediaId): Promise<boolean | null> {
  throw unfinishedPort('readCollectionFence');
}
export type { MediaStorage } from './media-storage.ts';
