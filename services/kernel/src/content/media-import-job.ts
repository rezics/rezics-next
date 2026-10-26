import { checkMediaImportRequest, type MediaImportRequest } from '@rezics/definitions/media-import';
import { runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { fetchSourceImage, SourceImageRejection } from './fetch-source-image.ts';
import { tupleRoute } from './imported-contract.ts';
import { mediaCropFragment, type MediaImportDependencies } from './media-import.ts';
import type { MediaStorage } from './media-storage.ts';
import { readFences } from './source-fences.ts';
import readWork from './read-import-media-work.sql';
import finishUpload from './finish-import-upload.sql';
import rejectMedia from './reject-import-media.sql';

export interface MediaImportJobDependencies extends MediaImportDependencies {
  storage: MediaStorage;
}
export type ImportedMediaOutcome =
  | Readonly<{ mediaId: string; state: 'uploaded' | 'already_terminal' }>
  | Readonly<{ mediaId: string; state: 'rejected'; rejection: { code: string } }>;

type Work = NonNullable<Awaited<ReturnType<typeof readWork.run>>>;
class UnchangedImport extends Error {
  constructor(readonly row: Work | null | undefined) {
    super('Import is already terminal');
  }
}
const processable = (row: Work | null | undefined): row is Work =>
  !!row &&
  row.purpose === 'cover' &&
  row.state === 'reserved' &&
  !row.erased &&
  !row.collection_pending &&
  !row.taken_down;
const evidence = (row: Work) =>
  JSON.stringify([row.source_url, row.credit, row.provenance, row.crop, row.focal_x, row.focal_y, row.uploader_id]);

function storedOriginalMediaType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png';
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return 'image/gif';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    ((bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x66) ||
      (bytes[8] === 0x61 && bytes[9] === 0x76 && bytes[10] === 0x69 && bytes[11] === 0x73))
  )
    return 'image/avif';
  // Do not use this metadata fallback to accept the bytes. The shared Sharp job
  // decides whether the original can produce a publishable variant.
  return 'image/jpeg';
}

/** Trusted native step body, registered by the single content worker. No actor or
 * remote/destination facts are accepted in its input. The media row is the durable
 * completion receipt; rollback leaves only deterministic, unpublished R2 bytes.
 */
