import { browserMainApi } from '../api/browser.ts';
import { type MainClient, problemCode } from '../discover/types.ts';

// Main parses, matches and applies library files (`services/main/src/routes/library-imports.ts`). The
// browser sends the file text, pages through the rows Main reports, forwards the reader's choices and
// repeats `apply` until Main says nothing is pending. Shapes come from the typed Eden client.
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
export interface ApplyProgress { total: number; completed: number; issues: number; pending: boolean }
/** What Main keeps once a row is applied: the same intent is sent on every resumed `apply`. */
export interface ApplyIntent { context: string | null; language: string }

export type ImportFailure = 'missing' | 'conflict' | 'invalid' | 'unavailable' | 'denied' | 'budget';
export class ImportError extends Error {
  constructor(readonly failure: ImportFailure, message: string = failure) { super(message); }
}

export interface ImportApi {
  /** A CSV without a mapping is only inspected: Main answers its headers and distinct values and stores nothing. */
  inspect: (file: string) => Promise<CsvInspection>;
  create: (input: { format: ImportFormat; file: string; mapping?: CsvMapping }) => Promise<{ id: string; total: number }>;
  /** Up to eight rows after `cursor` (-1 for the first), matching any Main has not matched yet. */
  rows: (id: string, cursor: number) => Promise<{ rows: ImportRow[]; nextCursor: number | null }>;
  resolve: (id: string, row: ImportRow, choice: RowResolution) => Promise<void>;
  apply: (id: string, intent: ApplyIntent) => Promise<ApplyProgress>;
  discard: (id: string) => Promise<void>;
  /** Adds an Open Library candidate of this row to the catalogue; answers the Work to resolve the row to. */
  adopt: (id: string, row: number, workId: string, locale: string) => Promise<string>;
}

const key = () => `library-import:${crypto.randomUUID()}`;

/** Retry-After accepts seconds or an HTTP date; an absent value waits one second. */
async function waitForAdmission(response: Response | undefined): Promise<void> {
  const value = response?.headers.get('retry-after');
  const seconds = value && /^\d+$/.test(value) ? Number(value) : undefined;
  const date = value && seconds === undefined ? Date.parse(value) : NaN;
  const delay = seconds !== undefined ? seconds * 1000
    : Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
}

function failure(status: number): ImportError {
  return new ImportError(status === 404 ? 'missing' : status === 409 ? 'conflict'
    : status === 400 || status === 422 ? 'invalid' : status === 401 || status === 403 ? 'denied' : 'unavailable');
}

interface Reply<Data> { status: number; data: Data | null; error?: { value?: unknown } | null; response?: Response }

/** One command or read with its own `Idempotency-Key`; Main's short-window admission is waited out, never surfaced. */
async function call<Data>(send: (headers: { 'idempotency-key': string }) => Promise<Reply<Data>>,
  accepted: readonly number[] = [200], idempotencyKey = key()): Promise<{ status: number; data: Data }> {
  const headers = { 'idempotency-key': idempotencyKey };
  for (let attempt = 0; attempt < 8; attempt++) {
    const reply = await send(headers);
    // A daily search or adoption budget is a refusal, not a short-window admission to wait out.
    if (reply.status === 429 && problemCode(reply.error?.value)?.endsWith('_budget')) throw new ImportError('budget');
    if (reply.status === 429) { await waitForAdmission(reply.response); continue; }
    if (accepted.includes(reply.status) && reply.data !== null) return { status: reply.status, data: reply.data };
    throw failure(reply.status);
  }
  throw new ImportError('unavailable');
}

export function mainImportApi(agent: string, main: () => MainClient = browserMainApi): ImportApi {
  const imports = () => main().v1.me['library-imports'];
  return {
    async inspect(file) {
      const { data } = await call(headers => imports().post({ actingSubject: agent, format: 'generic-csv', file },
        { headers }) as Promise<Reply<CsvInspection>>);
      return data;
    },
    async create({ format, file, mapping }) {
      const { data } = await call(headers => imports().post({ actingSubject: agent, format, file,
        ...(mapping ? { mapping } : {}) }, { headers }) as Promise<Reply<{ id: string; total: number }>>, [201]);
      return data;
    },
    async rows(id, cursor) {
      const { data } = await call(headers => imports()({ id }).rows.get({ query: { actingSubject: agent,
        ...(cursor >= 0 ? { cursor } : {}) }, headers }) as Promise<Reply<Rows>>);
      return data;
    },
    async resolve(id, row, choice) {
      await call(headers => imports()({ id }).rows({ row: row.index }).put({ actingSubject: agent,
        expectedVersion: row.version, ...choice }, { headers }));
    },
    async apply(id, intent) {
      const { data } = await call(headers => imports()({ id }).apply.post({ actingSubject: agent, ...intent },
        { headers }) as Promise<Reply<ApplyProgress>>, [200, 202]);
      return data;
    },
    async discard(id) {
      await call(headers => imports()({ id }).delete(undefined, { query: { actingSubject: agent }, headers }));
    },
    async adopt(id, row, workId, locale) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const answer = await call(headers => imports()({ id }).rows({ row }).adoptions.post({
          actingSubject: agent, workId, titleLanguage: locale }, { headers }), [200, 202],
        `library-import:adopt:${id}:${row}:${workId}`);
        const data = answer.data as { work?: string };
        if (data.work) return data.work;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new ImportError('unavailable');
    },
  };
}
