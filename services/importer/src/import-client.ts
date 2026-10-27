import { createKernelClient, type KernelClient } from '@rezics/client';
import {
  BATCH_LIMIT,
  FIELD_GROUPS,
  type BatchCommand,
  type BatchWriteRequest,
  type BatchWriteResult,
  type FieldGroup,
} from '@rezics/definitions/bulk';
import {
  MediaImportAcceptedSchema,
  checkMediaImportStatus,
  type MediaImportAccepted,
  type MediaImportRequest,
  type MediaImportStatus,
} from '@rezics/definitions/media-import';
import { isDeepStrictEqual, types } from 'node:util';
import { Check } from 'typebox/schema';
import { checkBatch, checkRequest, checkResult } from './accepted-checks.ts';
import {
  createImportFetch,
  importRetryState,
  MAX_IMPORT_BODY_BYTES,
  type ImportHttpOptions,
  type ImportRetryState,
} from './import-fetch.ts';
import type { ImportSourceStatisticValue } from './import-contract.ts';

export interface FenceTuple {
  source: string;
  externalId: string;
  fieldGroup: FieldGroup;
}
export type MediaOutcome =
  | { outcome: 'available'; id: string; status: MediaImportStatus }
  | { outcome: 'pending'; status: MediaImportStatus }
  | { outcome: 'rejected'; code: string; status: MediaImportStatus }
  | { outcome: 'fenced' };
export type ImportTransportOptions = Omit<ImportHttpOptions, 'token'> & {
  tokenProvider: (fresh?: boolean) => Promise<string>;
  client?: KernelClient;
  importFetch?: typeof fetch;
  session?: string;
  onSession?: (token: string) => void;
  pollAttempts?: number;
  pollDelayMs?: number;
};

const BODY_BYTES = 65536;
const RESPONSE_BYTES = 1048576;
const WRAPPER_BYTES = Buffer.byteLength('{"commands":[]}');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new TypeError('Invalid import transport data');
}
function setting(value: number | undefined, fallback: number, ceiling: number, minimum = 0): number {
  const result = value === undefined ? fallback : value;
  ensure(Number.isSafeInteger(result) && result >= minimum && result <= ceiling);
  return result;
}

/** Copy data descriptors before validators or JSON serialization can execute caller code. */
function snapshot(input: unknown, limit: number): unknown {
  let budget = limit;
  let nodes = 0;
  const ancestors = new Set<object>();
  const charge = (text: string) => {
    ensure(text.length <= budget);
    budget -= Buffer.byteLength(text);
    ensure(budget >= 0);
  };
  function visit(value: unknown, depth: number): unknown {
    ensure(depth <= 32 && ++nodes <= limit);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      charge(value);
      return value;
    }
    if (typeof value === 'number') {
      ensure(Number.isFinite(value));
      return value;
    }
    ensure(typeof value === 'object' && !types.isProxy(value) && !ancestors.has(value));
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    ensure(array ? prototype === Array.prototype : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(value);
    ensure(keys.length <= limit);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    ancestors.add(value);
    let items = 0;
    for (const key of keys) {
      ensure(typeof key === 'string' && key !== 'toJSON');
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      ensure('value' in descriptor);
      if (array && key === 'length') continue;
      ensure(descriptor.enumerable);
      if (array) ensure(key === String(items++));
      charge(key);
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true });
    }
    if (array) ensure(items === Object.getOwnPropertyDescriptor(value, 'length')!.value);
    ancestors.delete(value);
    return result;
  }
  const result = visit(input, 0);
  ensure(Buffer.byteLength(JSON.stringify(result)) <= limit);
  return result;
}

function requestBody(input: unknown, limit: number): BatchWriteRequest {
  const body = snapshot(input, limit);
  ensure(checkBatch(body).length === 0);
  return body as BatchWriteRequest;
}
function mediaBody(input: unknown, limit: number): MediaImportRequest {
  const body = snapshot(input, limit);
  ensure(checkRequest(body).length === 0);
  return body as MediaImportRequest;
}
function mediaId(id: string): void {
  ensure(typeof id === 'string' && id.length === 36 && uuid.test(id));
}
function idempotencyKey(key: string): string {
  ensure(typeof key === 'string' && key.length >= 1 && key.length <= 255 && !/[^\x20-\x7e]/.test(key));
  return JSON.stringify(key);
}

