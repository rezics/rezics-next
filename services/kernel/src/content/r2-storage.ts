import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { routeOf } from '../route/route.ts';
import type { MediaStorage } from './media-storage.ts';

export interface R2StorageOptions {
  /** Account S3 origin, for example https://account.r2.cloudflarestorage.com. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Trusted host transport; must honor Request.signal. Redirects are disabled. */
  fetch: (request: Request) => Promise<Response>;
  maxObjectBytes: number;
  requestTimeoutMs?: number;
}

/** Jobs must retain their durable pending fence when any provider operation fails. */
export class MediaStorageError extends Error {
  readonly retryable = true;
  constructor() {
    // Never include provider bodies, URLs, signed requests or underlying error causes.
    super('Media storage operation failed; pending work can be retried');
    this.name = 'MediaStorageError';
  }
}

const LIST_BYTES = 2 * 1024 * 1024;
const ERROR_BYTES = 64 * 1024;
const MAX_KEYS = 100_000;
const MAX_PAGES = 10_000;
const encoder = new TextEncoder();
const parser = new XMLParser({
  parseTagValue: false,
  trimValues: false,
  ignoreAttributes: true,
  isArray: (name) => name === 'Contents',
});

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MediaStorageError();
  return value as Record<string, unknown>;
}

function parseXml(bytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  // Reject declarations with entity expansion before handing XML to the maintained parser.
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true) throw new MediaStorageError();
  return record(parser.parse(text));
}

function mediaPrefix(value: string): string {
  const parts = value.split('/');
  if (parts.length !== 3 || parts[0] !== 'm' || parts[2] !== '' || routeOf(parts[1]!) === null)
    throw new RangeError('Expected exactly one routable media object prefix');
  return value;
}

function mediaKey(key: string): string {
  const parts = key.split('/');
  mediaPrefix(`${parts[0]}/${parts[1]}/`);
  if (
    parts.length < 3 ||
    parts.slice(2).some((part) => !part || part === '.' || part === '..' || /%2e/i.test(part)) ||
    /[\\\x00-\x1f\x7f]/.test(key) ||
    encoder.encode(key).byteLength > 1024
  )
    throw new RangeError('Invalid media object key');
  // Reject unpaired surrogates rather than allowing replacement during URL encoding.
  encodeURIComponent(key);
  return key;
}

function positiveInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('Storage limits must be positive integers');
}

/** Thin host adapter: aws4fetch owns SigV4; no Worker binding or upload staging flow. */
export class R2Storage implements MediaStorage {
  #aws: AwsClient;
  #base: string;
  #fetch: R2StorageOptions['fetch'];
  #limit: number;
  #timeout: number;

