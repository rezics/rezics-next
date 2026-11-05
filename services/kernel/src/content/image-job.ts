import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { CommandUnavailableError, runCommand } from '../command/command.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import type { MediaId } from './model.ts';
import type { MediaStorage } from './media-storage.ts';
import type { MediaVariant } from './media.ts';
import type { MediaEventData } from './media-events.ts';
import {
  ImageCropOutOfBoundsRejection,
  ImageDecodeRejection,
  transformImage,
  type ImageCrop,
  type TransformedImage,
} from './image-transform.ts';
import lockMedia from './lock-media.sql';
import finishImage from './finish-image.sql';

export type ImageJobOutcome = Readonly<{
  mediaId: MediaId;
  state: 'available' | 'rejected' | 'already_terminal';
  variants: readonly MediaVariant[];
}>;
export type ImageJob = Readonly<{ process(mediaId: MediaId): Promise<ImageJobOutcome> }>;
export function createImageJob(pool: Pool, storage: MediaStorage): ImageJob {
  return Object.freeze({ process: (mediaId: MediaId) => processImage(pool, storage, mediaId) });
}

// No-op attempts roll back without advancing the partition or emitting an event.
class UnchangedImage extends Error {
  constructor(
    readonly outcome: ImageJobOutcome,
    readonly purge: boolean,
  ) {
    super('Image job has no state transition');
  }
}

type LockedMedia = Awaited<ReturnType<typeof lockMedia.run>>[number];
function storedCrop(value: readonly (number | null)[] | null): ImageCrop | null {
  if (value === null) return null;
  if (value.length !== 4 || value.some((number) => number === null)) throw new TypeError('Invalid stored image crop');
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}
function storedVariants(rows: readonly LockedMedia[]): MediaVariant[] {
  return rows.flatMap((row) => {
    if (row.format === null) return [];
    if (
      (row.format !== 'avif' && row.format !== 'webp') ||
      row.width === null ||
      row.height === null ||
      row.media_type === null ||
      row.byte_count === null ||
      row.variant_sha256 === null ||
      row.variant_key === null
    )
      throw new TypeError('Invalid stored image variant');
    return [
      {
        format: row.format,
        width: row.width,
        height: row.height,
        mediaType: row.media_type,
        byteCount: Number(row.byte_count),
        sha256: row.variant_sha256,
        key: row.variant_key,
      },
    ];
  });
}

/** Trusted host work only. The media lock spans decoding and every awaited put;
 * collection must acquire this same row lock before committing its pending fence.
 */
