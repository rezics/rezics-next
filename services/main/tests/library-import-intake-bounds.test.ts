import { expect, spyOn, test } from 'bun:test';
import { Elysia, ParseError, ValidationError } from 'elysia';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { RATE_LIMIT_V1 } from '../src/modules/rate-limit/budgets.ts';
import { rateLimitHook } from '../src/modules/rate-limit/hook.ts';
import { adapters, parseLibraryFile } from '../src/modules/library-import/formats/index.ts';
import { FILE_IMPORT_COST, FileImportInvalid, emptyRow, type LibraryFileFormat } from '../src/modules/library-import/formats/contract.ts';
import { inspectGenericCsv } from '../src/modules/library-import/formats/generic-csv.ts';
import { importJsonBytes } from '../src/modules/library-import/formats/bounds.ts';
import { libraryImportsRoutes, LIBRARY_IMPORT_BODY_BYTES, readLibraryImportBody } from '../src/routes/library-imports.ts';
import { problem, typedRefusal } from '../src/routes/problems.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const agent = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const mapping = { title: 'Title',statuses: {} };
const envelope = (file = 'Title\nBook',mapped = true) => JSON.stringify({ actingSubject: agent,
  format: 'generic-csv',file,...(mapped ? { mapping } : {}) });
function request(body: string | ReadableStream<Uint8Array>, headers: Record<string,string> = {}, signal?: AbortSignal) {
  return new Request('http://main.local/v1/me/library-imports',{ method: 'POST',
    headers: { authorization: 'Bearer reader','content-type': 'application/json','idempotency-key': 'import-file',...headers },
    body,signal });
}
function stream(chunks: Uint8Array[], stalled = false) {
  let pulls = 0, cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else if (!stalled) controller.close();
    },
    cancel() { cancellations++; },
  },{ highWaterMark: 0 });
  return { body,pulls: () => pulls,cancellations: () => cancellations };
}
function fixture(options: { denied?: boolean; own?: boolean; budget?: boolean } = {}) {
  const events: string[] = [];
  const deps = {
    account: { verify: async (_request: Request,scopes: readonly string[]) => {
      events.push(scopes.length ? 'bearer' : 'budget-bearer');
      if (options.denied) throw new AccountAssertionDenied('Bearer refused');
      return { issuer: 'test',subject: 'reader',accountScopes: ['work:read','library:write'] };
    } },
    access: { canReadAsBaselineMember: async (_principal: unknown,actor: string) => {
      events.push('actor'); expect(actor).toBe(agent); return options.own !== false;
    } },
    libraryFiles: { create: async (_agent: string,_key: string,_digest: string,_format: string,rows: unknown[]) => {
      events.push('create'); return { id: fileId,total: rows.length };
    } },
    libraryImport: {},
    rateLimit: {
      budgets: RATE_LIMIT_V1, options: { secret: 'test',serviceClientIds: new Set(),trustedProxyPeers: new Set(),clientIpHeader: 'x-forwarded-for' },
      store: { classify: async () => 'member',consume: async (_identity: string,family: string) => {
        events.push('budget'); expect(family).toBe('upload'); return { allowed: options.budget !== false,retryAfter: 60 };
      } },
    },
  } as unknown as MainWorkDependencies;
  // Thrown intake refusals use the shared table. Schema failures use the same
  // 400 the app hook returns; this plugin no longer carries its own error hook.
  const app = new Elysia().error(({ error }) => typedRefusal(error)
    ?? (error instanceof ValidationError || error instanceof ParseError
      ? problem(400, 'invalid_request', 'Request does not match the Work contract') : undefined))
    .use(rateLimitHook(deps.account,deps.rateLimit)).use(libraryImportsRoutes(deps));
  return { app,events };
}

test('declared oversize is refused before reading or JSON parsing', async () => {
  const f = fixture(), intake = stream([],true);
  const json = spyOn(JSON,'parse');
  try {
    const response = await f.app.handle(request(intake.body,{ 'content-length': String(LIBRARY_IMPORT_BODY_BYTES+1) }));
    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ status: 413,code: 'library_import_too_large' });
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(intake.pulls()).toBe(0);
    expect(intake.cancellations()).toBe(1);
    expect(f.events).toEqual([]);
  } finally { json.mockRestore(); }
});