export async function processImportedMedia(
  deps: MediaImportJobDependencies,
  mediaId: string,
): Promise<ImportedMediaOutcome> {
  const route = routeOf(mediaId);
  if (route === null) throw new RangeError('Import requires a routable media ID');
  const partition = partitionOf(route);
  const deadline = Date.now() + 120_000;
  // Preparation is a separate, released media point read. It provides only the
  // tuple identity, never permission to publish or a distributed transaction.
  const prepared = await withConnection(deps.pool, async (client) => {
    await client.query('BEGIN');
    try {
      if (!(await readPartition(client, partition))) throw new Error('Missing media partition');
      const row = await readWork.run(client, { route, media_id: mediaId });
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  let fenceClosed = false;
  let invalidEvidence = false;
  if (processable(prepared)) {
    const input = {
      containerId: prepared.container_id,
      sourceUrl: prepared.source_url,
      credit: prepared.credit,
      provenance: prepared.provenance,
      ...(prepared.crop === null ? {} : { crop: mediaCropFragment(prepared.crop) }),
      ...(prepared.focal_x === null || prepared.focal_y === null
        ? {}
        : { focalPoint: { x: prepared.focal_x, y: prepared.focal_y } }),
    };
    invalidEvidence = checkMediaImportRequest(input).length > 0;
    if (!invalidEvidence) {
      const provenance = (input as MediaImportRequest).provenance;
      const sourceRoute = tupleRoute(deps.routeKey, provenance.source, provenance.external_id);
      // Always anchor at the tuple's own home and RELEASE before media checkout.
      fenceClosed = await withConnection(deps.pool, async (client) => {
        await client.query('BEGIN READ ONLY');
        try {
          if (!(await readPartition(client, partitionOf(sourceRoute)))) throw new Error('Missing source partition');
          const [fence] = await readFences(client, [
            {
              route: sourceRoute,
              source: provenance.source,
              external_id: provenance.external_id,
              field_group: 'cover',
            },
          ]);
          await client.query('COMMIT');
          return fence!.takenDown;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      });
    }
  }
  let outcome: ImportedMediaOutcome;
  let purge = false;
  try {
    const command = await runCommand<ImportedMediaOutcome>(
      deps.pool,
      { partition, deadline, clock: deps.clock },
      async (tx, { transactionId }) => {
        await tx.query('SET LOCAL idle_in_transaction_session_timeout = 0');
        if (!(await readPartition(tx, partition))) throw new Error('Missing media partition');
        const row = await readWork.run(tx, { route, media_id: mediaId });
        if (!processable(row)) throw new UnchangedImport(row);
        if (!prepared || evidence(row) !== evidence(prepared))
          throw new Error('Import source changed during preparation');
        let code: string | null = invalidEvidence ? 'source-evidence' : fenceClosed ? 'source-fenced' : null;
        let fetched: Awaited<ReturnType<typeof fetchSourceImage>> | undefined;
        let mediaType: string | undefined;
        if (code === null) {
          try {
            fetched = await fetchSourceImage(row.source_url!, deps.fetchConfig);
            // Keep the fetched bytes as an untrusted upload. The shared image
            // worker performs the bounded Sharp decode and publishes only its
            // re-encoded variants; failed decodes transition uploaded -> rejected.
            mediaType = storedOriginalMediaType(fetched.bytes);
          } catch (error) {
            if (error instanceof SourceImageRejection) code = error.code;
            else throw error;
          }
        }
        if (code !== null) {
          const changed = await rejectMedia.run(tx, {
            route,
            media_id: mediaId,
            decision: `${code}:${transactionId}`,
            transaction_id: transactionId,
          });
          if (!changed) throw new Error('Import rejection lost its locked row');
          const value: ImportedMediaOutcome = { mediaId, state: 'rejected', rejection: { code } };
          return {
            value,
            events: [
              {
                type: 'com.rezics.content.media.rejected.v1',
                subject: mediaId,
                data: { mediaId, containerId: row.container_id, decisionId: transactionId },
              },
            ],
          };
        }
        if (!fetched || !mediaType) throw new Error('Missing measured source');
        // Await the entire put under the same row lock used by collection/erasure.
        // No write can remain active after rollback and a collector's prefix purge.
        await deps.storage.put(`m/${mediaId}/original`, fetched.bytes, { mediaType });
        const changed = await finishUpload.run(tx, {
          route,
          media_id: mediaId,
          byte_count: BigInt(fetched.bytes.byteLength),
          media_type: mediaType,
          sha256: fetched.sha256,
          transaction_id: transactionId,
        });
        if (changed.length !== 1) throw new Error('Import completion lost its locked row');
        const value: ImportedMediaOutcome = { mediaId, state: 'uploaded' };
        return {
          value,
          events: [
            {
              type: 'com.rezics.content.media.uploaded.v1',
              subject: mediaId,
              data: { mediaId, containerId: row.container_id, actorId: row.uploader_id },
            },
          ],
        };
      },
    );
    outcome = command.value;
    purge = outcome.state === 'rejected';
  } catch (error) {
    if (!(error instanceof UnchangedImport)) throw error;
    outcome = { mediaId, state: 'already_terminal' };
    purge = error.row?.state === 'rejected' && !error.row.erased;
  }
  // Rejection + pending fence + ID-only governance event commit before I/O.
  // Failed deletion is retried by this step and independently by the purge relay.
  if (purge) await deps.storage.deletePrefix(`m/${mediaId}/`);
  // A source fence committed after preparation is deliberately not cleared here.
  // Every final disclosure/download must independently enforce its current value.
  return outcome;
}