export async function processImage(pool: Pool, storage: MediaStorage, mediaId: MediaId): Promise<ImageJobOutcome> {
  const route = routeOf(mediaId);
  if (route === null) throw new RangeError('Image job requires a routable media ID');
  const partition = partitionOf(route);
  const deadline = Date.now() + 120_000;
  const checkDeadline = () => {
    if (Date.now() >= deadline) throw new CommandUnavailableError('deadline', partition);
  };
  let result: ImageJobOutcome;
  let purge = false;
  // A serializable command can retry after all remote writes have succeeded.
  // A collector cannot remove these keys without committing the row fence that
  // every new attempt checks. Reuse only writes of these exact encoded bytes.
  const published = new Map<string, string>();
  try {
    const command = await runCommand(pool, { partition, deadline }, async (tx, { transactionId }) => {
      // The API pool's five-second idle limit must not release a job's lock during
      // Sharp or remote I/O. The trusted job deadline is checked between awaited
      // operations; storage composition supplies bounded individual I/O operations.
      await tx.query('SET LOCAL idle_in_transaction_session_timeout = 0');
      const rows = await lockMedia.run(tx, { route, media_id: mediaId });
      const media = rows[0];
      if (
        !media ||
        media.erased ||
        media.collection_pending ||
        media.state === 'available' ||
        media.state === 'rejected'
      ) {
        throw new UnchangedImage(
          { mediaId, state: 'already_terminal', variants: storedVariants(rows) },
          media?.state === 'rejected' && !media.erased,
        );
      }
      if (media.state !== 'uploaded') throw new Error('Image has not been uploaded');
      const crop = storedCrop(media.crop);
      checkDeadline();
      const bytes = await storage.get(media.key);
      checkDeadline();
      // Missing storage is retryable: a successful upload may not yet be readable.
      if (bytes === null) throw new Error('Uploaded image is not present in storage');
      let rejection: string | null = null;
      let variants: MediaVariant[] = [];
      let transformed: TransformedImage | undefined;
      if (
        bytes.byteLength > 20 * 1024 * 1024 ||
        bytes.byteLength !== Number(media.actual_byte_count) ||
        createHash('sha256').update(bytes).digest('hex') !== media.sha256
      ) {
        rejection = 'source-integrity';
      } else {
        try {
          transformed = await transformImage(bytes, crop);
        } catch (error) {
          if (error instanceof ImageCropOutOfBoundsRejection) rejection = 'crop_out_of_bounds';
          else if (error instanceof ImageDecodeRejection) rejection = 'unsafe-image';
          else throw error;
        }
        if (transformed) {
          for (const variant of transformed.variants) {
            checkDeadline();
            const key = `m/${mediaId}/${variant.format}-${variant.width}`;
            // Sequential awaited writes leave no promises that can publish after
            // rollback or a following collector's prefix deletion. Transient
            // failures retain at most twelve deterministic, unpublished objects;
            // retry overwrites them and collection removes the entire prefix.
            if (published.get(key) !== variant.sha256) {
              await storage.put(key, variant.bytes, { mediaType: variant.mediaType });
              published.set(key, variant.sha256);
            }
            variants.push({
              format: variant.format,
              width: variant.width,
              height: variant.height,
              mediaType: variant.mediaType,
              byteCount: variant.byteCount,
              sha256: variant.sha256,
              key,
            });
          }
        }
      }
      checkDeadline();
      const state = rejection === null ? 'available' : 'rejected';
      const changed = await finishImage.run(tx, {
        route,
        media_id: mediaId,
        state,
        decision: rejection === null ? null : `${rejection}:${transactionId}`,
        transaction_id: transactionId,
        width: transformed?.width ?? null,
        height: transformed?.height ?? null,
        thumbhash: transformed ? Buffer.from(transformed.thumbhash) : null,
        average_color: transformed?.averageColor ?? null,
        crop: crop === null ? null : [...crop],
        focal_x: media.focal_x,
        focal_y: media.focal_y,
        variants,
      });
      if (changed.length !== 1) throw new Error('Image transition lost its locked source');
      const value: ImageJobOutcome = { mediaId, state, variants };
      if (state === 'rejected') {
        const data: MediaEventData<'com.rezics.content.media.rejected.v1'> = {
          mediaId,
          containerId: media.container_id,
          decisionId: transactionId,
        };
        return { value, events: [{ type: 'com.rezics.content.media.rejected.v1', subject: mediaId, data }] };
      }
      const data: MediaEventData<'com.rezics.content.media.available.v1'> = {
        mediaId,
        containerId: media.container_id,
      };
      return { value, events: [{ type: 'com.rezics.content.media.available.v1', subject: mediaId, data }] };
    });
    result = command.value;
    purge = result.state === 'rejected';
  } catch (error) {
    if (!(error instanceof UnchangedImage)) throw error;
    result = error.outcome;
    purge = error.purge;
  }
  // Rejection and its purge event/pending fence COMMIT before deletion. Neither
  // an exception nor a partially successful delete can restore a processable row
  // or lose cleanup work. Retries also purge already-rejected objects; the normal
  // purge/collection workers can independently finish the durable pending work.
  if (purge) await storage.deletePrefix(`m/${mediaId}/`);
  return result;
}
