import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  commitVerified,
  CorruptBytes,
  PaceClock,
  pacedFetch,
  PacedRetriesExhausted,
  readVerified,
  retryAfterSecondsOrHttpDate,
} from '../lib/paced-fetch.ts';
import { atomicJson, blobPath, canonical, sha256 } from './store.ts';

export interface Capture {
  url: string;
  digest: string;
  bytes: number;
  mediaType: string;
  fetchedAt: string;
  etag: string | null;
  lastModified: string | null;
}
export class MissingRemote extends Error {
  constructor(readonly url: string) {
    super(`HTTP 404: ${url}`);
  }
}
export class RemoteUnavailable extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`Acquisition HTTP ${status}: ${url}`);
  }
}

function intervalMs(host: string): number {
  if (host === 'musicbrainz.org') return 1_100;
  if (host === 'api.vndb.org') return 1_600;
  if (host === 'api.bgm.tv') return 1_000;
  return 100;
}

/** One process owns acquisition. Cached responses make interruption/restart resumable.
 * Requests and retries share each provider's limiter. A snapshot freezes captured bytes;
 * an API crawl records its acquisition interval, never claims a point-in-time dump. */
export class Acquisition {
  readonly captures = new Map<string, Capture>();
  private readonly clock: PaceClock;
  constructor(
    readonly root: string,
    readonly refresh = false,
    private readonly fetcher: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
    now: () => number = Date.now,
  ) {
    this.clock = new PaceClock(sleep, now);
  }

  async capture(
    url: string,
    options: { body?: unknown; limit?: number; expectedDigest?: string } = {},
  ): Promise<Capture> {
    if (!url.startsWith('https://')) throw new Error(`Acquisition requires HTTPS: ${url}`);
    const key = sha256(canonical([url, options.body ?? null]));
    const path = join(this.root, 'raw/requests', `${key}.json`);
    if (!this.refresh && existsSync(path)) {
      const prior = JSON.parse(readFileSync(path, 'utf8')) as Capture;
      try {
        const bytes = readVerified(blobPath(this.root, prior.digest), prior.digest);
        if (
          prior.url !== url ||
          bytes.length !== prior.bytes ||
          bytes.length > (options.limit ?? 32 * 1024 * 1024) ||
          (options.expectedDigest && options.expectedDigest !== prior.digest)
        )
          throw new Error(`Invalid cached acquisition: ${url}`);
        this.captures.set(key, prior);
        return prior;
      } catch (error) {
        // Corrupt bytes are not the captured object, so acquire them again.
        if (!(error instanceof CorruptBytes)) throw error;
      }
    }
    const host = new URL(url).hostname;
    const interval = intervalMs(host);
    try {
      return await pacedFetch(
        this.clock,
        {
          spacing: 'start',
          intervalMs: interval,
          maxAttempts: 5,
          retryAfterCapMs: 120_000,
          retryStatus: (status) => status === 429 || status >= 500,
          fallbackWaitMs: (attempt) => 1_000 * 2 ** attempt,
          retryAfterMs: retryAfterSecondsOrHttpDate,
          onTransport: (cause, _attempt, remaining) =>
            remaining ? undefined : new Error(`Acquisition failed: ${url}`, { cause }),
          retryRead: (cause, _attempt, remaining) =>
            remaining &&
            !(cause instanceof Error && /exceeded|digest mismatch/.test(cause.message)),
        },
        {
          url,
          paceKey: host,
          timeoutMs: (options.limit ?? 0) >= 512 * 1024 * 1024 ? 600_000 : 30_000,
          init: {
            method: options.body === undefined ? 'GET' : 'POST',
            headers: {
              'user-agent': 'REZICSLocalDatasets/1.0 (+https://github.com/rezics/rezics-next)',
              accept: 'application/json, application/octet-stream;q=0.9, */*;q=0.8',
              ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          },
        },
        this.fetcher,
        (response) => this.storeResponse(response, url, options, key, path),
      );
    } catch (error) {
      if (error instanceof PacedRetriesExhausted) throw new RemoteUnavailable(url, error.status);
      throw error;
    }
  }

  private async storeResponse(
    response: Response,
    url: string,
    options: { limit?: number; expectedDigest?: string },
    key: string,
    metaPath: string,
  ): Promise<Capture> {
    if (response.status === 404) {
      await response.body?.cancel();
      throw new MissingRemote(url);
    }
    if (!response.ok || !response.body)
      throw new Error(`Acquisition HTTP ${response.status}: ${url}`);
    const temporary = join(this.root, '.temp/downloads', `${process.pid}-${key}.download`);
    mkdirSync(dirname(temporary), { recursive: true });
    const limit = options.limit ?? 32 * 1024 * 1024;
    let bytes = 0;
    const hash = createHash('sha256');
    try {
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limit) {
            callback(new Error(`Acquisition exceeded ${limit} bytes: ${url}`));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body as never),
        measure,
        createWriteStream(temporary),
      );
      const digest = hash.digest('hex');
      if (options.expectedDigest && digest !== options.expectedDigest)
        throw new Error(`Upstream digest mismatch: ${url}`);
      commitVerified(blobPath(this.root, digest), temporary, digest);
      const capture: Capture = {
        url,
        digest,
        bytes,
        fetchedAt: new Date().toISOString(),
        mediaType:
          response.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
      };
      atomicJson(metaPath, capture);
      this.captures.set(key, capture);
      if (bytes > 100 * 1024 * 1024 || this.captures.size % 25 === 0)
        console.log(`Captured ${this.captures.size} responses; last ${bytes} bytes: ${url}`);
      return capture;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  async json(url: string, body?: unknown): Promise<unknown> {
    const capture = await this.capture(url, { body });
    return JSON.parse(
      readVerified(blobPath(this.root, capture.digest), capture.digest).toString('utf8'),
    );
  }
}