test.each([undefined,'1'])('stream cap refuses missing or inaccurate length (%s) without JSON parsing', async length => {
  const f = fixture(), intake = stream([new Uint8Array(LIBRARY_IMPORT_BODY_BYTES),new Uint8Array([1]),new Uint8Array([2])]);
  const json = spyOn(JSON,'parse');
  try {
    const response = await f.app.handle(request(intake.body,length ? { 'content-length': length } : {}));
    expect(response.status).toBe(413);
    expect(json).not.toHaveBeenCalled();
    expect(intake.pulls()).toBe(2);
    expect(intake.cancellations()).toBe(1);
    expect(f.events).toEqual([]);
  } finally { json.mockRestore(); }
});

test('a bad bearer with a large valid body is refused before JSON or format parsing', async () => {
  const f = fixture({ denied: true });
  const large = `Title\n${Array.from({ length: FILE_IMPORT_COST.rows },() => 'Book '.repeat(20)).join('\n')}`;
  const incoming = request(envelope(large));
  const json = spyOn(JSON,'parse'), parse = spyOn(adapters,'generic-csv');
  try {
    const response = await f.app.handle(incoming);
    expect(response.status).toBe(401);
    expect(json).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(f.events).toEqual(['bearer']);
  } finally { json.mockRestore(); parse.mockRestore(); }
});

test.each([true,false])('exhausted upload budget refuses mapped=%s before file parsing or CSV inspection', async mapped => {
  const f = fixture({ budget: false }), parse = spyOn(adapters,'generic-csv');
  try {
    // Deliberately malformed CSV proves the preview path also waits for budget.
    const response = await f.app.handle(request(envelope('Title\n"unclosed',mapped)));
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: 'rate_limited',family: 'upload' });
    expect(parse).not.toHaveBeenCalled();
    expect(f.events).toEqual(['bearer','budget-bearer','budget']);
  } finally { parse.mockRestore(); }
});

test.each([true,false])('another actor is refused before mapped=%s file parsing or CSV inspection', async mapped => {
  const f = fixture({ own: false }), parse = spyOn(adapters,'generic-csv');
  try {
    const response = await f.app.handle(request(envelope('Title\n"unclosed',mapped)));
    expect(response.status).toBe(403);
    expect(parse).not.toHaveBeenCalled();
    expect(f.events).toEqual(['bearer','budget-bearer','budget','actor']);
  } finally { parse.mockRestore(); }
});

test('admitted imports and previews keep their response and schema behavior', async () => {
  const f = fixture(), parse = spyOn(adapters,'generic-csv');
  try {
    expect((await f.app.handle(request(envelope()))).status).toBe(201);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(f.events).toEqual(['bearer','budget-bearer','budget','actor','create']);
    const preview = await f.app.handle(request(envelope('Title\nBook',false)));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ headers: ['Title'],distinctValues: { Title: ['Book'] } });
    expect((await f.app.handle(request(JSON.stringify({ actingSubject: agent,format: 'other',file: 'Title\nBook' })))).status).toBe(400);
    expect((await f.app.handle(request('{malformed'))).status).toBe(400);
  } finally { parse.mockRestore(); }
});

test('body and UTF-8 file limits include their exact boundary', async () => {
  const prefix = JSON.stringify({ actingSubject: agent,format: 'generic-csv',file: '' });
  const body = prefix.slice(0,-2)+'x'.repeat(LIBRARY_IMPORT_BODY_BYTES-Buffer.byteLength(prefix))+'"}';
  expect(Buffer.byteLength(body)).toBe(LIBRARY_IMPORT_BODY_BYTES);
  expect(await readLibraryImportBody(request(body))).toHaveProperty('file');
  const f = fixture();
  const response = await f.app.handle(request(envelope(`Title\n${'书'.repeat(Math.floor(FILE_IMPORT_COST.bytes/3)+1)}`)));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: 'invalid_library_file' });
  const file = 'Title,Notes\n'+Array(131).fill('Book,'+'x'.repeat(16000)).join('\n');
  const exact = file+'x'.repeat(FILE_IMPORT_COST.bytes-Buffer.byteLength(file));
  expect(Buffer.byteLength(exact)).toBe(FILE_IMPORT_COST.bytes);
  expect((await f.app.handle(request(envelope(exact)))).status).toBe(201);
});

test('transfer stalls, aborts and empty-chunk floods are bounded and cancelled', async () => {
  const stalled = stream([],true);
  await expect(readLibraryImportBody(request(stalled.body),5)).rejects.toThrow();
  expect(stalled.cancellations()).toBe(1);
  const aborted = stream([],true), abort = new AbortController(); abort.abort();
  await expect(readLibraryImportBody(request(aborted.body,{},abort.signal),5)).rejects.toThrow();
  expect(aborted.pulls()).toBe(0);
  expect(aborted.cancellations()).toBe(1);
  let cancellations = 0;
  const flood = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array()); },cancel() { cancellations++; } },{ highWaterMark: 0 });
  await expect(readLibraryImportBody(request(flood),5)).rejects.toThrow();
  expect(cancellations).toBe(1);
});

