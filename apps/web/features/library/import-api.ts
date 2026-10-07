import { browserMainApi } from '../api/browser.ts';
import { abortable, pauseForImport } from './import/lifetime.ts';
import { type MainClient, problemCode } from '../discover/types.ts';

// Main parses, matches and applies library files (`services/main/src/routes/library-imports.ts`). The
// browser sends the file text, pages through the rows Main reports, forwards the reader's choices and
// starts apply once and reads its durable progress. Shapes come from the typed Eden client.
type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type Imports = MainClient['v1']['me']['library-imports'];
type Upload = NonNullable<Parameters<Imports['post']>[0]>;
type Rows = Ok<ReturnType<Imports>['rows']['get']>;

export type ImportFormat = Upload['format'];
export type CsvMapping = NonNullable<Upload['mapping']>;
export type SourceStatus = CsvMapping['statuses'][string] & string;
export type ImportRow = Rows['rows'][number];
export type RowMatch = NonNullable<ImportRow['match']>;
export type RowResolution = NonNullable<ImportRow['resolution']>;
export interface CsvInspection { headers: string[]; distinctValues: Record<string, string[]> }
export interface ApplyProgress { total: number; completed: number; issues: number; pending: boolean;
  state?: 'review' | 'pending' | 'completed' | 'stalled' | 'failed';
  reason?: null | 'no-progress' | 'lease-expired' | 'owner-refused' | 'apply-failed' | 'worker-stopped'; receipt?: string }
export interface ImportRequestOptions { signal?: AbortSignal }
export interface ApplyRequestOptions extends ImportRequestOptions { resume?: boolean }
/** What Main keeps once a row is applied: the same intent is sent on every resumed `apply`. */
export interface ApplyIntent { context: string | null; language: string }

export type ImportFailure = 'missing' | 'conflict' | 'invalid' | 'unavailable' | 'denied' | 'budget' | 'admission' | 'pending';
export class ImportError extends Error {
  constructor(readonly failure: ImportFailure, message: string = failure) { super(message); }
}

export interface ImportApi {
  /** A CSV without a mapping is only inspected: Main answers its headers and distinct values and stores nothing. */
  inspect: (file: string, options?: ImportRequestOptions) => Promise<CsvInspection>;
  create: (input: { format: ImportFormat; file: string; mapping?: CsvMapping }, options?: ImportRequestOptions) => Promise<{ id: string; total: number }>;
  /** Up to eight rows after `cursor` (-1 for the first), matching any Main has not matched yet. */
  rows: (id: string, cursor: number, options?: ImportRequestOptions) => Promise<{ rows: ImportRow[]; nextCursor: number | null }>;
  resolve: (id: string, row: ImportRow, choice: RowResolution, options?: ImportRequestOptions) => Promise<void>;
  apply: (id: string, intent: ApplyIntent, options?: ApplyRequestOptions) => Promise<ApplyProgress>;
  status?: (id: string, options?: ImportRequestOptions) => Promise<ApplyProgress>;
  discard: (id: string, options?: ImportRequestOptions) => Promise<void>;
  /** Adds an Open Library candidate of this row to the catalogue; answers the Work to resolve the row to. */
  adopt: (id: string, row: number, workId: string, locale: string, options?: ImportRequestOptions) => Promise<string>;
}

/** What one import takes (`FILE_IMPORT_COST.bytes`); a larger file is refused before it is read. */
export const UPLOAD_LIMIT_BYTES = 2 * 1024 * 1024;

const key = () => `library-import:${crypto.randomUUID()}`;
type Wait = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
const wait: Wait = pauseForImport;
export const IMPORT_REQUEST_WINDOW_MS = 30_000;
export const IMPORT_REQUEST_ATTEMPTS = 16;

/** Retry-After accepts seconds or an HTTP date; an absent value waits one second. */
function admissionDelay(response: Response | undefined): number {
  const value = response?.headers.get('retry-after');
  const seconds = value && /^\d+$/.test(value) ? Number(value) : undefined;
  const date = value && seconds === undefined ? Date.parse(value) : NaN;
  return seconds !== undefined ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}
interface Window { signal: AbortSignal; started: number; waited: number; attempts: number }
function requestWindow(signal?: AbortSignal): Window {
  const deadline = AbortSignal.timeout(IMPORT_REQUEST_WINDOW_MS);
  return { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, started: Date.now(), waited: 0, attempts: 0 };
}
async function waitForAdmission(response: Response | undefined, pause: Wait, window: Window,
  exhausted: 'admission' | 'pending'): Promise<void> {
  const delay = admissionDelay(response);
  if (Math.max(Date.now() - window.started, window.waited) + delay >= IMPORT_REQUEST_WINDOW_MS) {
    throw new ImportError(exhausted);
  }
  await abortable(pause(delay, window.signal), window.signal);
  window.waited += delay;
}

