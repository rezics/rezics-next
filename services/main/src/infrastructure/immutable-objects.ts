import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { AwsClient } from 'aws4fetch';

const DIGEST = /^[0-9a-f]{64}$/;
const S3_XML_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';

/**
 * Verified immutable bytes, keyed by digest, for this process only. Main and
 * the relay each have their own copy. A digest names one body, including
 * across retention prefixes, so a hit is not re-hashed and is not a freshness
 * or tombstone check.
 *
 * Bounds: at most 512 entries and 32 MiB. An object over 1 MiB is not stored.
 * Least-recently-used entries leave first. A hit does not extend the 60 s TTL,
 * so a destroyed object cannot be served for the life of a busy process when
 * an erasure path missed its eviction.
 *
 * Nothing enters after a failed digest check, a short read, a budget refusal,
 * or an aborted body. `discard` and the in-process object destruction paths
 * evict the digest. Readers that resolve a live graph revision never ask for
 * a tombstoned digest; readers that fetch by digest alone are limited by this
 * TTL (and by eviction when destruction runs in-process).
 */
export const VERIFIED_OBJECT_CACHE_DEFAULTS = {
  maxEntries: 512,
  maxTotalBytes: 32 * 1024 * 1024,
  maxObjectBytes: 1024 * 1024,
  ttlMs: 60_000,
} as const;

interface VerifiedObjectCacheLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxObjectBytes: number;
  ttlMs: number;
}

interface VerifiedCacheEntry {
  bytes: Uint8Array;
  expiresAt: number;
}

interface VerifiedObjectCacheMetrics {
  hits: number;
  misses: number;
}

interface CacheReadGeneration {
  generation: number;
  activeReads: number;
}

interface CacheReadToken {
  state: CacheReadGeneration;
  generation: number;
}

class VerifiedObjectCache {
  private readonly entries = new Map<string, VerifiedCacheEntry>();
  private readonly activeReads = new Map<string, CacheReadGeneration>();
  private totalBytes = 0;
  hits = 0;
  misses = 0;
  limits: VerifiedObjectCacheLimits = { ...VERIFIED_OBJECT_CACHE_DEFAULTS };
  now: () => number = () => Date.now();

  lookup(digest: string): Uint8Array | undefined {
    const entry = this.entries.get(digest);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.remove(digest);
      return undefined;
    }
    this.entries.delete(digest);
    this.entries.set(digest, entry);
    return new Uint8Array(entry.bytes);
  }

  remember(digest: string, bytes: Uint8Array): void {
    if (!DIGEST.test(digest) || sha256(bytes) !== digest) return;
    if (bytes.byteLength > this.limits.maxObjectBytes || bytes.byteLength > this.limits.maxTotalBytes
      || this.limits.maxEntries < 1) return;
    if (this.entries.has(digest)) this.remove(digest);
    while (this.entries.size >= this.limits.maxEntries
      || this.totalBytes + bytes.byteLength > this.limits.maxTotalBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.remove(oldest);
    }
    const copy = new Uint8Array(bytes);
    this.entries.set(digest, { bytes: copy, expiresAt: this.now() + this.limits.ttlMs });
    this.totalBytes += copy.byteLength;
  }

  beginRead(digest: string): CacheReadToken {
    let state = this.activeReads.get(digest);
    if (!state) {
      state = { generation: 0, activeReads: 0 };
      this.activeReads.set(digest, state);
    }
    state.activeReads++;
    return { state, generation: state.generation };
  }

  rememberRead(digest: string, bytes: Uint8Array, token: CacheReadToken): boolean {
    if (this.activeReads.get(digest) !== token.state || token.state.generation !== token.generation) return false;
    this.remember(digest, bytes);
    return true;
  }

  endRead(digest: string, token: CacheReadToken): void {
    if (this.activeReads.get(digest) !== token.state) return;
    token.state.activeReads--;
    if (token.state.activeReads === 0) this.activeReads.delete(digest);
  }

  evict(digest: string): void {
    const active = this.activeReads.get(digest);
    if (active) active.generation++;
    this.remove(digest);
  }

  clear(): void {
    for (const active of this.activeReads.values()) active.generation++;
    this.entries.clear();
    this.totalBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.limits = { ...VERIFIED_OBJECT_CACHE_DEFAULTS };
    this.now = () => Date.now();
  }

  private remove(digest: string): void {
    const entry = this.entries.get(digest);
    if (!entry) return;
    this.totalBytes -= entry.bytes.byteLength;
    this.entries.delete(digest);
  }
}

