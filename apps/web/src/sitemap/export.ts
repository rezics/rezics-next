import { packShards, sitemapIndexXml, type SitemapFamily, type SitemapShard } from './pack.ts';

export type SitemapExportFeed<Item> = {
  type: string;
  read(cursor: string | null): Promise<{ items: Item[]; next: string | null }>;
  family(item: Item): SitemapFamily | null;
  key?(item: Item): string;
};

export type SitemapObject = { key?: string; etag: string; uploaded: string };
export type SitemapWriteCondition = { ifMatch?: string; ifNoneMatch?: boolean };

export interface SitemapStore {
  head(key: string): Promise<SitemapObject | null>;
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: string | Uint8Array, condition?: SitemapWriteCondition): Promise<SitemapObject | null>;
  list(prefix: string): Promise<SitemapObject[]>;
  delete(key: string): Promise<void>;
}

/** Adapts R2's conditional writes and paged listings to the export's small store contract. */
export function sitemapR2Store(bucket: R2Bucket): SitemapStore {
  const object = (key: string, etag: string, uploaded: Date): SitemapObject => ({
    key,
    etag,
    uploaded: uploaded.toISOString(),
  });
  return {
    async head(key) {
      const value = await bucket.head(key);
      return value ? object(key, value.httpEtag, value.uploaded) : null;
    },
    async get(key) {
      const value = await bucket.get(key);
      return value ? new Uint8Array(await value.arrayBuffer()) : null;
    },
    async put(key, value, condition) {
      const onlyIf: R2Conditional | undefined = condition?.ifMatch
        ? { etagMatches: condition.ifMatch }
        : condition?.ifNoneMatch
          ? { etagDoesNotMatch: '*' }
          : undefined;
      const stored = await bucket.put(key, value, {
        ...(onlyIf ? { onlyIf } : {}),
        httpMetadata: {
          contentType:
            key === indexKey
              ? 'application/xml; charset=utf-8'
              : key.endsWith('.xml.gz')
                ? 'application/gzip'
                : 'application/json; charset=utf-8',
        },
      });
      return stored ? object(key, stored.httpEtag, stored.uploaded) : null;
    },
    async list(prefix) {
      const items: SitemapObject[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix, limit: 1_000, ...(cursor ? { cursor } : {}) });
        items.push(...page.objects.map((value) => object(value.key, value.httpEtag, value.uploaded)));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return items;
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}

export type SitemapRetryPolicy = {
  limit: number;
  delay(error: unknown, retry: number): number;
  shouldRetry(error: unknown): boolean;
};

export interface SitemapStepRunner {
  do<T>(name: string, run: () => Promise<T>, retry: SitemapRetryPolicy): Promise<T>;
}

export type SitemapExportOptions<Item = unknown> = {
  runId: string;
  origin: string;
  store: SitemapStore;
  runner: SitemapStepRunner;
  feeds: readonly SitemapExportFeed<Item>[];
  now?: () => Date;
  log?: (record: { message: 'sitemap export failed'; feed: string; step: string; error: unknown }) => void;
  pack?: (origin: string, families: readonly SitemapFamily[]) => Promise<SitemapShard[]>;
};

export type SitemapWorkflowStarter = {
  create(options: { id: string; params?: Record<string, unknown> }): Promise<unknown>;
};

export type SitemapWorkflowBinding = SitemapWorkflowStarter & {
  get(id: string): Promise<{ status(): Promise<{ status: string; error?: { message?: string } }> }>;
};

export type SitemapExportFile = { key: string; uploaded: string };
type ExportFile = SitemapExportFile;
type PageBatch = {
  next: string | null;
  files: ExportFile[];
  lastKey: string | undefined;
  previousIds: string[];
  cursorRejected: boolean;
};

const indexKey = 'index.xml';
const defaultPack = packShards;
const batchFamilyLimit = 2_000;
const batchRequestLimit = 20;
const retryLimit = 5;
const retryBaseMs = 10_000;
const retentionMs = 7 * 24 * 60 * 60 * 1000;
const fileName = /^shards\/([a-z]+)-([0-9a-f]{24})\.xml\.gz$/;

class NoProgressError extends Error {
  constructor(feed: string) {
    super(`Feed ${feed} made no progress in item order`);
    this.name = 'NoProgressError';
  }
}

class CursorRestartError extends Error {
  constructor(feed: string) {
    super(`Feed ${feed} rejected its cursor twice`);
    this.name = 'CursorRestartError';
  }
}

class StaleIndexError extends Error {
  constructor() {
    super('Sitemap export could not conditionally replace a newer index');
    this.name = 'StaleIndexError';
  }
}

function record(error: unknown): Record<string, unknown> {
  return error !== null && typeof error === 'object' ? (error as Record<string, unknown>) : {};
}

function statusOf(error: unknown): number | undefined {
  const value = record(error);
  if (typeof value.status === 'number') return value.status;
  const response = record(value.response);
  return typeof response.status === 'number' ? response.status : undefined;
}

function isCursorRejection(error: unknown): boolean {
  return statusOf(error) === 400;
}

function retryAfterMs(error: unknown): number {
  const value = record(error);
  const direct = value.retryAfterMs ?? value.retryAfter;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct > 1_000 ? direct : direct * 1_000;
  const headers = record(value.headers);
  const response = record(value.response);
  const responseHeaders = record(response.headers);
  const raw =
    typeof headers.get === 'function'
      ? (headers.get as (name: string) => string | null)('retry-after')
      : typeof responseHeaders.get === 'function'
        ? (responseHeaders.get as (name: string) => string | null)('retry-after')
        : undefined;
  if (typeof raw !== 'string') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

export function sitemapRetryDelay(error: unknown, retry: number): number {
  const exponential = retryBaseMs * 2 ** Math.max(0, retry - 1);
  return Math.max(exponential, retryAfterMs(error));
}

export function shouldRetrySitemapStep(error: unknown): boolean {
  return !(error instanceof NoProgressError || error instanceof CursorRestartError || error instanceof StaleIndexError);
}

export function sitemapStepRetryPolicy(): SitemapRetryPolicy {
  return { limit: retryLimit, delay: sitemapRetryDelay, shouldRetry: shouldRetrySitemapStep };
}

function parseUploaded(value: string, key: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error(`R2 object ${key} has an invalid upload time`);
  return date.toISOString();
}

function filePath(key: string): string {
  const match = fileName.exec(key);
  if (!match) throw new Error(`Invalid sitemap shard key ${key}`);
  return `/sitemap-${match[1]}-${match[2]}.xml.gz`;
}

async function saveShard(store: SitemapStore, type: string, shard: SitemapShard): Promise<ExportFile> {
  if (!/^[a-z]+$/.test(type)) throw new Error(`Sitemap feed type must contain lowercase letters: ${type}`);
  if (!/^[0-9a-f]{24}$/.test(shard.digest)) throw new Error(`Invalid sitemap shard digest for ${type}`);
  const key = `shards/${type}-${shard.digest}.xml.gz`;
  const existing = await store.head(key);
  if (existing) return { key, uploaded: parseUploaded(existing.uploaded, key) };
  const written = await store.put(key, shard.gzip, { ifNoneMatch: true });
  if (written) return { key, uploaded: parseUploaded(written.uploaded, key) };
  const raced = await store.head(key);
  if (!raced) throw new Error(`Sitemap shard ${key} was not present after a conditional write`);
  return { key, uploaded: parseUploaded(raced.uploaded, key) };
}

function itemId<Item>(feed: SitemapExportFeed<Item>, item: Item): string {
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object' && item !== null && 'id' in item && typeof item.id === 'string') return item.id;
  throw new Error(`Feed ${feed.type} returned an item without an id`);
}

async function readBatch<Item>(
  feed: SitemapExportFeed<Item>,
  cursor: string | null,
  lastKey: string | undefined,
  previousIds: readonly string[],
  store: SitemapStore,
  origin: string,
  pack: (origin: string, families: readonly SitemapFamily[]) => Promise<SitemapShard[]>,
): Promise<PageBatch> {
  const families: SitemapFamily[] = [];
  const files = new Map<string, ExportFile>();
  let lastPageKey = lastKey;
  let lastPageIds = [...previousIds];
  let next = cursor;
  let requests = 0;
  while ((requests === 0 || next !== null) && requests < batchRequestLimit && families.length < batchFamilyLimit) {
    let page: { items: Item[]; next: string | null };
    try {
      page = await feed.read(next);
    } catch (error) {
      if (isCursorRejection(error))
        return { next: null, files: [], lastKey: undefined, previousIds: [], cursorRejected: true };
      throw error;
    }
    requests += 1;
    if (feed.key) {
      if (page.items.length > 0) {
        const firstKey = feed.key(page.items[0]!);
        if (lastPageKey !== undefined && firstKey <= lastPageKey) throw new NoProgressError(feed.type);
        lastPageKey = feed.key(page.items.at(-1)!);
      }
      lastPageIds = [];
    } else {
      const ids = page.items.map((item) => itemId(feed, item));
      const previous = new Set(lastPageIds);
      if (ids.some((id) => previous.has(id))) throw new NoProgressError(feed.type);
      lastPageIds = ids;
    }
    for (const item of page.items) {
      const value = feed.family(item);
      if (value) families.push(value);
    }
    next = page.next;
  }
  for (const shard of await pack(origin, families)) {
    const file = await saveShard(store, feed.type, shard);
    files.set(file.key, file);
  }
  return { next, files: [...files.values()], lastKey: lastPageKey, previousIds: lastPageIds, cursorRejected: false };
}

export async function exportSitemapFeed<Item>(
  runId: string,
  feed: SitemapExportFeed<Item>,
  options: SitemapExportOptions,
): Promise<ExportFile[]> {
  const files = new Map<string, ExportFile>();
  const pack = options.pack ?? defaultPack;
  let cursor: string | null = null;
  let lastKey: string | undefined;
  let previousIds: string[] = [];
  let restarted = false;
  let stepNumber = 0;
  let lastStep = `${feed.type}:0`;
  for (;;) {
    const name = `${feed.type}:${stepNumber}`;
    lastStep = name;
    let result: PageBatch;
    try {
      result = await options.runner.do(
        name,
        () => readBatch(feed, cursor, lastKey, previousIds, options.store, options.origin, pack),
        sitemapStepRetryPolicy(),
      );
    } catch (error) {
      options.log?.({ message: 'sitemap export failed', feed: feed.type, step: name, error });
      throw error;
    }
    if (result.cursorRejected) {
      if (restarted) {
        const error = new CursorRestartError(feed.type);
        options.log?.({ message: 'sitemap export failed', feed: feed.type, step: name, error });
        throw error;
      }
      restarted = true;
      cursor = null;
      lastKey = undefined;
      previousIds = [];
      files.clear();
      stepNumber += 1;
      continue;
    }
    for (const file of result.files) files.set(file.key, file);
    cursor = result.next;
    lastKey = result.lastKey;
    previousIds = result.previousIds;
    stepNumber += 1;
    if (cursor === null) break;
  }
  const keptFiles = [...files.values()];
  try {
    await options.store.put(`runs/${runId}/${feed.type}.json`, JSON.stringify(keptFiles));
  } catch (error) {
    options.log?.({ message: 'sitemap export failed', feed: feed.type, step: lastStep, error });
    throw error;
  }
  return keptFiles;
}

export type SitemapFeedSegmentState = {
  segment: number | string;
  cursor: string | null;
  restarted: boolean;
  lastKey?: string;
  previousIds?: string[];
};

/** Runs no more than 4,990 feed steps, leaving room for checkpoint and continuation steps in the Workflow instance. */
export async function exportSitemapFeedSegment<Item>(
  runId: string,
  feed: SitemapExportFeed<Item>,
  options: SitemapExportOptions<Item>,
  segment: number,
  maxSteps = 4_990,
): Promise<boolean> {
  const stateKey = `runs/${runId}/state/${feed.type}.json`;
  const partPrefix = `runs/${runId}/parts/${feed.type}/`;
  let state: SitemapFeedSegmentState = { segment, cursor: null, restarted: false };
  if (segment > 0) {
    state = jsonValue<SitemapFeedSegmentState>(await options.store.get(stateKey), stateKey);
    if (Number(state.segment) !== segment) throw new Error(`Sitemap feed ${feed.type} has an unexpected segment state`);
  }
  let cursor = state.cursor;
  let lastKey = typeof state.lastKey === 'string' ? state.lastKey : undefined;
  let previousIds = Array.isArray(state.previousIds)
    ? state.previousIds.filter((id): id is string => typeof id === 'string')
    : [];
  let restarted = state.restarted;
  const files = new Map<string, ExportFile>();
  let stepNumber = 0;
  while (stepNumber < maxSteps) {
    const name = `${feed.type}:${segment}:${stepNumber}`;
    let result: PageBatch;
    try {
      result = await options.runner.do(
        name,
        () => readBatch(feed, cursor, lastKey, previousIds, options.store, options.origin, options.pack ?? defaultPack),
        sitemapStepRetryPolicy(),
      );
    } catch (error) {
      options.log?.({ message: 'sitemap export failed', feed: feed.type, step: name, error });
      throw error;
    }
    stepNumber += 1;
    if (result.cursorRejected) {
      if (restarted) {
        const error = new CursorRestartError(feed.type);
        options.log?.({ message: 'sitemap export failed', feed: feed.type, step: name, error });
        throw error;
      }
      restarted = true;
      cursor = null;
      lastKey = undefined;
      previousIds = [];
      files.clear();
      for (const part of await options.store.list(partPrefix)) await options.store.delete(part.key!);
      continue;
    }
    for (const file of result.files) files.set(file.key, file);
    cursor = result.next;
    lastKey = result.lastKey;
    previousIds = result.previousIds;
    if (cursor === null) {
      const completed = new Map<string, ExportFile>();
      for (const part of await options.store.list(partPrefix)) {
        const values = jsonValue<ExportFile[]>(await options.store.get(part.key!), part.key!);
        for (const file of values) completed.set(file.key, file);
      }
      for (const file of files.values()) completed.set(file.key, file);
      const keptFiles = [...completed.values()];
      await options.store.put(`runs/${runId}/${feed.type}.json`, JSON.stringify(keptFiles));
      await options.store.delete(stateKey).catch(() => undefined);
      for (const part of await options.store.list(partPrefix)) await options.store.delete(part.key!);
      return true;
    }
  }

  if (files.size > 0) {
    const partKey = `${partPrefix}${String(segment).padStart(4, '0')}.json`;
    await options.store.put(partKey, JSON.stringify([...files.values()]));
  }
  await options.store.put(
    stateKey,
    JSON.stringify({
      segment: String(segment + 1).padStart(16, '0'),
      cursor,
      restarted,
      ...(lastKey === undefined ? {} : { lastKey }),
      ...(previousIds.length === 0 ? {} : { previousIds }),
    } satisfies SitemapFeedSegmentState),
  );
  return false;
}

export async function readSitemapFeedFiles(
  store: SitemapStore,
  runId: string,
  type: string,
): Promise<SitemapExportFile[]> {
  const key = `runs/${runId}/${type}.json`;
  return jsonValue<SitemapExportFile[]>(await store.get(key), key);
}

function jsonValue<T>(bytes: Uint8Array | null, key: string): T {
  if (!bytes) throw new Error(`Missing sitemap export metadata ${key}`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new Error(`Invalid sitemap export metadata ${key}`, { cause });
  }
}

type PublishedRun = { publishedAt: string; types: string[] };

async function cleanup(
  store: SitemapStore,
  now: Date,
  currentFiles: readonly ExportFile[],
  shards: readonly SitemapObject[],
  runObjects: readonly SitemapObject[],
): Promise<void> {
  const cutoff = now.valueOf() - retentionMs;
  const markers = runObjects.filter((object) => object.key?.endsWith('/published.json'));
  const recent = new Set(currentFiles.map((file) => file.key));
  const lastListed = new Map<string, number>();
  const runTimes = new Map<string, number>();

  for (const marker of markers) {
    const key = marker.key!;
    const runId = key.slice('runs/'.length, -'/published.json'.length);
    const body = await store.get(key);
    const published = jsonValue<PublishedRun>(body, key);
    const publishedAt = Date.parse(published.publishedAt);
    if (!Number.isFinite(publishedAt)) throw new Error(`Sitemap run ${runId} has an invalid publication time`);
    runTimes.set(runId, publishedAt);
    for (const type of published.types) {
      const listKey = `runs/${runId}/${type}.json`;
      const listBody = await store.get(listKey);
      const files = jsonValue<ExportFile[]>(listBody, listKey);
      for (const file of files) {
        lastListed.set(file.key, Math.max(publishedAt, lastListed.get(file.key) ?? -Infinity));
        if (publishedAt > cutoff) recent.add(file.key);
      }
    }
  }

  for (const shard of shards) {
    const key = shard.key!;
    if (recent.has(key)) continue;
    const last = lastListed.get(key) ?? Date.parse(shard.uploaded);
    if (Number.isFinite(last) && now.valueOf() - last >= retentionMs) await store.delete(key);
  }

  const runIds = new Set(runObjects.map((object) => /^runs\/([^/]+)\//.exec(object.key ?? '')?.[1]).filter(Boolean));
  for (const runId of runIds) {
    const time =
      runTimes.get(runId!) ??
      Math.max(
        ...runObjects
          .filter((object) => object.key?.startsWith(`runs/${runId}/`))
          .map((object) => Date.parse(object.uploaded))
          .filter(Number.isFinite),
      );
    if (Number.isFinite(time) && now.valueOf() - time >= retentionMs) {
      for (const object of runObjects) {
        if (object.key?.startsWith(`runs/${runId}/`)) await store.delete(object.key);
      }
    }
  }
}

export type SitemapPublicationOptions = {
  runId: string;
  origin: string;
  store: SitemapStore;
  indexSnapshot: SitemapObject | null;
  filesByFeed: ReadonlyMap<string, readonly SitemapExportFile[]>;
  now: Date;
  log?: SitemapExportOptions['log'];
};

/** Validates the completed feed lists, then conditionally publishes the index after all shard writes. */
export async function publishSitemapExport(options: SitemapPublicationOptions): Promise<void> {
  const feedKeys = [...options.filesByFeed.keys()];
  const files = [...options.filesByFeed.values()].flat();
  const uniqueFilesByKey = new Map<string, ExportFile>();
  for (const file of files) uniqueFilesByKey.set(file.key, file);
  const uniqueFiles = [...uniqueFilesByKey.values()];
  try {
    if (uniqueFiles.length > 50_000)
      throw new Error(`A sitemap index holds at most 50,000 files, got ${uniqueFiles.length}`);
    const entries = uniqueFiles.map((file) => ({
      path: filePath(file.key),
      lastmod: parseUploaded(file.uploaded, file.key),
    }));
    const xml = sitemapIndexXml(options.origin, entries);
    const shards = await options.store.list('shards/');
    const existing = new Set(shards.map((shard) => shard.key));
    for (const file of uniqueFiles) {
      if (!existing.has(file.key)) throw new Error(`Listed sitemap shard ${file.key} does not exist`);
    }
    // Stage the run marker before publication. A lost conditional write removes it best-effort; at worst, a stale
    // marker retains extra shards until the next cleanup pass.
    await options.store.put(
      `runs/${options.runId}/published.json`,
      JSON.stringify({ publishedAt: options.now.toISOString(), types: feedKeys } satisfies PublishedRun),
    );
    const runObjects = await options.store.list('runs/');
    let published = false;
    try {
      const result = await options.store.put(
        indexKey,
        xml,
        options.indexSnapshot ? { ifMatch: options.indexSnapshot.etag } : { ifNoneMatch: true },
      );
      published = Boolean(result);
    } catch (error) {
      const latest = await options.store.get(indexKey);
      if (latest && new TextDecoder().decode(latest) === xml) published = true;
      else throw error;
    }
    if (!published) {
      const latest = await options.store.get(indexKey);
      if (latest && new TextDecoder().decode(latest) === xml) published = true;
    }
    if (!published) {
      try {
        await options.store.delete(`runs/${options.runId}/published.json`);
      } catch {
        // A stale marker only delays garbage collection; it cannot affect the public index or its shards.
      }
      throw new StaleIndexError();
    }
    try {
      await cleanup(options.store, options.now, uniqueFiles, shards, runObjects);
    } catch (error) {
      options.log?.({ message: 'sitemap export failed', feed: 'publication', step: 'cleanup', error });
    }
  } catch (error) {
    options.log?.({ message: 'sitemap export failed', feed: 'publication', step: 'publish-index', error });
    throw error;
  }
}

/** Collects a complete inventory, writes children first, and conditionally replaces the index last. */
export async function exportSitemaps<Item>(options: SitemapExportOptions<Item>): Promise<void> {
  const now = options.now?.() ?? new Date();
  const originalIndex = await options.store.head(indexKey);
  const feedTypes = new Set<string>();
  for (const feed of options.feeds) {
    if (!/^[a-z]+$/.test(feed.type)) throw new Error(`Sitemap feed type must contain lowercase letters: ${feed.type}`);
    if (feedTypes.has(feed.type)) throw new Error(`Duplicate sitemap feed type ${feed.type}`);
    feedTypes.add(feed.type);
  }

  const exported = await Promise.all(options.feeds.map((feed) => exportSitemapFeed(options.runId, feed, options)));
  const filesByFeed = new Map(options.feeds.map((feed, index) => [feed.type, exported[index]!]));
  await publishSitemapExport({
    runId: options.runId,
    origin: options.origin,
    store: options.store,
    indexSnapshot: originalIndex,
    filesByFeed,
    now,
    log: options.log,
  });
}

/** Starts the one daily instance named by its UTC calendar day; a duplicate id means the day already started. */
export async function startDailySitemapExport(
  workflow: SitemapWorkflowStarter,
  scheduledTime: number | Date,
): Promise<boolean> {
  const date = scheduledTime instanceof Date ? scheduledTime : new Date(scheduledTime);
  if (!Number.isFinite(date.valueOf())) throw new Error('Sitemap schedule has an invalid timestamp');
  const id = `sitemaps-${date.toISOString().slice(0, 10)}`;
  return startSitemapWorkflow(workflow, id);
}

export async function startSitemapWorkflow(
  workflow: SitemapWorkflowStarter,
  id: string,
  params?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await workflow.create({ id, ...(params ? { params } : {}) });
    return true;
  } catch (error) {
    const value = record(error);
    const message = error instanceof Error ? error.message : String(error);
    if (value.code === 409 || /already exists|duplicate instance/i.test(message)) return false;
    throw error;
  }
}