function failure(status: number): ImportError {
  if (status < 100) throw new Error('Import request response could not be confirmed');
  return new ImportError(status === 404 ? 'missing' : status === 409 ? 'conflict'
    : status === 400 || status === 422 ? 'invalid' : status === 401 || status === 403 ? 'denied' : 'unavailable');
}

interface Reply<Data> { status: number; data: Data | null; error?: { value?: unknown } | null; response?: Response }

/** A command retains its idempotency key through bounded, cancellable admission waits. */
async function call<Data>(send: (headers: { 'idempotency-key': string }, signal: AbortSignal) => Promise<Reply<Data>>,
  accepted: readonly number[], idempotencyKey: string, pause: Wait, window: Window): Promise<Reply<Data> & { data: Data }> {
  const headers = { 'idempotency-key': idempotencyKey };
  while (window.attempts < IMPORT_REQUEST_ATTEMPTS) {
    window.signal.throwIfAborted();
    window.attempts += 1;
    const reply = await abortable(send(headers, window.signal), window.signal);
    if (reply.status === 429 && problemCode(reply.error?.value)?.endsWith('_budget')) throw new ImportError('budget');
    if (reply.status === 429) {
      if (window.attempts === IMPORT_REQUEST_ATTEMPTS) throw new ImportError('admission');
      await waitForAdmission(reply.response, pause, window, 'admission'); continue;
    }
    if (accepted.includes(reply.status)) {
      if (reply.data === null) throw new ImportError('invalid');
      return { ...reply, data: reply.data };
    }
    throw failure(reply.status);
  }
  throw new ImportError('admission');
}

export function mainImportApi(agent: string, main: () => MainClient = browserMainApi, pause: Wait = wait): ImportApi {
  const imports = () => main().v1.me['library-imports'];
  const request = <Data>(send: (headers: { 'idempotency-key': string }, signal: AbortSignal) => Promise<Reply<Data>>,
    accepted: readonly number[] = [200], options?: ImportRequestOptions, idempotencyKey = key(), window = requestWindow(options?.signal)) => call(send, accepted, idempotencyKey, pause, window);
  return {
    async inspect(file, options) {
      const { data } = await request((headers, signal) => imports().post({ actingSubject: agent, format: 'generic-csv', file },
        { headers, fetch: { signal } }) as Promise<Reply<CsvInspection>>, [200], options);
      return data;
    },
    async create({ format, file, mapping }, options) {
      const { data } = await request((headers, signal) => imports().post({ actingSubject: agent, format, file,
        ...(mapping ? { mapping } : {}) }, { headers, fetch: { signal } }) as Promise<Reply<{ id: string; total: number }>>, [201], options);
      return data;
    },
    async rows(id, cursor, options) {
      const { data } = await request((headers, signal) => imports()({ id }).rows.get({ query: { actingSubject: agent,
        ...(cursor >= 0 ? { cursor } : {}) }, headers, fetch: { signal } }) as Promise<Reply<Rows>>, [200], options);
      return data;
    },
    async resolve(id, row, choice, options) {
      await request((headers, signal) => imports()({ id }).rows({ row: row.index }).put({ actingSubject: agent,
        expectedVersion: row.version, ...choice }, { headers, fetch: { signal } }), [200], options);
    },
    async apply(id, intent, options) {
      const { data } = await request((headers, signal) => imports()({ id }).apply.post({ actingSubject: agent, ...intent, ...(options?.resume ? { resume: true } : {}) },
        { headers, fetch: { signal } }) as Promise<Reply<ApplyProgress>>, [200, 202], options);
      return data;
    },
    async status(id, options) {
      const { data } = await request((headers, signal) => imports()({ id }).apply.get({
        query: { actingSubject: agent }, headers, fetch: { signal } }) as Promise<Reply<ApplyProgress>>, [200, 202], options);
      return data;
    },
    async discard(id, options) {
      await request((headers, signal) => imports()({ id }).delete(undefined, { query: { actingSubject: agent }, headers, fetch: { signal } }), [200], options);
    },
    async adopt(id, row, workId, locale, options) {
      const window = requestWindow(options?.signal);
      try {
        for (let attempt = 0; attempt < IMPORT_REQUEST_ATTEMPTS; attempt++) {
          const answer = await request((headers, signal) => imports()({ id }).rows({ row }).adoptions.post({
            actingSubject: agent, workId, titleLanguage: locale }, { headers, fetch: { signal } }), [200, 202], options,
          `library-import:adopt:${id}:${row}:${workId}`, window);
          const data = answer.data as { work?: string };
          if (data.work) return data.work;
          if (answer.status !== 202) throw new ImportError('invalid');
          if (attempt + 1 === IMPORT_REQUEST_ATTEMPTS) throw new ImportError('pending');
          await waitForAdmission(answer.response, pause, window, 'pending');
        }
        throw new ImportError('pending');
      } catch (failure) {
        if (window.signal.aborted && !options?.signal?.aborted) throw new ImportError('pending');
        throw failure;
      }
    },
  };
}
