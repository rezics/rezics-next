import {
  createKernelClient,
  identityOperationLocation,
  reviewedPersonRequests,
  isReviewedPersonEndpoint,
  type ReviewedPersonRead,
  type ReviewedPersonSource,
  type ReviewedPersonMerge,
  type ReviewedPersonAdmission,
  type ReviewedPersonOperation,
  type KernelClient,
} from '@rezics/client';
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
import { Type, type Static } from 'typebox';
import { checkBatch, checkRequest, checkResult } from './accepted-checks.ts';
import { isImportSourceRecord, isImportSourceRecordMetadataResult } from './source-record-runtime.ts';
import {
  createImportFetch,
  importRetryState,
  MAX_IMPORT_BODY_BYTES,
  MAX_IMPORT_DEADLINE_MS,
  MAX_IMPORT_WAIT_MS,
  MAX_IMPORT_TOTAL_WAIT_MS,
  type ImportHttpOptions,
  importCorrelationId,
  importRequestFailure,
  importResponseDiagnostics,
  type ImportRequestDiagnostics,
  type ImportRetryState,
} from './import-fetch.ts';
import {
  type ImportSourceRecordMetadataCommand,
  type ImportSourceRecordMetadataResult,
  type ImportSourceStatisticValue,
  type ImportSourceStatisticClearValue,
  type ImportSourceStatisticFigure,
  type ImportPublicFigure,
  type ClassificationAssociation,
  type ClassificationClear,
  type ClassificationObservation,
  type ImportSourceClassificationPutResult,
  type ImportSourceClassificationClearResult,
  type SourceClassificationRead,
} from './import-contract.ts';

type SubjectAPI = ReturnType<KernelClient['subjects']>;
export type ReviewedSubjectRead = NonNullable<Awaited<ReturnType<SubjectAPI['get']>>['data']>;
export type ReviewedCandidatePage = NonNullable<Awaited<ReturnType<SubjectAPI['candidates']['get']>>['data']>;
type CandidateAPI = ReturnType<SubjectAPI['candidates']>;
export type ReviewedAcceptance = NonNullable<Awaited<ReturnType<CandidateAPI['$accept']['post']>>['data']>;
export type ReviewedAdoption = NonNullable<Awaited<ReturnType<SubjectAPI['$adopt']['post']>>['data']>;

export interface FenceTuple {
  source: string;
  externalId: string;
  fieldGroup: FieldGroup;
}
/**
 * Kernel's served-variant decision (`GET /v1/media/{id}/$authorizeDownload`). Only the admitted
 * image types, a bounded byte count and a SHA-256 digest are retained; the bytes are not read here.
 */