function sourceStatisticBody(input: unknown): ImportSourceStatisticValue {
  const value = snapshot(input, BODY_BYTES);
  ensure(typeof value === 'object' && value !== null && !Array.isArray(value));
  const body = value as Record<string, unknown>;
  ensure(Object.keys(body).sort().join(',') === 'asOf,attribution,count,licence,mean,scale,sourceRecordId');
  const scale = body.scale;
  ensure(typeof scale === 'object' && scale !== null && !Array.isArray(scale));
  const sourceScale = scale as Record<string, unknown>;
  ensure(Object.keys(sourceScale).sort().join(',') === 'max,min');
  ensure(sourceScale.min === 1 && sourceScale.max === 10);
  ensure(
    typeof body.sourceRecordId === 'string' &&
      body.sourceRecordId.length > 0 &&
      Buffer.byteLength(body.sourceRecordId, 'utf8') <= 1024 &&
      typeof body.mean === 'number' &&
      Number.isFinite(body.mean) &&
      body.mean >= 1 &&
      body.mean <= 10 &&
      typeof body.count === 'number' &&
      Number.isSafeInteger(body.count) &&
      body.count > 0 &&
      body.count <= 2_147_483_647 &&
      typeof body.asOf === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(body.asOf) &&
      new Date(`${body.asOf}T00:00:00.000Z`).toISOString().slice(0, 10) === body.asOf &&
      typeof body.licence === 'string' &&
      body.licence.length > 0 &&
      Buffer.byteLength(body.licence, 'utf8') <= 1024 &&
      typeof body.attribution === 'string' &&
      body.attribution.length > 0 &&
      Buffer.byteLength(body.attribution, 'utf8') <= 2000,
  );
  return body as ImportSourceStatisticValue;
}

/** Error diagnostics retain only the HTTP classifier, never remote bodies or credentials. */
export class ImportTransportError extends Error {
  constructor(
    readonly status?: number,
    readonly type?: string,
    readonly code?: string,
    readonly retryable = false,
    readonly retry?: ImportRetryState,
  ) {
    super('Import transport request failed');
    this.name = 'ImportTransportError';
  }
}
type ClientResponse = { status: number; data: unknown; error: unknown; response?: Response };
function httpFailure(reply: ClientResponse): ImportTransportError {
  // Only public problem identifiers are useful to callers. No remote diagnostic text is retained.
  const value: unknown =
    typeof reply.error === 'object' && reply.error !== null && !types.isProxy(reply.error)
      ? Object.getOwnPropertyDescriptor(reply.error, 'value')?.value
      : undefined;
  const type =
    typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
      ? value.type
      : undefined;
  const safeType =
    type === 'about:blank' ||
    (type !== undefined && /^https:\/\/rezics\.com\/problems\/[a-z0-9_-]{1,80}(?![\s\S])/.test(type))
      ? type
      : undefined;
  const field = (name: string): unknown =>
    typeof value === 'object' && value !== null && !types.isProxy(value)
      ? Object.getOwnPropertyDescriptor(value, name)?.value
      : undefined;
  const code = field('code');
  const safeCode = typeof code === 'string' && /^[a-z0-9_-]{1,80}$/.test(code) ? code : undefined;
  return new ImportTransportError(
    reply.response?.status,
    safeType,
    safeCode,
    field('retryable') === true,
    reply.response ? importRetryState(reply.response) : undefined,
  );
}
async function response(call: () => Promise<ClientResponse>, expected: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let reply: ClientResponse;
  try {
    reply = await call();
  } catch {
    signal?.throwIfAborted();
    throw new ImportTransportError();
  }
  signal?.throwIfAborted();
  if (!reply.response || reply.error || reply.status !== expected) throw httpFailure(reply);
  return { status: reply.status, body: snapshot(reply.data, RESPONSE_BYTES) };
}

function wait(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', aborted, { once: true });
    Promise.resolve()
      .then(() => {
        signal?.throwIfAborted();
        return sleep ? sleep(ms) : new Promise<void>((done) => (timer = setTimeout(done, ms)));
      })
      .then(
        () => {
          cleanup();
          if (signal?.aborted) reject(signal.reason);
          else resolve();
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
  });
}