const verifiedObjectCache = new VerifiedObjectCache();
const skipVerifiedObjectCache = new AsyncLocalStorage<true>();

/** Counters for tests. Not an endpoint. */
export function verifiedImmutableObjectCacheMetrics(): VerifiedObjectCacheMetrics {
  return { hits: verifiedObjectCache.hits, misses: verifiedObjectCache.misses };
}

/** Drop every entry, counter, limit override and clock. */
export function clearVerifiedImmutableObjectCache(): void {
  verifiedObjectCache.clear();
}

/** Shrink bounds or pin the clock. Production uses {@link VERIFIED_OBJECT_CACHE_DEFAULTS}. */
export function configureVerifiedImmutableObjectCache(options: {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxObjectBytes?: number;
  ttlMs?: number;
  now?: () => number;
}): void {
  verifiedObjectCache.limits = {
    maxEntries: options.maxEntries ?? verifiedObjectCache.limits.maxEntries,
    maxTotalBytes: options.maxTotalBytes ?? verifiedObjectCache.limits.maxTotalBytes,
    maxObjectBytes: options.maxObjectBytes ?? verifiedObjectCache.limits.maxObjectBytes,
    ttlMs: options.ttlMs ?? verifiedObjectCache.limits.ttlMs,
  };
  if (options.now) verifiedObjectCache.now = options.now;
}

/** Forget one digest in this process. Destruction paths call this after the bytes are gone. */
export function evictVerifiedImmutableObject(digest: string): void {
  verifiedObjectCache.evict(digest);
}

/**
 * Store bytes already checked against `digest`. A mismatch or an over-limit
 * body is ignored, so a caller cannot poison the cache.
 */
export function rememberVerifiedImmutableObject(digest: string, bytes: Uint8Array): void {
  verifiedObjectCache.remember(digest, bytes);
}

/** Read the store itself. Presence checks and publish read-back must not treat a cache hit as proof. */
export function withoutVerifiedImmutableObjectCache<T>(read: () => Promise<T>): Promise<T> {
  return skipVerifiedObjectCache.run(true, read);
}