const MediaVariantDecisionSchema = Type.Object(
  {
    allowed: Type.Literal(true),
    key: Type.String({ minLength: 1, maxLength: 512 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    mediaType: Type.Union([Type.Literal('image/avif'), Type.Literal('image/webp')]),
    byteCount: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    publicCache: Type.Literal(false),
    cacheControl: Type.Union([Type.Literal('private, no-cache'), Type.Literal('private, no-store')]),
  },
  { additionalProperties: false },
);
export type MediaVariantDecision = Static<typeof MediaVariantDecisionSchema>;
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
  onDeniedResponse?: (denial: ImportDeniedResponse) => Promise<void>;
};

/** Opt-in private evidence sink; never receives request headers, bodies or credentials. */
export type ImportDeniedResponse = {
  method: string;
  path: string;
  response: Response;
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

function statisticAlias(body: Record<string, unknown>): void {
  if (Object.hasOwn(body, 'sourceAlias'))
    ensure(typeof body.sourceAlias === 'string' && /^[a-z][a-z0-9_-]{0,31}(?![\s\S])/.test(body.sourceAlias));
}

function observationToken(body: Record<string, unknown>): void {
  if (!Object.hasOwn(body, 'expectedObservation')) return;
  ensure(
    body.expectedObservation === null ||
      (typeof body.expectedObservation === 'string' && /^[0-9a-f]{64}$/.test(body.expectedObservation)),
  );
}

function sourceStatisticBody(input: unknown): ImportSourceStatisticValue {
  const value = snapshot(input, BODY_BYTES);
  ensure(typeof value === 'object' && value !== null && !Array.isArray(value));
  const body = value as Record<string, unknown>;
  statisticAlias(body);
  observationToken(body);
  ensure(
    Object.keys(body)
      .filter((key) => key !== 'sourceAlias' && key !== 'expectedObservation')
      .sort()
      .join(',') === 'asOf,attribution,count,licence,mean,scale,sourceRecordId',
  );
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

export type ImportTransportPhase = 'readiness' | 'merge403' | 'SubjectGET503';

/** Error diagnostics retain only the HTTP classifier, never remote bodies or credentials. */
export class ImportTransportError extends Error {
  readonly method: string | undefined;
  readonly origin: string | undefined;
  readonly path: string | undefined;
  readonly failurePhase: ImportRequestDiagnostics['phase'] | undefined;
  readonly networkCode: string | undefined;
  readonly correlationId: string | undefined;

  constructor(
    readonly status?: number,
    readonly type?: string,
    readonly code?: string,
    readonly retryable = false,
    readonly retry?: ImportRetryState,
    readonly phase?: ImportTransportPhase,
    diagnostics: Partial<ImportRequestDiagnostics> & { cause?: unknown } = {},
  ) {
    super(phase ? `Import transport request failed at ${phase}` : 'Import transport request failed', {
      cause: diagnostics.cause,
    });
    this.name = 'ImportTransportError';
    this.method = diagnostics.method;
    this.origin = diagnostics.origin;
    this.path = diagnostics.path;
    this.failurePhase = diagnostics.phase;
    this.networkCode = diagnostics.networkCode;
    this.correlationId = diagnostics.correlationId;
  }
}
function copiedDiagnostics(error: ImportTransportError): Partial<ImportRequestDiagnostics> & { cause?: unknown } {
  return {
    ...(error.method === undefined ? {} : { method: error.method }),
    ...(error.origin === undefined ? {} : { origin: error.origin }),
    ...(error.path === undefined ? {} : { path: error.path }),
    ...(error.failurePhase === undefined ? {} : { phase: error.failurePhase }),
    ...(error.networkCode === undefined ? {} : { networkCode: error.networkCode }),
    ...(error.correlationId === undefined ? {} : { correlationId: error.correlationId }),
    cause: error.cause,
  };
}

/** Public copy of the safe envelope; the original cause stays on the Error chain. */
export function importTransportDiagnostics(
  error: ImportTransportError,
): Partial<ImportRequestDiagnostics> & { cause?: unknown } {
  return copiedDiagnostics(error);
}

function safeDiagnosticField(value: unknown, pattern: RegExp, limit: number): string | undefined {
  return typeof value === 'string' && value.length <= limit && pattern.test(value) ? value : undefined;
}

/** Operator-visible transport envelope. Causes and response bodies remain private to the Error chain. */
export function formatImportTransportError(error: ImportTransportError): string {
  const values = copiedDiagnostics(error);
  const method = safeDiagnosticField(values.method, /^(GET|HEAD|POST|PUT|PATCH|DELETE)$/u, 8) ?? 'unknown';
  const origin = safeDiagnosticField(values.origin, /^https?:\/\/[A-Za-z0-9.:[\]_-]+(?::[0-9]{1,5})?$/u, 256);
  const path = safeDiagnosticField(values.path, /^\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{0,512}$/u, 512);
  const target = `${origin ?? 'unknown-origin'}${path ?? ''}`;
  const fallbackPhase = error.status === undefined ? 'transport' : 'http';
  const phase = safeDiagnosticField(values.phase, /^[a-z-]{1,24}$/u, 24) ?? fallbackPhase;
  const status =
    Number.isInteger(error.status) && error.status! >= 100 && error.status! <= 599 ? String(error.status) : 'none';
  const code = safeDiagnosticField(error.code, /^[a-z0-9_-]{1,80}$/u, 80) ?? 'none';
  const network =
    safeDiagnosticField(error.networkCode, /^(?:E[A-Z0-9_]{1,64}|ERR_[A-Z0-9_]{1,64}|UND_ERR_[A-Z0-9_]{1,64})$/u, 72) ??
    'none';
  const correlation = safeDiagnosticField(error.correlationId, /^[A-Za-z0-9._:-]{1,128}$/u, 128) ?? 'none';
  const classification = safeDiagnosticField(error.phase, /^[A-Za-z][A-Za-z0-9]{0,31}$/u, 32);
  return `Import transport failed phase=${phase} method=${method} target=${target} status=${status} problem=${code} network=${network} correlation=${correlation}${classification ? ` classification=${classification}` : ''}`;
}

export function importTransportCause(error: unknown): string {
  if (error instanceof ImportTransportError) return formatImportTransportError(error);
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]!.slice(0, 240);
}

type ClientResponse = { status: number; data: unknown; error: unknown; response?: Response };
function requestPath(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    return path.startsWith('/v1/') && path.length <= 200 ? path : undefined;
  } catch {
    return undefined;
  }
}
function attachRequest(error: ImportTransportError, method?: string, path?: string): ImportTransportError {
  return new ImportTransportError(error.status, error.type, error.code, error.retryable, error.retry, error.phase, {
    ...copiedDiagnostics(error),
    ...(error.method === undefined && method !== undefined ? { method } : {}),
    ...(error.path === undefined && path !== undefined ? { path } : {}),
  });
}

/** Reuse only an explicit, still-open Retry-After hint left by the bounded fetch layer. */
function subjectReadOverloadResumeDelay(
  error: unknown,
  now: number,
  maxWaitMs: number,
  maxTotalWaitMs: number,
): number | undefined {
  if (
    !(error instanceof ImportTransportError) ||
    error.status !== 503 ||
    error.code !== 'overloaded' ||
    !error.retryable
  )
    return;
  const retry = error.retry;
  if (!retry || retry.stopped !== undefined || retry.notBefore === undefined || retry.deadline <= now) return;
  const delay = Math.max(0, retry.notBefore - now);
  if (delay > maxWaitMs || delay > maxTotalWaitMs || now + delay >= retry.deadline) return;
  return delay;
}

function httpFailure(reply: ClientResponse, last?: { method: string; path: string }): ImportTransportError {
  // Only public problem identifiers are useful to callers. No remote diagnostic text is retained.
  const outer =
    typeof reply.error === 'object' && reply.error !== null && !types.isProxy(reply.error) ? reply.error : undefined;
  const nested = outer === undefined ? undefined : Object.getOwnPropertyDescriptor(outer, 'value')?.value;
  const value =
    typeof nested === 'object' && nested !== null && !types.isProxy(nested) ? nested : (outer as object | undefined);
  // Eden represents a rejected fetch as a 503 error envelope with the thrown value.
  // Recover our request-local error before interpreting public HTTP problem fields.
  if (!reply.response && value instanceof ImportTransportError) return attachRequest(value, last?.method, last?.path);
  const field = (name: string): unknown =>
    value && !types.isProxy(value) ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined;
  const type = field('type');
  const safeType =
    type === 'about:blank' ||
    (typeof type === 'string' && /^https:\/\/rezics\.com\/problems\/[a-z0-9_-]{1,80}$/u.test(type))
      ? type
      : undefined;
  const code = field('code');
  const safeCode = typeof code === 'string' && /^[a-z0-9_-]{1,80}$/u.test(code) ? code : undefined;
  const request = reply.response ? importResponseDiagnostics(reply.response) : undefined;
  let fallback: { origin?: string; path?: string } = {};
  if (reply.response?.url) {
    try {
      const url = new URL(reply.response.url);
      fallback = { origin: url.origin.slice(0, 256), path: url.pathname.slice(0, 512) };
    } catch {
      // A generated response can omit or malformedly report its URL; keep the safe envelope partial.
    }
  }
  const correlationValue = reply.response
    ? (request?.correlationId ?? importCorrelationId(reply.response) ?? field('request_id'))
    : undefined;
  const correlationId =
    typeof correlationValue === 'string' &&
    correlationValue.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(correlationValue)
      ? correlationValue
      : undefined;
  return new ImportTransportError(
    reply.response?.status ?? (reply.status > 0 ? reply.status : undefined),
    safeType,
    safeCode,
    field('retryable') === true,
    reply.response ? importRetryState(reply.response) : undefined,
    undefined,
    {
      ...(request ?? fallback),
      ...(last && !request ? { method: last.method, path: last.path } : {}),
      phase: reply.response ? 'http' : 'response',
      ...(correlationId === undefined ? {} : { correlationId }),
    },
  );
}
async function response(
  call: () => Promise<ClientResponse>,
  expected: number | readonly number[],
  signal?: AbortSignal,
  last?: () => { method: string; path: string } | undefined,
) {
  signal?.throwIfAborted();
  let reply: ClientResponse;
  try {
    reply = await call();
  } catch (error) {
    signal?.throwIfAborted();
    const request = last?.();
    if (error instanceof ImportTransportError) throw attachRequest(error, request?.method, request?.path);
    const diagnostics = importRequestFailure(error);
    if (diagnostics) {
      throw new ImportTransportError(undefined, undefined, undefined, false, undefined, undefined, {
        ...diagnostics,
        cause: error,
      });
    }
    throw new ImportTransportError(undefined, undefined, undefined, false, undefined, undefined, {
      phase: 'network',
      ...(request ?? {}),
      cause: error,
    });
  }
  signal?.throwIfAborted();
  if (
    !reply.response ||
    reply.error ||
    !(typeof expected === 'number' ? reply.status === expected : expected.includes(reply.status))
  )
    throw httpFailure(reply, last?.());
  if (expected === 204) {
    ensure(reply.data === undefined || reply.data === null || reply.data === '');
    return { status: reply.status, body: null, headers: reply.response.headers };
  }
  return { status: reply.status, body: snapshot(reply.data, RESPONSE_BYTES), headers: reply.response.headers };
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
  const maxAttempts = setting(options.maxAttempts, 3, 5, 1);
  const deadlineMs = setting(options.deadlineMs, MAX_IMPORT_DEADLINE_MS, MAX_IMPORT_DEADLINE_MS, 1);
  const maxWaitMs = setting(options.maxWaitMs, MAX_IMPORT_WAIT_MS, MAX_IMPORT_WAIT_MS);
  const maxTotalWaitMs = setting(options.maxTotalWaitMs, MAX_IMPORT_TOTAL_WAIT_MS, MAX_IMPORT_TOTAL_WAIT_MS);
  const now = options.now ?? Date.now;
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
  let lastRequest: { method: string; path: string } | undefined;
  const observedFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      const path = requestPath(request.url);
      lastRequest = {
        method: request.method,
        path: path ?? '/v1/subjects:batchWrite',
      };
      try {
        const reply = await importFetch(request);
        if (options.onDeniedResponse && (reply.status === 401 || reply.status === 403)) {
          await options.onDeniedResponse({
            method: request.method,
            path: path ?? new URL(request.url).pathname,
            response: reply.clone(),
          });
        }
        return reply;
      } catch (error) {
        if (error instanceof ImportTransportError) throw attachRequest(error, lastRequest.method, lastRequest.path);
        const diagnostics = importRequestFailure(error);
        throw new ImportTransportError(undefined, undefined, undefined, false, undefined, undefined, {
          phase: 'network',
          method: request.method,
          origin: new URL(request.url).origin,
          path: new URL(request.url).pathname,
          ...diagnostics,
          cause: error,
        });
      }
    },
    { preconnect: importFetch.preconnect },
  );
  const client =
    options.client ??
    createKernelClient(options.origin, {
      fetch: observedFetch,
      ...(options.session === undefined ? {} : { session: options.session }),
      ...(options.onSession === undefined ? {} : { onSession: options.onSession }),
    });
  const fetchOptions = (signal?: AbortSignal) => (signal === undefined ? {} : { fetch: { signal } });
  const exchange = (call: () => Promise<ClientResponse>, expected: number | readonly number[], signal?: AbortSignal) =>
    response(call, expected, signal, () => lastRequest);

  async function sendBatch(body: BatchWriteRequest, signal?: AbortSignal): Promise<BatchWriteResult> {
    const results: BatchWriteResult['results'] = [];
    let indices = body.commands.map((_, index) => index);
    const controller = new AbortController();
    const aborted = () => controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', aborted, { once: true });
    const deadline = now() + deadlineMs;
    let clearDeadline: (() => void) | undefined;
    let scheduledWait = 0;
    try {
      const expire = () => controller.abort(new DOMException('Import batch deadline exceeded', 'TimeoutError'));
      clearDeadline = options.schedule
        ? options.schedule(expire, deadlineMs)
        : (() => {
            const timer = setTimeout(expire, deadlineMs);
            return () => clearTimeout(timer);
          })();
      for (let attempt = 0; ; attempt++) {
        const request = { commands: indices.map((index) => body.commands[index]!) };
        const reply = await exchange(
          () => client.subjects.$batchWrite.post(request, fetchOptions(controller.signal)),
          200,
          controller.signal,
        );
        ensure(checkResult(reply.body).length === 0);
        const result = reply.body as BatchWriteResult;
        ensure(result.results.length === request.commands.length);
        result.results.forEach((item, index) => {
          ensure(item.key === request.commands[index]!.key);
          results[indices[index]!] = item;
        });
        indices = indices.filter((index) => {
          const item = results[index]!;
          return (
            (item.status === 503 || item.status === 429) &&
            'problem' in item &&
            (item.problem as { retryable?: unknown }).retryable === true
          );
        });
        const delay = 100 * 2 ** attempt;
        if (
          !indices.length ||
          attempt >= 2 ||
          delay > maxWaitMs ||
          delay > maxTotalWaitMs - scheduledWait ||
          now() + delay >= deadline
        )
          return { results };
        // Retain successful receipts; retry only explicit overloads with unchanged keys and bodies.
        scheduledWait += delay;
        await wait(delay, controller.signal, options.sleep);
        if (now() >= deadline) return { results };
      }
    } finally {
      clearDeadline?.();
      signal?.removeEventListener('abort', aborted);
    }
  }
  async function setSourceRecordMetadata(
    input: { command: ImportSourceRecordMetadataCommand; idempotencyKey: string },
    signal?: AbortSignal,
  ): Promise<ImportSourceRecordMetadataResult> {
    const body = snapshot(input.command, bodyLimit) as ImportSourceRecordMetadataCommand;
    ensure(
      body &&
        typeof body === 'object' &&
        Object.keys(body).sort().join(',') === 'expected_metadata_revision,external_id,metadata,source' &&
        typeof body.source === 'string' &&
        /^[a-z][a-z0-9_-]{0,31}$/.test(body.source) &&
        typeof body.external_id === 'string' &&
        body.external_id.length > 0 &&
        body.external_id.length <= 255 &&
        isImportSourceRecord(body.metadata) &&
        (body.expected_metadata_revision === null ||
          (Number.isSafeInteger(body.expected_metadata_revision) && body.expected_metadata_revision > 0)),
    );
    const reply = await exchange(
      () =>
        client['source-records'].$setMetadata.post(body, {
          headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
          ...fetchOptions(signal),
        }),
      [200, 201],
      signal,
    );
    ensure(isImportSourceRecordMetadataResult(reply.body));
    return reply.body;
  }
  function statisticFigure(
    body: unknown,
    source: 'vndb',
    request: ImportSourceStatisticValue,
  ): ImportSourceStatisticFigure {
    const value = snapshot(body, RESPONSE_BYTES);
    ensure(typeof value === 'object' && value !== null && !Array.isArray(value));
    const { expectedObservation: _echo, ...row } = value as Record<string, unknown>;
    const observation = row.observation;
    const { expectedObservation: _expected, ...fields } = request as ImportSourceStatisticValue & {
      expectedObservation?: string | null;
    };
    const expected = JSON.parse(JSON.stringify({ source, ...fields })) as Record<string, unknown>;
    delete expected.expectedObservation;
    if (expected.sourceAlias === source) delete expected.sourceAlias;
    if (observation !== undefined) {
      ensure(
        typeof observation === 'object' &&
          observation !== null &&
          !Array.isArray(observation) &&
          Object.keys(observation).sort().join(',') === 'digest,kind' &&
          (observation as { kind: unknown }).kind === 'unversioned' &&
          typeof (observation as { digest: unknown }).digest === 'string' &&
          /^[0-9a-f]{64}$/.test((observation as { digest: string }).digest),
      );
      expected.observation = observation;
    }
    ensure(isDeepStrictEqual(JSON.parse(JSON.stringify(row)), expected));
    return row as ImportSourceStatisticFigure;
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
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId) && input.source === 'vndb');
    const body = sourceStatisticBody(input.value);
    const reply = await exchange(
      () =>
        client
          .subjects({ id: input.subjectId })
          ['source-statistics']({ source: input.source })
          .put(body as never, {
            headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
            ...fetchOptions(signal),
          }),
      200,
      signal,
    );
    statisticFigure(reply.body, input.source, body);
  }
  async function clearSourceStatistic(
    input: {
      subjectId: string;
      source: 'vndb';
      value: ImportSourceStatisticClearValue;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId) && input.source === 'vndb');
    const value = snapshot(input.value, BODY_BYTES) as Record<string, unknown>;
    ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
    statisticAlias(value);
    observationToken(value);
    ensure(
      Object.keys(value)
        .filter((key) => key !== 'sourceAlias' && key !== 'expectedObservation')
        .sort()
        .join(',') === 'asOf,count,sourceRecordId',
    );
    ensure(
      typeof value.sourceRecordId === 'string' &&
        value.sourceRecordId.length > 0 &&
        Buffer.byteLength(value.sourceRecordId) <= 1024 &&
        value.count === 0 &&
        typeof value.asOf === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value.asOf) &&
        new Date(`${value.asOf}T00:00:00.000Z`).toISOString().slice(0, 10) === value.asOf,
    );
    // The generated client maps the registered custom method to the public :clear URL.
    await exchange(
      () =>
        client
          .subjects({ id: input.subjectId })
          ['source-statistics']({ source: input.source })
          .$clear.post(value as never, {
            headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
            ...fetchOptions(signal),
          }),
      204,
      signal,
    );
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
    const deadline = now() + deadlineMs;
    let scheduledWait = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await exchange(
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
            (value.fenced
              ? typeof value.securityRevision === 'string' && value.securityRevision.length > 0
              : value.securityRevision === null),
        );
        return value as { fenced: boolean; securityRevision: string | null };
      } catch (error) {
        const delay = 100 * 2 ** attempt;
        if (
          !(error instanceof ImportTransportError) ||
          (error.status !== 503 && error.status !== 429) ||
          attempt + 1 >= maxAttempts ||
          delay > maxWaitMs ||
          delay > maxTotalWaitMs - scheduledWait ||
          now() + delay >= deadline
        )
          throw error;
        scheduledWait += delay;
        await wait(delay, signal, options.sleep);
      }
    }
  }
  async function postMedia(body: MediaImportRequest, key: string, signal?: AbortSignal) {
    const header = idempotencyKey(key);
    const reply = await exchange(
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
    const reply = await exchange(() => client.media({ id }).$importStatus.get(fetchOptions(signal)), 200, signal);
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
  /** Served-variant read for one admitted derivative; a refusal or missing variant is an ImportTransportError. */
  async function authorizeMediaVariant(
    id: string,
    variant: string,
    signal?: AbortSignal,
  ): Promise<MediaVariantDecision> {
    mediaId(id);
    ensure(/^(?:avif|webp)-[1-9][0-9]{0,4}$/u.test(variant));
    const reply = await exchange(
      () => client.media({ id }).$authorizeDownload.get({ query: { variant }, ...fetchOptions(signal) }),
      200,
      signal,
    );
    ensure(Check(MediaVariantDecisionSchema, reply.body));
    return reply.body as MediaVariantDecision;
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
  // These use the same verified credentials, bounded fetch, session and native errors as imports.
  async function readReviewedSubject(id: string, signal?: AbortSignal): Promise<ReviewedSubjectRead> {
    mediaId(id);
    const deadline = now() + deadlineMs;
    const controller = new AbortController();
    const aborted = () => controller.abort(signal?.reason);
    signal?.throwIfAborted();
    signal?.addEventListener('abort', aborted, { once: true });
    let clearDeadline: (() => void) | undefined;
    const expire = () => controller.abort(new DOMException('Import Subject read deadline exceeded', 'TimeoutError'));
    clearDeadline = options.schedule
      ? options.schedule(expire, deadlineMs)
      : (() => {
          const timer = setTimeout(expire, deadlineMs);
          return () => clearTimeout(timer);
        })();
    const readSignal = controller.signal;
    const visited = new Set<string>();
    let current = id;
    // The fetch layer already used its bounded attempts; consume at most one remaining overload hint here.
    let resumedOverload = false;
    try {
      while (!visited.has(current)) {
        visited.add(current);
        let reply: ClientResponse;
        while (true) {
          try {
            reply = await client.subjects({ id: current }).get({
              fetch: { signal: readSignal, redirect: 'manual', cache: 'no-store' },
            });
            if (reply.status !== 308) {
              const result = await exchange(async () => reply, 200, readSignal);
              const read = result.body as ReviewedSubjectRead;
              ensure(read?.subject?.id === current);
              return read;
            }
            break;
          } catch (error) {
            const delay = resumedOverload
              ? undefined
              : subjectReadOverloadResumeDelay(error, now(), maxWaitMs, maxTotalWaitMs);
            if (delay !== undefined && now() + delay < deadline) {
              resumedOverload = true;
              await wait(delay, readSignal, options.sleep);
              continue;
            }
            if (error instanceof ImportTransportError && error.status === 503 && error.phase === undefined)
              throw new ImportTransportError(
                503,
                error.type,
                error.code,
                error.retryable,
                error.retry,
                error.type === 'https://rezics.com/problems/semantic_not_ready' ? 'readiness' : 'SubjectGET503',
                copiedDiagnostics(error),
              );
            throw error;
          }
        }
        const redirected = snapshot(reply.error ?? reply.data, RESPONSE_BYTES) as {
          redirect?: { from?: unknown; to?: unknown };
        };
        ensure(redirected.redirect?.from === current && typeof redirected.redirect.to === 'string');
        const target = redirected.redirect!.to as string;
        mediaId(target);
        current = target;
      }
      throw new TypeError('Cyclic reviewed subject redirect');
    } finally {
      clearDeadline?.();
      signal?.removeEventListener('abort', aborted);
    }
  }
  async function readReviewedPersonIdentity(
    id: string,
    source: ReviewedPersonSource,
    signal?: AbortSignal,
  ): Promise<ReviewedPersonRead> {
    const reply = await exchange(
      () => reviewedPersonRequests(client).read(id, source, fetchOptions(signal)),
      200,
      signal,
    );
    const read = reply.body as ReviewedPersonRead;
    if (read.reviewedIdentity != null) {
      const endpoint = read.reviewedIdentity;
      ensure(
        isReviewedPersonEndpoint(endpoint) &&
          endpoint.subject === id &&
          read.subject.id === id &&
          read.subject.type === 'schema:Person' &&
          endpoint.source === source.source &&
          endpoint.externalId === source.externalId,
      );
    }
    return read;
  }
  async function mergeReviewedPersons(
    body: ReviewedPersonMerge,
    key: string,
    signal?: AbortSignal,
  ): Promise<ReviewedPersonAdmission & { location: string }> {
    const safe = snapshot(body, BODY_BYTES) as ReviewedPersonMerge;
    try {
      const reply = await exchange(
        () =>
          reviewedPersonRequests(client).merge(safe, {
            headers: { 'idempotency-key': idempotencyKey(key) },
            ...fetchOptions(signal),
          }),
        202,
        signal,
      );
      const result = reply.body as ReviewedPersonAdmission;
      ensure(typeof result?.operation?.id === 'string' && uuid.test(result.operation.id));
      const location = identityOperationLocation(reply.headers, result.operation.id);
      return { ...result, location };
    } catch (error) {
      if (error instanceof ImportTransportError && error.status === 403)
        throw new ImportTransportError(
          403,
          error.type,
          error.code,
          false,
          error.retry,
          'merge403',
          copiedDiagnostics(error),
        );
      throw error;
    }
  }
  /** Admission is not completion: callers observe the supplied Location until survivor and redirect are final. */
  async function readReviewedPersonOperation(location: string, signal?: AbortSignal): Promise<ReviewedPersonOperation> {
    const reply = await exchange(
      () => reviewedPersonRequests(client).operationAt(location, fetchOptions(signal)),
      200,
      signal,
    );
    const observed = (reply.body as { operation?: ReviewedPersonOperation } | null)?.operation;
    ensure(typeof observed?.id === 'string' && uuid.test(observed.id) && typeof observed.done === 'boolean');
    if (observed.done)
      ensure(
        typeof observed.result?.survivor === 'string' &&
          typeof observed.result.redirected === 'string' &&
          Number.isSafeInteger(observed.result.revision) &&
          observed.result.revision > 0,
      );
    return observed;
  }
  async function reviewedCandidates(
    id: string,
    query: {
      property: string;
      target?: string;
      sameAs?: string;
      context: string;
      limit: number;
      cursor?: string;
    },
    signal?: AbortSignal,
  ): Promise<ReviewedCandidatePage> {
    mediaId(id);
    const safeQuery = {
      property: query.property,
      context: query.context,
      limit: query.limit,
      ...(query.target !== undefined ? { target: query.target } : {}),
      ...(query.sameAs !== undefined ? { sameAs: query.sameAs } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    };
    const safe = snapshot(safeQuery, BODY_BYTES) as typeof safeQuery;
    const reply = await exchange(
      () => client.subjects({ id }).candidates.get({ query: safe, ...fetchOptions(signal) }),
      200,
      signal,
    );
    return reply.body as ReviewedCandidatePage;
  }
  async function acceptReviewedCandidate(
    id: string,
    candidate: string,
    body: Parameters<CandidateAPI['$accept']['post']>[0],
    key: string,
    signal?: AbortSignal,
  ): Promise<ReviewedAcceptance> {
    mediaId(id);
    mediaId(candidate);
    const safe = snapshot(body, BODY_BYTES) as typeof body;
    const reply = await exchange(
      () =>
        client
          .subjects({ id })
          .candidates({ candidate })
          .$accept.post(safe, {
            headers: { 'idempotency-key': idempotencyKey(key) },
            ...fetchOptions(signal),
          }),
      200,
      signal,
    );
    return reply.body as ReviewedAcceptance;
  }
  async function adoptReviewedCandidates(
    id: string,
    body: Parameters<SubjectAPI['$adopt']['post']>[0],
    key: string,
    signal?: AbortSignal,
  ): Promise<ReviewedAdoption> {
    mediaId(id);
    const safe = snapshot(body, BODY_BYTES) as typeof body;
    const reply = await exchange(
      () =>
        client.subjects({ id }).$adopt.post(safe, {
          headers: { 'idempotency-key': idempotencyKey(key) },
          ...fetchOptions(signal),
        }),
      200,
      signal,
    );
    return reply.body as ReviewedAdoption;
  }
  async function readSourceStatistics(
    input: { subjectId: string },
    signal?: AbortSignal,
  ): Promise<readonly ImportSourceStatisticFigure[]> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    const reply = await exchange(
      () => client.subjects({ id: input.subjectId })['source-statistics'].get(fetchOptions(signal)),
      200,
      signal,
    );
    const list = snapshot(reply.body, RESPONSE_BYTES);
    ensure(Array.isArray(list) && list.length <= 2);
    return list.map((row) => {
      ensure(typeof row === 'object' && row !== null && !Array.isArray(row));
      const value = row as Record<string, unknown>;
      ensure(value.source === 'vndb' || value.source === 'bangumi');
      statisticAlias(value);
      const observation = value.observation;
      if (observation !== undefined) {
        ensure(
          typeof observation === 'object' &&
            observation !== null &&
            !Array.isArray(observation) &&
            Object.keys(observation).sort().join(',') === 'digest,kind' &&
            (observation as { kind: unknown }).kind === 'unversioned' &&
            typeof (observation as { digest: unknown }).digest === 'string' &&
            /^[0-9a-f]{64}$/.test((observation as { digest: string }).digest),
        );
      }
      ensure(
        typeof value.sourceRecordId === 'string' && typeof value.asOf === 'string' && typeof value.count === 'number',
      );
      return value as ImportSourceStatisticFigure;
    });
  }
  function classifications(subjectId: string) {
    return client.subjects({ id: subjectId })['source-classifications'];
  }
  function associationBody(association: unknown): ClassificationAssociation {
    const value = snapshot(association, BODY_BYTES);
    ensure(typeof value === 'object' && value !== null && !Array.isArray(value));
    const body = value as Record<string, unknown>;
    ensure(
      Object.keys(body).sort().join(',') ===
        'candidateId,contextId,property,qualifiersDigest,release,revision,subjectId,targetId',
    );
    ensure(
      typeof body.subjectId === 'string' &&
        uuid.test(body.subjectId) &&
        typeof body.candidateId === 'string' &&
        uuid.test(body.candidateId) &&
        typeof body.contextId === 'string' &&
        uuid.test(body.contextId) &&
        typeof body.targetId === 'string' &&
        uuid.test(body.targetId) &&
        typeof body.property === 'string' &&
        body.property.length > 0 &&
        body.property.length <= 256 &&
        Number.isInteger(body.revision) &&
        (body.revision as number) >= 1 &&
        typeof body.release === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(body.release) &&
        typeof body.qualifiersDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(body.qualifiersDigest),
    );
    return body as ClassificationAssociation;
  }
  async function readSourceClassifications(
    input: { subjectId: string; associations: readonly ClassificationAssociation[] },
    signal?: AbortSignal,
  ): Promise<readonly SourceClassificationRead[]> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    ensure(Array.isArray(input.associations) && input.associations.length <= 32);
    const associations = input.associations.map(associationBody);
    const reply = await exchange(
      () => classifications(input.subjectId).$read.post({ associations }, fetchOptions(signal)),
      200,
      signal,
    );
    const value = snapshot(reply.body, RESPONSE_BYTES);
    ensure(typeof value === 'object' && value !== null && !Array.isArray(value) && 'items' in value);
    const items = (value as { items: unknown }).items;
    ensure(Array.isArray(items) && items.length === associations.length);
    return items as SourceClassificationRead[];
  }
  async function writeSourceClassification(
    input: {
      subjectId: string;
      association: ClassificationAssociation;
      value: ClassificationObservation;
      expectedObservation: string | null;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<ImportSourceClassificationPutResult> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    const association = associationBody(input.association);
    ensure(association.subjectId === input.subjectId);
    const value = snapshot(input.value, BODY_BYTES);
    ensure(
      input.expectedObservation === null ||
        (typeof input.expectedObservation === 'string' && /^[0-9a-f]{64}$/.test(input.expectedObservation)),
    );
    const body = await exchange(
      () =>
        classifications(input.subjectId).$put.post(
          {
            association,
            expectedObservation: input.expectedObservation,
            value: value as ClassificationObservation,
          },
          {
            headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
            ...fetchOptions(signal),
          },
        ),
      200,
      signal,
    );
    const reply = snapshot(body.body, RESPONSE_BYTES) as Record<string, unknown>;
    ensure(
      typeof reply === 'object' &&
        reply !== null &&
        typeof reply.observationDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(reply.observationDigest) &&
        reply.state === 'published' &&
        typeof reply.figure === 'object' &&
        reply.figure !== null,
    );
    return reply as ImportSourceClassificationPutResult;
  }
  async function clearSourceClassification(
    input: {
      subjectId: string;
      association: ClassificationAssociation;
      value: ClassificationClear;
      expectedObservation: string | null;
      idempotencyKey: string;
    },
    signal?: AbortSignal,
  ): Promise<ImportSourceClassificationClearResult> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    const association = associationBody(input.association);
    ensure(association.subjectId === input.subjectId);
    const value = snapshot(input.value, BODY_BYTES);
    ensure(
      input.expectedObservation === null ||
        (typeof input.expectedObservation === 'string' && /^[0-9a-f]{64}$/.test(input.expectedObservation)),
    );
    const body = await exchange(
      () =>
        classifications(input.subjectId).$clear.post(
          {
            association,
            expectedObservation: input.expectedObservation,
            value: value as ClassificationClear,
          },
          {
            headers: { 'idempotency-key': idempotencyKey(input.idempotencyKey) },
            ...fetchOptions(signal),
          },
        ),
      200,
      signal,
    );
    const reply = snapshot(body.body, RESPONSE_BYTES) as Record<string, unknown>;
    ensure(
      typeof reply === 'object' &&
        reply !== null &&
        typeof reply.observationDigest === 'string' &&
        /^[0-9a-f]{64}$/.test(reply.observationDigest) &&
        reply.state === 'cleared',
    );
    return reply as ImportSourceClassificationClearResult;
  }
  async function readPublicFigure(input: { subjectId: string }, signal?: AbortSignal): Promise<ImportPublicFigure> {
    ensure(typeof input.subjectId === 'string' && uuid.test(input.subjectId));
    const reply = await exchange(
      () => client.subjects({ id: input.subjectId }).figure.get(fetchOptions(signal)),
      200,
      signal,
    );
    const body = snapshot(reply.body, RESPONSE_BYTES);
    ensure(typeof body === 'object' && body !== null && !Array.isArray(body) && 'figure' in body);
    const figure = (body as { figure: unknown }).figure;
    ensure(typeof figure === 'object' && figure !== null && !Array.isArray(figure));
    const value = figure as Record<string, unknown>;
    ensure(
      typeof value.count === 'number' &&
        Number.isSafeInteger(value.count) &&
        value.count >= 0 &&
        (value.state === 'ready' || value.state === 'insufficient_data' || value.state === 'updating') &&
        (value.mean === null || typeof value.mean === 'number'),
    );
    return figure as ImportPublicFigure;
  }
  return {
    readReviewedSubject,
    readReviewedPersonIdentity,
    mergeReviewedPersons,
    readReviewedPersonOperation,
    reviewedCandidates,
    acceptReviewedCandidate,
    adoptReviewedCandidates,
    setSourceRecordMetadata,
    batch,
    batches,
    fence,
    writeSourceStatistic,
    clearSourceStatistic,
    readSourceStatistics,
    readPublicFigure,
    readSourceClassifications,
    writeSourceClassification,
    clearSourceClassification,
    refreshCover,
    media,
    importFromUrl,
    importStatus,
    requestMedia,
    mediaStatus,
    authorizeMediaVariant,
  };
}
