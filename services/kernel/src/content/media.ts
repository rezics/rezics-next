import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { Access, Actor } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { ContentId, MediaId, RequestContext, ThreadId } from './model.ts';
import { unfinishedPort } from './model.ts';

export type MediaPurpose = 'post' | 'avatar' | 'attachment';
export type MediaState = 'reserved' | 'uploaded' | 'processing' | 'available' | 'rejected' | 'erased';
export type MediaVariant = Readonly<{ name: string; type: string; length: number; sha256: string; key: string }>;
export type MediaMetadata = Readonly<{
  id: MediaId;
  key: string;
  containerId: ThreadId;
  uploaderId: ContentId;
  route: number;
  partition: number;
  purpose: MediaPurpose;
  type: string;
  length: number;
  sha256: string | null;
  state: MediaState;
  claimedAt: string | null;
  erased: boolean;
  createdAt: string;
  decision: string | null;
  variants: readonly MediaVariant[];
}>;

export type MediaReservationInput = Readonly<{
  containerId: ThreadId;
  purpose: MediaPurpose;
  type: string;
  length: number;
  sha256: string | null;
}>;
export type ReserveMediaResult = Readonly<{
  media: MediaMetadata;
  upload: Readonly<{ method: 'PUT'; url: string; headers: Readonly<{ 'content-type': string }> }>;
}>;
export type MediaCompletionInput = Readonly<{
  reservationRequestId: string;
  containerId: ThreadId;
  byteCount: number;
  sha256: string;
}>;
export type MediaStorage = Readonly<{
  putOriginal(key: string, bytes: Uint8Array, type: string): Promise<void>;
  readOriginal(key: string): Promise<Uint8Array | null>;
  putVariant(key: string, bytes: Uint8Array, type: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
}>;
export type MediaDependencies = Readonly<{ pool: Pool; access: Access; storage: MediaStorage; tokens: KeyRing }>;
export type CollectionFence = Readonly<{ mediaId: MediaId; partition: number; fence: bigint; nextKey: string | null }>;
export type DownloadDecision =
  | Readonly<{ decision: 'deny' }>
  | Readonly<{
      decision: 'serve';
      media: MediaMetadata;
      variant: MediaVariant;
      cacheControl: 'private, no-store' | 'public, max-age=300';
    }>;

export async function reserveMedia(
  _dependencies: MediaDependencies,
  _actor: Actor,
  _input: MediaReservationInput,
  _context: RequestContext,
): Promise<ReserveMediaResult> {
  throw unfinishedPort('reserveMedia');
}

export async function completeMedia(
  _dependencies: MediaDependencies,
  _actor: Actor,
  _input: MediaCompletionInput,
  _context: RequestContext,
): Promise<MediaMetadata> {
  throw unfinishedPort('completeMedia');
}

export async function readReservation(
  _dependencies: MediaDependencies,
  _requestId: string,
  _actor: Actor,
): Promise<MediaMetadata | null> {
  throw unfinishedPort('readReservation');
}

export async function claimMedia(
  _client: CommandTransaction,
  _mediaId: MediaId,
  _containerId: ThreadId,
): Promise<MediaMetadata> {
  throw unfinishedPort('claimMedia');
}

export async function decideDownload(
  _dependencies: MediaDependencies,
  _mediaId: MediaId,
  _actor: Actor,
  _variantName: string,
): Promise<DownloadDecision> {
  throw unfinishedPort('decideDownload');
}

export async function readMediaState(_pool: Pool, _mediaId: MediaId): Promise<MediaState | null> {
  throw unfinishedPort('readMediaState');
}

export async function readCollectionFence(_pool: Pool, _partition: number): Promise<CollectionFence | null> {
  throw unfinishedPort('readCollectionFence');
}