test.each(['-1','NaN','1e4','9007199254740992'])('malformed length %s is refused without consuming the body', async length => {
  const f = fixture(), intake = stream([],true);
  expect((await f.app.handle(request(intake.body,{ 'content-length': length }))).status).toBe(400);
  expect(intake.pulls()).toBe(0);
  expect(intake.cancellations()).toBe(1);
});

const atRows = (format: LibraryFileFormat,count: number) => {
  if (format === 'rezics') return JSON.stringify({ profile: 'rezics-library-export-v1',rows: Array.from({ length: count },(_,i) => emptyRow(String(i),'Book',{})) });
  // XML export metadata is a retained row in the existing canonical format.
  if (format === 'mal') return `<myanimelist>${Array.from({ length: count-1 },(_,i) => `<anime><series_animedb_id>${i+1}</series_animedb_id><series_title>Book</series_title></anime>`).join('')}</myanimelist>`;
  if (format === 'vndb') return `<vndb-export version="1.0"><vns>${Array.from({ length: count-1 },(_,i) => `<vn id="v${i+1}"><title>Book</title></vn>`).join('')}</vns></vndb-export>`;
  const header = format === 'goodreads' ? 'Title,Exclusive Shelf' : format === 'storygraph' ? 'Title,Read Status' : 'Title';
  return `${header}\n${Array.from({ length: count },() => format === 'generic-csv' ? 'Book' : 'Book,read').join('\n')}`;
};
test.each(Object.keys(adapters) as LibraryFileFormat[])('%s parses the row limit and refuses one more row', format => {
  expect(parseLibraryFile(format,atRows(format,FILE_IMPORT_COST.rows),mapping)).toHaveLength(FILE_IMPORT_COST.rows);
  expect(() => parseLibraryFile(format,atRows(format,FILE_IMPORT_COST.rows+1),mapping)).toThrow(FileImportInvalid);
});

test('JSON row count is refused before visiting a malformed first row', () => {
  const file = JSON.stringify({ profile: 'rezics-library-export-v1',rows: Array(FILE_IMPORT_COST.rows+1).fill(null) });
  expect(() => parseLibraryFile('rezics',file)).toThrow('1 to 5,000 rows');
});

test('private JSON depth and expanded XML/CSV evidence cannot amplify bounded files', () => {
  const nested = '{"child":'.repeat(FILE_IMPORT_COST.nesting+1)+'null'+'}'.repeat(FILE_IMPORT_COST.nesting+1);
  const row = JSON.stringify(emptyRow('private','',{}));
  expect(() => parseLibraryFile('rezics',`{"profile":"rezics-library-export-v1","rows":[${row.replace('"raw":{}',`"raw":${nested}`)}]}`)).toThrow(FileImportInvalid);
  const large = emptyRow('private','',{ evidence: 'x'.repeat(FILE_IMPORT_COST.rowBytes) });
  expect(() => parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [large] }))).toThrow(FileImportInvalid);
  expect(parseLibraryFile('rezics',JSON.stringify({ profile: 'rezics-library-export-v1',rows: [{ ...large,kind: 'retained' }] }))).toHaveLength(1);
  const xml = `<vndb-export version="1.0"><vns><vn id="v1"><title>Book</title>${'<x/>'.repeat(30000)}</vn></vns></vndb-export>`;
  expect(Buffer.byteLength(xml)).toBeLessThan(FILE_IMPORT_COST.bytes);
  expect(() => parseLibraryFile('vndb',xml)).toThrow(FileImportInvalid);
  const headers = Array.from({ length: 64 },(_,i) => `column${i}${'x'.repeat(14000)}`);
  const csv = `${headers.join(',')}\n${Array.from({ length: 100 },() => Array(64).fill('x').join(',')).join('\n')}`;
  expect(Buffer.byteLength(csv)).toBeLessThan(FILE_IMPORT_COST.bytes);
  expect(() => inspectGenericCsv(csv)).toThrow('byte budget');
});

test('evidence byte accounting agrees with JSON for escaped and Unicode fields', () => {
  const value = { title: '书😀',raw: { 'quote"': ['line\n',null,1,true],optional: undefined } };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  expect(importJsonBytes(value,bytes)).toBe(bytes);
  expect(() => importJsonBytes(value,bytes-1)).toThrow(FileImportInvalid);
});