/** Stateless public import operations. The generated client alone owns session propagation. */
export function createImportTransport(options: ImportTransportOptions) {
  const pollAttempts = setting(options.pollAttempts, 5, 5, 1);
  const pollDelayMs = setting(options.pollDelayMs, 1000, 1000);
  ensure((pollAttempts - 1) * pollDelayMs <= 4000);
  setting(options.maxAttempts, 3, 5, 1);
  const bodyLimit = Math.min(BODY_BYTES, setting(options.maxBodyBytes, BODY_BYTES, MAX_IMPORT_BODY_BYTES));
  // Validate even when a preconstructed client is supplied; no credential hook runs here.
  const origin = new URL(options.origin);
  ensure(
    ['https:', 'http:'].includes(origin.protocol) &&
      !origin.username &&
      !origin.password &&
      origin.pathname === '/' &&
      !origin.search &&
      !origin.hash,
  );
  const importFetch = options.importFetch ?? createImportFetch({ ...options, token: options.tokenProvider });
  const client =
    options.client ??
    createKernelClient(options.origin, {
      fetch: importFetch,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.onSession === undefined ? {} : { onSession: options.onSession }),
    });
  const fetchOptions = (signal?: AbortSignal) => (signal === undefined ? {} : { fetch: { signal } });

  async function sendBatch(body: BatchWriteRequest, signal?: AbortSignal): Promise<BatchWriteResult> {
    const reply = await response(() => client.subjects.$batchWrite.post(body, fetchOptions(signal)), 200, signal);
    ensure(checkResult(reply.body).length === 0);
    const result = reply.body as BatchWriteResult;
    ensure(result.results.length === body.commands.length);
    result.results.forEach((item, index) => ensure(item.key === body.commands[index]!.key));
    return result;
  }
  async function writeSourceStatistic(
    input: {
      subjectId: string;
      source: 'vndb';
      value: ImportSourceStatisticValue;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    const body = sourceStatisticBody(input.value);
    const statisticsClient = client as unknown as {
      subjects(params: { subjectId: string }): {
        'source-statistics'(params: { source: 'vndb' }): {
          put(
            body: ImportSourceStatisticValue,
            options: { headers: { 'idempotency-key': string }; fetch?: RequestInit },
          ): Promise<ClientResponse>;
        };
      };
    };
    const reply = await response(
      () =>
        statisticsClient
          .subjects({ subjectId: input.subjectId })
          ['source-statistics']({ source: input.source })
          .put(body, {
            headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
            ...fetchOptions(signal),
          }),
      200,
      signal,
    );
    const expected = JSON.parse(JSON.stringify({ source: input.source, ...body }));
    ensure(isDeepStrictEqual(JSON.parse(JSON.stringify(reply.body)), expected));
  }
  async function batch(input: BatchWriteRequest, signal?: AbortSignal): Promise<BatchWriteResult> {
    return sendBatch(requestBody(input, bodyLimit), signal);
  }
  async function batches(input: BatchWriteRequest['commands'], signal?: AbortSignal): Promise<BatchWriteResult[]> {
    signal?.throwIfAborted();
    ensure(Array.isArray(input) && !types.isProxy(input) && Object.getPrototypeOf(input) === Array.prototype);
    const keys = Reflect.ownKeys(input);
    ensure(keys.length === input.length + 1);
    const chunks: BatchWriteRequest[] = [];
    const seen = new Set<string>();
    let commands: BatchCommand[] = [];
    let bytes = WRAPPER_BYTES;
    // Admit every individual command before the first send. Each serialization is bounded;
    // byte accounting adds a comma and a wrapper without serializing growing prefixes.
    for (let index = 0; index < input.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
      ensure(descriptor && 'value' in descriptor && descriptor.enumerable);
      const command = requestBody({ commands: [descriptor.value] }, bodyLimit).commands[0]!;
      ensure(!seen.has(command.key));
      seen.add(command.key);
      const size = Buffer.byteLength(JSON.stringify(command));
      if (commands.length === BATCH_LIMIT || bytes + size + (commands.length ? 1 : 0) > bodyLimit) {
        chunks.push({ commands });
        commands = [];
        bytes = WRAPPER_BYTES;
      }
      bytes += size + (commands.length ? 1 : 0);
      commands.push(command);
    }
    if (commands.length) chunks.push({ commands });
    const results: BatchWriteResult[] = [];
    for (const chunk of chunks) results.push(await sendBatch(chunk, signal));
    return results;
  }
  async function fence(
    input: FenceTuple,
    signal?: AbortSignal,
  ): Promise<{ fenced: boolean; securityRevision: string | null }> {
    const tuple = snapshot(input, BODY_BYTES) as FenceTuple;
    ensure(
      tuple !== null &&
        typeof tuple === 'object' &&
        Object.keys(tuple).length === 3 &&
        typeof tuple.source === 'string' &&
        /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(tuple.source) &&
        typeof tuple.externalId === 'string' &&
        tuple.externalId.length >= 1 &&
        tuple.externalId.length <= 255 &&
        FIELD_GROUPS.includes(tuple.fieldGroup),
    );
    const reply = await response(
      () => client.sourceFences.$check.get({ query: tuple, ...fetchOptions(signal) }),
      200,
      signal,
    );
    const value = reply.body as { fenced?: unknown; securityRevision?: unknown } | null;
    ensure(
      value !== null &&
        typeof value === 'object' &&
        Object.keys(value).length === 2 &&
        typeof value.fenced === 'boolean' &&
        (value.securityRevision === null ||
          (typeof value.securityRevision === 'string' && value.securityRevision.length > 0)),
    );
    return value as { fenced: boolean; securityRevision: string | null };
  }
  async function postMedia(body: MediaImportRequest, key: string, signal?: AbortSignal) {
    const header = idempotencyKey(key);
    const reply = await response(
      () => client.media.$importFromUrl.post(body, { headers: { 'idempotency-key': header }, ...fetchOptions(signal) }),
      202,
      signal,
    );
    ensure(Check(MediaImportAcceptedSchema, reply.body));
    const accepted = reply.body as MediaImportAccepted;
    ensure(accepted.media.containerId === body.containerId && accepted.media.purpose === 'cover');
    return { status: reply.status, body: accepted };
  }
  async function requestMedia(bytes: string, key: string, signal?: AbortSignal) {
    ensure(typeof bytes === 'string' && bytes.length <= bodyLimit && Buffer.byteLength(bytes) <= bodyLimit);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new TypeError('Invalid import transport data');
    }
    const body = mediaBody(parsed, bodyLimit);
    // Eden serializes this data-only object with JSON.stringify. Require byte-for-byte
    // equality with the durable journal before dispatch under its existing key.
    ensure(JSON.stringify(body) === bytes);
    return postMedia(body, key, signal);
  }
  async function importFromUrl(
    input: MediaImportRequest,
    key: string,
    signal?: AbortSignal,
  ): Promise<MediaImportAccepted> {
    return (await postMedia(mediaBody(input, bodyLimit), key, signal)).body;
  }
  async function mediaStatus(id: string, signal?: AbortSignal) {
    mediaId(id);
    const reply = await response(() => client.media({ id }).$importStatus.get(fetchOptions(signal)), 200, signal);
    ensure(checkMediaImportStatus(reply.body).length === 0);
    const status = reply.body as MediaImportStatus;
    ensure(status.media.id === id);
    if (status.media.state === 'rejected') ensure(status.media.rejection !== undefined);
    else ensure(status.media.rejection === undefined);
    return { status: reply.status, body: status };
  }
  async function importStatus(id: string, signal?: AbortSignal): Promise<MediaImportStatus> {
    return (await mediaStatus(id, signal)).body;
  }
  async function media(input: MediaImportRequest, key: string, signal?: AbortSignal): Promise<MediaOutcome> {
    const body = mediaBody(input, bodyLimit);
    const accepted = await postMedia(body, key, signal);
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      if (attempt > 0) await wait(pollDelayMs, signal, options.sleep);
      const status = await importStatus(accepted.body.media.id, signal);
      ensure(
        status.media.containerId === body.containerId &&
          status.media.purpose === accepted.body.media.purpose &&
          isDeepStrictEqual(status.media.credit, body.credit) &&
          isDeepStrictEqual(status.media.provenance, body.provenance),
      );
      if (status.media.state === 'available') return { outcome: 'available', id: status.media.id, status };
      if (status.media.state === 'rejected') return { outcome: 'rejected', code: status.media.rejection!.code, status };
      if (attempt === pollAttempts - 1) return { outcome: 'pending', status };
    }
    throw new TypeError('Invalid import polling configuration');
  }
  async function refreshCover(
    tuple: FenceTuple,
    body: MediaImportRequest,
    key: string,
    signal?: AbortSignal,
  ): Promise<MediaOutcome> {
    if ((await fence(tuple, signal)).fenced) return { outcome: 'fenced' };
    return media(body, key, signal);
  }
  return {
    batch,
    batches,
    fence,
    writeSourceStatistic,
    refreshCover,
    media,
    importFromUrl,
    importStatus,
    requestMedia,
    mediaStatus,
  };
}