  constructor(options: R2StorageOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new RangeError('Invalid R2 endpoint');
    }
    if (
      (endpoint.protocol !== 'https:' &&
        !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== '/' ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !options.accessKeyId ||
      !options.secretAccessKey ||
      typeof options.fetch !== 'function'
    )
      throw new RangeError('Invalid R2 configuration');
    positiveInteger(options.maxObjectBytes);
    positiveInteger(options.requestTimeoutMs ?? 30_000);
    this.#base = `${endpoint.origin}/${options.bucket}`;
    this.#limit = options.maxObjectBytes;
    this.#timeout = options.requestTimeoutMs ?? 30_000;
    this.#fetch = options.fetch;
    // sign() supports explicit transport injection; AwsClient.fetch() uses global fetch.
    // No adapter retries: the durable job retries failed operations, including partial purges.
    this.#aws = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: 's3',
      region: 'auto',
      retries: 0,
    });
  }

  #url(key: string): URL {
    return new URL(`${this.#base}/${key.split('/').map(encodeURIComponent).join('/')}`);
  }

  async #request<T>(
    url: URL,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Response | undefined;
    try {
      const request = await this.#aws.sign(url, { ...init, redirect: 'manual', signal: controller.signal });
      // Local signing is not remote work: the deadline covers the transport and the body, so a slow
      // signer can never time a request out before it exists, and every timed-out response is owned here.
      timer = setTimeout(() => controller.abort(), this.#timeout);
      response = await this.#fetch(request);
      controller.signal.throwIfAborted();
      return await consume(response, controller.signal);
    } catch {
      // Transport exceptions can contain credentials; expose only this stable, safe error.
      throw new MediaStorageError();
    } finally {
      clearTimeout(timer);
      controller.abort();
      await response?.body?.cancel().catch(() => {});
    }
  }

  async #read(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
    const length = response.headers.get('content-length');
    if (
      (length !== null && (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > limit)) ||
      response.headers.has('content-range') ||
      (response.headers.has('content-encoding') && response.headers.get('content-encoding') !== 'identity')
    )
      throw new MediaStorageError();
    const reader = response.body?.getReader();
    if (!reader) {
      if (length !== null && length !== '0') throw new MediaStorageError();
      return new Uint8Array();
    }
    const abort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new MediaStorageError();
        if (value.byteLength === 0) continue;
        size += value.byteLength;
        if (size > limit) throw new MediaStorageError();
        chunks.push(value);
      }
      if (length !== null && size !== Number(length)) throw new MediaStorageError();
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } finally {
      signal.removeEventListener('abort', abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    mediaKey(key);
    return this.#request(this.#url(key), { method: 'GET' }, async (response, signal) => {
      if (response.status === 404) {
        const error = record(parseXml(await this.#read(response, ERROR_BYTES, signal)).Error);
        if (error.Code === 'NoSuchKey') return null;
        throw new MediaStorageError();
      }
      if (response.status !== 200) throw new MediaStorageError();
      return this.#read(response, this.#limit, signal);
    });
  }

  async put(key: string, bytes: Uint8Array, options: { mediaType: string }): Promise<void> {
    mediaKey(key);
    if (bytes.byteLength > this.#limit || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(options.mediaType))
      throw new RangeError('Invalid media bytes or content type');
    const body = new Uint8Array(bytes);
    const headers = {
      'content-type': options.mediaType,
      'content-length': String(body.byteLength),
      // SigV4 payload hash, not an R2-unsupported x-amz-checksum-* header or database evidence.
      'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
    };
    await this.#request(this.#url(key), { method: 'PUT', headers, body }, async (response) => {
      if (response.status !== 200) throw new MediaStorageError();
    });
  }

  async deletePrefix(prefix: string): Promise<void> {
    mediaPrefix(prefix);
    const keys = new Set<string>();
    const tokens = new Set<string>();
    let token: string | undefined;
    // Validate the complete listing before any mutation, including all later pages.
    for (let pages = 0; ; pages++) {
      if (pages >= MAX_PAGES) throw new MediaStorageError();
      const url = new URL(this.#base);
      url.searchParams.set('list-type', '2');
      url.searchParams.set('prefix', prefix);
      url.searchParams.set('encoding-type', 'url');
      url.searchParams.set('max-keys', '1000');
      if (token !== undefined) url.searchParams.set('continuation-token', token);
      token = await this.#request(url, { method: 'GET' }, async (response, signal) => {
        if (response.status !== 200) throw new MediaStorageError();
        const list = record(parseXml(await this.#read(response, LIST_BYTES, signal)).ListBucketResult);
        if (
          list.EncodingType !== 'url' ||
          typeof list.Prefix !== 'string' ||
          decodeURIComponent(list.Prefix) !== prefix ||
          !['true', 'false'].includes(list.IsTruncated as string) ||
          list.CommonPrefixes !== undefined
        )
          throw new MediaStorageError();
        const contents = list.Contents === undefined ? [] : list.Contents;
        if (
          !Array.isArray(contents) ||
          contents.length > 1000 ||
          typeof list.KeyCount !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(list.KeyCount) ||
          Number(list.KeyCount) !== contents.length
        )
          throw new MediaStorageError();
        for (const content of contents) {
          const encoded = record(content).Key;
          if (typeof encoded !== 'string') throw new MediaStorageError();
          const key = mediaKey(decodeURIComponent(encoded));
          if (!key.startsWith(prefix)) throw new MediaStorageError();
          keys.add(key);
          if (keys.size > MAX_KEYS) throw new MediaStorageError();
        }
        if (list.IsTruncated === 'false') {
          if (list.NextContinuationToken !== undefined) throw new MediaStorageError();
          return undefined;
        }
        const next = list.NextContinuationToken;
        if (typeof next !== 'string' || !next || next.length > 4096 || tokens.has(next)) throw new MediaStorageError();
        tokens.add(next);
        return next;
      });
      if (token === undefined) break;
    }
    // Concurrency is fixed at one; no deletion continues after success or failure returns.
    for (const key of keys) {
      await this.#request(this.#url(key), { method: 'DELETE' }, async (response) => {
        if (response.status !== 204 && response.status !== 200) throw new MediaStorageError();
      });
    }
  }
}