function whenNotAborted(signal: AbortSignal | undefined, work: Promise<Uint8Array>): Promise<Uint8Array> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new ObjectUnavailable('committed immutable object is unavailable'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new ObjectUnavailable('committed immutable object is unavailable'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(bytes => {
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) reject(new ObjectUnavailable('committed immutable object is unavailable'));
      else resolve(new Uint8Array(bytes));
    }, error => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
}

export class ObjectUnavailable extends Error {}
/** The exact immutable key is absent; permission, timeout and service failures never use this error. */
export class ObjectNotFound extends ObjectUnavailable {}
export class ObjectIntegrityError extends Error {}
export class ObjectReadBudgetExceeded extends Error {}
export class ObjectListingUnavailable extends ObjectUnavailable {}
export class ObjectVersioningUnsupported extends ObjectUnavailable {}

export const IMMUTABLE_OBJECT_LISTING_LIMITS = {
  maxEntries: 256,
  maxResponseBytes: 1024 * 1024,
} as const;

export interface ImmutableObjectListOptions {
  /** Maximum returned keys. The adapter requests one extra key to detect overflow. */
  maxEntries: number;
  /** Shared budget for the versioning-capability and listing responses. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface ImmutableObjects {
  /** Return the digest only after a conditional create and verified read-back. */
  put(bytes: Uint8Array): Promise<string>;
  /** A missing object is unavailable; bytes with the wrong digest are corrupt. */
  get(digest: string, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array>;
  /** Probe one exact key; only a 404 is reported as {@link ObjectNotFound}. */
  probe?(digest: string, signal?: AbortSignal): Promise<void>;
  /** Remove one exact digest and prove it is absent with an uncached read-back. */
  deleteAndVerifyAbsent?(digest: string, signal?: AbortSignal): Promise<void>;
  /** List one complete, bounded prefix within this store's configured namespace. */
  listPrefix?(prefix: string, options: ImmutableObjectListOptions): Promise<readonly string[]>;
  /** Remove a known-unpublished staging candidate when the backend supports it. */
  discard?(digest: string, signal?: AbortSignal): Promise<void>;
}

export interface S3ObjectOptions {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  /** One privacy/retention domain. A digest in another domain has a distinct key. */
  prefix: string;
  /** Recovery reads share the enclosing command's remaining deadline. */
  readSignal?: () => AbortSignal;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function checkedDigest(digest: string): string {
  if (!DIGEST.test(digest)) throw new ObjectIntegrityError('invalid immutable object digest');
  return digest;
}

function checkedListingPrefix(prefix: string, namespace: string): string {
  const segments = prefix.split('/');
  if (!prefix.startsWith(namespace) || Buffer.byteLength(prefix, 'utf8') > 512
    || !/^[a-z0-9][a-z0-9._/-]*$/.test(prefix)
    || prefix.includes('//') || segments.some((segment, index) =>
      segment === '.' || segment === '..' || (!segment && index !== segments.length - 1))) {
    throw new ObjectIntegrityError('immutable object listing prefix is outside its namespace');
  }
  return prefix;
}

function xmlChildren(element: Element, name?: string): Element[] {
  return Array.from(element.childNodes).filter((node): node is Element =>
    node.nodeType === 1 && (!name || (node as Element).localName === name));
}

function xmlText(element: Element, name: string): string {
  const children = xmlChildren(element, name);
  if (children.length !== 1 || xmlChildren(children[0]!).length > 0) {
    throw new ObjectListingUnavailable('immutable object listing response is malformed');
  }
  return children[0]!.textContent?.trim() ?? '';
}

function xmlBoundedDecimal(element: Element, name: string, max: number): number {
  const children = xmlChildren(element, name);
  if (children.length !== 1 || xmlChildren(children[0]!).length > 0) {
    throw new ObjectListingUnavailable('immutable object listing count is not authoritative');
  }
  const decimal = children[0]!.textContent?.trim() ?? '';
  if (!/^\d+$/.test(decimal)) {
    throw new ObjectListingUnavailable('immutable object listing count is not authoritative');
  }
  const normalized = decimal.replace(/^0+(?=\d)/, '');
  const maximum = String(max);
  if (normalized.length > maximum.length
    || (normalized.length === maximum.length && normalized > maximum)) {
    throw new ObjectListingUnavailable('immutable object listing count is not authoritative');
  }
  return Number(normalized);
}

function xmlRawText(element: Element, name: string): string {
  const children = xmlChildren(element, name);
  if (children.length !== 1 || xmlChildren(children[0]!).length > 0) {
    throw new ObjectListingUnavailable('immutable object listing response is malformed');
  }
  return children[0]!.textContent ?? '';
}

function parseS3Xml(bytes: Uint8Array, rootName: string): Element {
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new ObjectListingUnavailable('immutable object listing response is not UTF-8'); }
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) {
    throw new ObjectListingUnavailable('immutable object listing response contains a declaration');
  }
  let malformed = false;
  let root: Element | null;
  try {
    root = new DOMParser({ onError: () => { malformed = true; } })
      .parseFromString(source, 'application/xml').documentElement;
  } catch {
    throw new ObjectListingUnavailable('immutable object listing response is malformed');
  }
  if (malformed || !root || root.localName !== rootName || root.namespaceURI !== S3_XML_NAMESPACE) {
    throw new ObjectListingUnavailable('immutable object listing response is malformed');
  }
  return root;
}

async function readS3ResponseWithinBudget(response: Response, budget: number): Promise<Uint8Array> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
      throw new ObjectListingUnavailable('immutable object listing response length is invalid');
    }
    if (Number(declaredLength) > budget) {
      await response.body?.cancel().catch(() => undefined);
      throw new ObjectReadBudgetExceeded('immutable object listing response exceeds its byte budget');
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > budget) {
        await reader.cancel().catch(() => undefined);
        throw new ObjectReadBudgetExceeded('immutable object listing response exceeds its byte budget');
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof ObjectReadBudgetExceeded) throw error;
    throw new ObjectListingUnavailable('immutable object listing response could not be read');
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Bun S3Client 1.4.2 cannot express If-None-Match on PUT and ignores NO_PROXY
 * for local reads on proxied hosts. Signed fetch covers both operations.
 */
