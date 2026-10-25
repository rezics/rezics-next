import type { MediaImportRequest } from '@rezics/definitions/media-import';
import type { MediaImportJobDependencies, processImportedMedia } from '../../src/content/media-import-job.ts';
import type { processImage } from '../../src/content/image-job.ts';
import type { MediaState, MediaVariant } from '../../src/content/media.ts';
import type { SourceFenceTuple } from '../../src/content/source-fences.ts';
import type { CONTENT_QUEUES, CONTENT_WORKFLOWS } from '../../src/content/work-contract.ts';

export const MISSING_MEDIA_BOUNDARY = 'Import media boundary fixture is not implemented';

/** Private external-boundary data, never a replacement fetch job or validator. */
export interface SourceFixture {
  url: string;
  /** Deterministic encoded image delivered by the HTTP fixture, not raw pixels. */
  bytes: Uint8Array;
}
export type SourceFault =
  | 'redirect-denied-host'
  | 'redirect-private-ip'
  | 'redirect-loop'
  | 'stream-over-20-mib'
  | 'timeout'
  | 'over-40-megapixels'
  | 'corrupt-image';
export interface MediaBoundaryOptions {
  /** Shared real database, Access, clock and route key; supplied by the API assembly. */
  content: Omit<MediaImportJobDependencies, 'storage' | 'fetchConfig'>;
  /** Exact production host configuration; no fixture-domain or wildcard addition. */
  fetchConfig: MediaImportJobDependencies['fetchConfig'];
}
export interface NativeMediaObservation {
  /** Read existing content.media and media_variant rows by route + media ID. */
  row: Readonly<{
    id: string;
    containerId: string;
    uploaderId: string;
    purpose: 'cover' | 'post-image';
    state: MediaState;
    sha256: string | null;
    sourceUrl: string;
    credit: MediaImportRequest['credit'];
    provenance: MediaImportRequest['provenance'];
    collectionPending: boolean;
  }>;
  /** Committed native events/rows in order, never inferred from requested outcomes. */
  transitions: readonly MediaState[];
  events: readonly { type: string; transactionId: string }[];
  variants: readonly (MediaVariant & { bytes: Uint8Array })[];
  original: Uint8Array | null;
  /** Actual production fence-read bind parameters, never reconstructed from expected input. */
  fence: SourceFenceTuple;
}
export interface MediaBoundary {
  /** Production MediaStorage interface (also implemented by R2Storage), faked here ONLY. */
  configuration: Pick<MediaImportJobDependencies, 'storage' | 'fetchConfig'>;
  /** Serve this exact native HTTPS URL. Stream overflow omits Content-Length;
   * timeout stalls the response. Neither mode changes production limits.
   */
  source(url: string, fault?: SourceFault): Promise<SourceFixture>;
  /** Fail one real object-store operation; never fabricate a content job result. */
  failNextPut(): void;
  /** Test facade over real registered dispatch; not a new production queue API.
   * Redelivery reuses the captured event and native deterministic workflow ID.
   * Aborting stops the bounded drain; it cannot invent a terminal DBOS state.
   */
  drain(input: { mediaIds: readonly string[]; maxJobs: 16; signal: AbortSignal; redeliver?: boolean }): Promise<void>;
  observe(mediaId: string): Promise<NativeMediaObservation>;
  capture(): Promise<{
    sourceRequests: readonly { url: string; bytes: number; headers: Headers; responseHeaders: Headers }[];
    liveInternetRequests: readonly string[];
    peakBufferedSourceBytes: number;
    executedJobs: number;
    registrations: readonly (
      | {
          name: typeof CONTENT_WORKFLOWS.importFromUrl;
          queue: typeof CONTENT_QUEUES.importFromUrl;
          handler: typeof processImportedMedia;
        }
      | {
          name: typeof CONTENT_WORKFLOWS.image;
          queue: typeof CONTENT_QUEUES.image;
          handler: typeof processImage;
        }
    )[];
    calls: readonly { workflowId: string; name: string; mediaId: string }[];
  }>;
  close(): Promise<void>;
}

/**
 * TEST ONLY composition stub. Bind content/media-import.ts importMediaFromUrl and
 * readMediaImportStatus, media-import-job.ts processImportedMedia (which invokes
 * fetch-source-image.ts fetchSourceImage), image-job.ts processImage and
 * image-transform.ts transformImage. Keep media-import.ts tupleRoute/readFences
 * checks at the tuple home. Preserve the portable request/accepted/status schemas.
 *
 * work/registry.ts composeWork owns one process-wide registration/launch through
 * worker.ts startWorker. Use content/work-contract.ts native identities; never
 * call job bodies instead of registered dispatch, mock DBOS, or launch a worker
 * per module/test. This checkout has no content WorkModule registration or
 * createKernel content configuration slot yet: those remain unavailable, not
 * invented here. The later API assembly supplies identity/bootstrap/routes and
 * public setup commands; this fixture must not seed media outcomes with SQL.
 *
 * Intercept only external HTTP (deterministic encoded images) and MediaStorage.
 * Zero live Internet, including redirects/DNS. If the actual adapter requires DNS
 * data, supply external responses while retaining its real SSRF/private-IP checks.
 * Keep HTTPS/exact configured source hosts, <=3 redirects, 20MiB streamed input,
 * one 15s deadline and Sharp's 40MP limit active; <=12 reencoded variants. Native
 * Bangumi/OL hosts are lain.bgm.tv/covers.openlibrary.org. VNDB currently projects
 * no cover intent; do not invent a VNDB host exemption or enable arbitrary hosts.
 *
 * Observe actual input bytes, stored objects and registered calls. Bound each
 * drain to <=16 jobs, <=64 source URLs, one container partition plus independently
 * released tuple-home fence reads; keyed constant status/job rows, no scans.
 * Image memory is bounded per input M, not catalogue/history N/U times elapsed t.
 * Full API growth later uses one seed at three scales and shared Postgres capture
 * including nested Auth/Access/fence/receipts; no elapsed-time performance oracle.
 * No Auth/Access/document/fence/receipt fakes, public hotlinks, BFF, media:complete,
 * importer image-byte work or lifecycle/private authorization proof in this suite.
 */
export async function createMediaBoundary(_options: MediaBoundaryOptions): Promise<MediaBoundary> {
  throw new Error(MISSING_MEDIA_BOUNDARY);
}