export class S3ImmutableObjects implements ImmutableObjects {
  private readonly signer: AwsClient;
  private readonly bucket: string;
  private readonly bucketUrl: string;
  private readonly prefix: string;
  private readonly readSignal: (() => AbortSignal) | undefined;
  /** One store fetch shared by concurrent first reads of a digest on this client. */
  private readonly inflight = new Map<string, Promise<Uint8Array>>();

  constructor(options: S3ObjectOptions) {
    const endpoint = new URL(options.endpoint);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
      throw new Error('S3 endpoint must be an HTTP origin');
    }
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)
      || !/^(?:[a-z0-9][a-z0-9-]*\/)+$/.test(options.prefix)) {
      throw new Error('invalid S3 bucket or immutable namespace');
    }
    const region = options.region ?? 'us-east-1';
    this.bucket = options.bucket;
    this.bucketUrl = `${endpoint.origin}/${options.bucket}`;
    this.prefix = options.prefix;
    this.readSignal = options.readSignal;
    this.signer = new AwsClient({ accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey, service: 's3', region, retries: 0 });
  }

  private key(digest: string): string { return `${this.prefix}sha256/${checkedDigest(digest)}`; }

  /** Called before Main announces readiness; it creates only its configured bucket. */
  async initialize(): Promise<void> {
    let response: Response;
    try { response = await this.signer.fetch(this.bucketUrl, { method: 'PUT' }); }
    catch { throw new ObjectUnavailable('cannot reach immutable object bucket'); }
    if (!response.ok && response.status !== 409) {
      throw new ObjectUnavailable(`cannot initialize immutable object bucket (${response.status})`);
    }
    let readable: Response;
    try { readable = await this.signer.fetch(this.bucketUrl, { method: 'HEAD' }); }
    catch { throw new ObjectUnavailable('cannot verify immutable object bucket'); }
    if (!readable.ok) throw new ObjectUnavailable(`cannot access immutable object bucket (${readable.status})`);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const digest = sha256(bytes);
    const key = this.key(digest);
    const body = new Uint8Array(bytes);
    let response: Response;
    try {
      response = await this.signer.fetch(`${this.bucketUrl}/${key}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/octet-stream',
          // Signing turns the bytes into a Request stream. Keep their known
          // length explicit for S3 peers that reject chunked uploads (411).
          'content-length': String(body.byteLength),
          'if-none-match': '*',
          'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
        },
        body,
        aws: { allHeaders: true },
      });
    } catch {
      throw new ObjectUnavailable('immutable object create response is unavailable');
    }
    if (!response.ok && response.status !== 412 && response.status !== 409) {
      throw new ObjectUnavailable(`immutable object create failed (${response.status})`);
    }
    // A competing creator may have won. In either case, do not publish a manifest
    // until the exact bytes can be read through the selected backend. That
    // read-back skips the cache: a hit is not proof this namespace stored them.
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.readStoreAndRemember(digest);
        return digest;
      } catch (error) {
        if (!(error instanceof ObjectUnavailable) || attempt === 7) throw error;
        await Bun.sleep(25 * (attempt + 1));
      }
    }
    throw new ObjectUnavailable('immutable object was not visible after conditional create');
  }

  async get(digest: string, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1))
      throw new ObjectReadBudgetExceeded('invalid immutable object read budget');
    this.key(digest);
    if (signal?.aborted) throw new ObjectUnavailable('committed immutable object is unavailable');
    if (skipVerifiedObjectCache.getStore()) {
      return new Uint8Array(await this.readStore(digest, maxBytes, signal));
    }
    const cached = verifiedObjectCache.lookup(digest);
    if (cached) {
      // The store read uses this same signal. An aborted deadline must fail
      // that read, not receive cached bytes.
      const deadline = signal ?? this.readSignal?.();
      if (deadline?.aborted) return new Uint8Array(await this.readStore(digest, maxBytes, deadline));
      verifiedObjectCache.hits++;
      if (maxBytes !== undefined && cached.byteLength > maxBytes)
        throw new ObjectReadBudgetExceeded('immutable object exceeds its read budget');
      return cached;
    }
    verifiedObjectCache.misses++;
    const bytes = maxBytes === undefined
      ? await this.joinRead(digest, signal)
      : await this.readStoreAndRemember(digest, maxBytes, signal);
    if (signal?.aborted) throw new ObjectUnavailable('committed immutable object is unavailable');
    if (maxBytes !== undefined && bytes.byteLength > maxBytes)
      throw new ObjectReadBudgetExceeded('immutable object exceeds its read budget');
    return new Uint8Array(bytes);
  }

  /** Probe the exact key with HEAD; access and service failures never prove absence. */
  async probe(digest: string, signal?: AbortSignal): Promise<void> {
    const key = this.key(digest);
    let response: Response;
    try { response = await this.signer.fetch(`${this.bucketUrl}/${key}`,
      { method: 'HEAD', signal: signal ?? this.readSignal?.() }); }
    catch { throw new ObjectUnavailable('committed immutable object probe is unavailable'); }
    if (response.status === 404) {
      if (response.headers.get('x-amz-delete-marker')?.toLowerCase() === 'true') {
        throw new ObjectVersioningUnsupported('an S3 delete marker does not prove immutable object absence');
      }
      throw new ObjectNotFound('committed immutable object was not found (404)');
    }
    if (!response.ok) throw new ObjectUnavailable(`committed immutable object probe is unavailable (${response.status})`);
  }

  private async assertBucketUnversioned(signal: AbortSignal | undefined, responseBudget: number): Promise<number> {
    let response: Response;
    try {
      response = await this.signer.fetch(`${this.bucketUrl}?versioning`,
        { method: 'GET', signal: signal ?? this.readSignal?.() });
    } catch {
      throw new ObjectListingUnavailable('immutable object versioning capability is unavailable');
    }
    if (!response.ok) {
      throw new ObjectListingUnavailable(`immutable object versioning capability is unavailable (${response.status})`);
    }
    const bytes = await readS3ResponseWithinBudget(response, responseBudget);
    const root = parseS3Xml(bytes, 'VersioningConfiguration');
    const statusNodes = xmlChildren(root, 'Status');
    if (statusNodes.length > 1) throw new ObjectListingUnavailable('immutable object versioning response is malformed');
    const status = statusNodes.length ? xmlText(root, 'Status') : undefined;
    if (status === 'Enabled' || status === 'Suspended') {
      throw new ObjectVersioningUnsupported('immutable object namespace listing refuses versioned buckets');
    }
    if (status !== undefined || xmlChildren(root).length !== 0) {
      throw new ObjectListingUnavailable('immutable object versioning capability is not authoritative');
    }
    return bytes.byteLength;
  }

  /**
   * List one prefix in a single ListObjectsV2 response. A lookahead entry
   * detects overflow; truncation, malformed metadata, and versioned buckets
   * fail closed instead of returning a partial inventory.
   */
  async listPrefix(prefix: string, options: ImmutableObjectListOptions): Promise<readonly string[]> {
    checkedListingPrefix(prefix, this.prefix);
    const { maxEntries, signal } = options;
    const maxResponseBytes = options.maxResponseBytes ?? IMMUTABLE_OBJECT_LISTING_LIMITS.maxResponseBytes;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1
      || maxEntries > IMMUTABLE_OBJECT_LISTING_LIMITS.maxEntries) {
      throw new ObjectReadBudgetExceeded('immutable object listing entry budget is invalid');
    }
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
      || maxResponseBytes > IMMUTABLE_OBJECT_LISTING_LIMITS.maxResponseBytes) {
      throw new ObjectReadBudgetExceeded('immutable object listing byte budget is invalid');
    }
    if (signal?.aborted) throw new ObjectListingUnavailable('immutable object listing was aborted');

    const versioningBytes = await this.assertBucketUnversioned(signal, maxResponseBytes);
    const remainingBytes = maxResponseBytes - versioningBytes;
    if (remainingBytes < 1) {
      throw new ObjectReadBudgetExceeded('immutable object listing response exceeds its byte budget');
    }
    const requestedMaxKeys = maxEntries + 1;
    const url = new URL(this.bucketUrl);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    url.searchParams.set('max-keys', String(requestedMaxKeys));

    let response: Response;
    try { response = await this.signer.fetch(url.toString(), { method: 'GET', signal: signal ?? this.readSignal?.() }); }
    catch { throw new ObjectListingUnavailable('immutable object namespace listing is unavailable'); }
    if (!response.ok) {
      throw new ObjectListingUnavailable(`immutable object namespace listing is unavailable (${response.status})`);
    }
    const root = parseS3Xml(await readS3ResponseWithinBudget(response, remainingBytes), 'ListBucketResult');
    const allowedRootChildren = new Set(['Name', 'Prefix', 'ContinuationToken', 'StartAfter', 'MaxKeys',
      'Delimiter', 'IsTruncated', 'Contents', 'CommonPrefixes', 'EncodingType', 'KeyCount',
      'NextContinuationToken', 'FetchOwner', 'RequestCharged']);
    if (xmlChildren(root).some(child => !child.localName || !allowedRootChildren.has(child.localName))) {
      throw new ObjectListingUnavailable('immutable object listing response has unsupported fields');
    }
    if (xmlText(root, 'Name') !== this.bucket || xmlText(root, 'Prefix') !== prefix
      || xmlText(root, 'MaxKeys') !== String(requestedMaxKeys)) {
      throw new ObjectListingUnavailable('immutable object listing metadata does not match its request');
    }
    const truncated = xmlText(root, 'IsTruncated');
    if (truncated !== 'true' && truncated !== 'false') {
      throw new ObjectListingUnavailable('immutable object listing truncation state is invalid');
    }
    if (truncated === 'true' || xmlChildren(root, 'NextContinuationToken').length > 0
      || xmlChildren(root, 'ContinuationToken').length > 0 || xmlChildren(root, 'CommonPrefixes').length > 0) {
      throw new ObjectListingUnavailable('immutable object namespace listing is incomplete');
    }
    if (xmlChildren(root, 'EncodingType').length > 0 || xmlChildren(root, 'StartAfter').length > 0
      || xmlChildren(root, 'Delimiter').length > 0) {
      throw new ObjectListingUnavailable('immutable object listing uses unsupported request parameters');
    }

    const keyCount = xmlBoundedDecimal(root, 'KeyCount', requestedMaxKeys);
    const contents = xmlChildren(root, 'Contents');
    if (keyCount !== contents.length) {
      throw new ObjectListingUnavailable('immutable object listing count is not authoritative');
    }
    if (contents.length > maxEntries) {
      throw new ObjectReadBudgetExceeded('immutable object namespace listing exceeds its entry budget');
    }
    const keys = contents.map(content => xmlRawText(content, 'Key'));
    const seen = new Set<string>();
    for (const key of keys) {
      try { checkedListingPrefix(key, prefix); }
      catch { throw new ObjectListingUnavailable('immutable object listing returned a key outside its prefix'); }
      if (seen.has(key)) throw new ObjectListingUnavailable('immutable object listing contains a duplicate key');
      seen.add(key);
    }
    return keys;
  }

  /** Concurrent unbounded reads of one digest share the store fetch. A caller's abort does not cancel it. */
  private joinRead(digest: string, signal?: AbortSignal): Promise<Uint8Array> {
    const existing = this.inflight.get(digest);
    const shared = existing ?? this.startRead(digest);
    return whenNotAborted(signal, shared);
  }

  private startRead(digest: string): Promise<Uint8Array> {
    const shared = this.readStoreAndRemember(digest, undefined, this.readSignal?.());
    const tracked = shared.finally(() => {
      if (this.inflight.get(digest) === tracked) this.inflight.delete(digest);
    });
    this.inflight.set(digest, tracked);
    return tracked;
  }

  private async readStoreAndRemember(digest: string, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array> {
    const token = verifiedObjectCache.beginRead(digest);
    try {
      const bytes = await this.readStore(digest, maxBytes, signal);
      if (!verifiedObjectCache.rememberRead(digest, bytes, token)) {
        throw new ObjectUnavailable('immutable object read became stale during deletion');
      }
      return bytes;
    } finally {
      verifiedObjectCache.endRead(digest, token);
    }
  }

  private async readStore(digest: string, maxBytes?: number, signal?: AbortSignal): Promise<Uint8Array> {
    const key = this.key(digest);
    let response: Response;
    try { response = await this.signer.fetch(`${this.bucketUrl}/${key}`,
      { method: 'GET', signal: signal ?? this.readSignal?.(),
        ...(maxBytes === undefined ? {} : { headers: { range: `bytes=0-${maxBytes}` } }) }); }
    catch { throw new ObjectUnavailable('committed immutable object is unavailable'); }
    if (response.status === 404) throw new ObjectNotFound('committed immutable object was not found (404)');
    if (!response.ok) throw new ObjectUnavailable(`committed immutable object is unavailable (${response.status})`);
    let bytes: Uint8Array;
    try {
      if (maxBytes === undefined) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        const length = response.headers.get('content-length');
        if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
          await response.body?.cancel().catch(() => {});
          throw new ObjectReadBudgetExceeded('immutable object exceeds its read budget');
        }
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (reader) try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maxBytes) {
              await reader.cancel().catch(() => {});
              throw new ObjectReadBudgetExceeded('immutable object exceeds its read budget');
            }
            chunks.push(next.value);
          }
        } finally { reader.releaseLock(); }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      }
    }
    catch (error) {
      if (error instanceof ObjectReadBudgetExceeded) throw error;
      throw new ObjectUnavailable('committed immutable object could not be read');
    }
    if (sha256(bytes) !== digest) throw new ObjectIntegrityError('immutable object digest differs');
    return bytes;
  }

  /** Delete one exact key and verify absence without trusting cached bytes. */
  async deleteAndVerifyAbsent(digest: string, signal?: AbortSignal): Promise<void> {
    const key = this.key(digest);
    evictVerifiedImmutableObject(digest);
    try {
      let response: Response;
      try { response = await this.signer.fetch(`${this.bucketUrl}/${key}`,
        { method: 'DELETE', signal: signal ?? this.readSignal?.() }); }
      catch { throw new ObjectUnavailable('immutable object delete response is unavailable'); }
      if (!response.ok && response.status !== 404) {
        throw new ObjectUnavailable(`immutable object delete failed (${response.status})`);
      }
      try {
        await this.probe(digest, signal);
      } catch (error) {
        if (error instanceof ObjectNotFound) return;
        throw error;
      }
      throw new ObjectUnavailable('immutable object remains after delete');
    } finally {
      // Invalidate reads that began while DELETE and its read-back were in flight.
      evictVerifiedImmutableObject(digest);
    }
  }

  /** Idempotently remove one object after its owner proved the candidate unpublished. */
  async discard(digest: string, signal?: AbortSignal): Promise<void> {
    await this.deleteAndVerifyAbsent(digest, signal);
  }
}
