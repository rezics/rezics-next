import { Elysia, t, ValidationError } from 'elysia';
import type { VerifiedAccountAssertion } from '../modules/account/verify-assertion.ts';
import { problemResult } from '../api-contract.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { canonicalRow, csvMapping, FILE_IMPORT_COST, FileImportInvalid, FileImportUnsupported } from '../modules/library-import/formats/contract.ts';
import { parseLibraryFile } from '../modules/library-import/formats/index.ts';
import { inspectGenericCsv } from '../modules/library-import/formats/generic-csv.ts';
import { importDigest, LibraryFileMissing } from '../modules/library-import/file-store.ts';
import { mainCall, matchLibraryRow } from '../modules/library-import/match.ts';
import { adoptLibrarySource, searchLibrarySource } from '../modules/library-import/open-library.ts';
import { getLibraryImportApplyWorker } from '../modules/library-import/apply-worker.ts';
import { ReaderImportConflict, ReaderImportInvalid, ReaderImportUnavailable } from '../modules/library-import/reader-import.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError } from './work-reads.ts';
import { workRead } from '../modules/work/read-session.ts';
import { resolveTargets, TargetNotBound } from '../modules/target/resolve.ts';
import type { CapabilityDeclarations } from '../modules/mcp/capabilities.ts';

const headers = { 'cache-control': 'private, no-store' };
const closed = { additionalProperties: false };
const errors = Object.fromEntries([400,401,403,404,409,422,503].map(status => [status,problemResult(status)]));
const base = '/v1/me/library-imports';
export const LIBRARY_IMPORT_BODY_BYTES = FILE_IMPORT_COST.bytes+16384;
const IMPORT_TRANSFER_MS = 30_000;
class LibraryImportTooLarge extends Error {}
class LibraryImportTimedOut extends Error {}
class LibraryImportIntakeRefused extends Error {
  constructor(readonly response: Response) { super('Library import intake refused'); }
}
function cancelImportBody(request: Request) {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
}
function checkImportLength(request: Request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new FileImportInvalid('Invalid import content length');
  }
  if (declared !== null && Number(declared) > LIBRARY_IMPORT_BODY_BYTES) throw new LibraryImportTooLarge();
}
/** The envelope is bounded before JSON decoding, regardless of length claims.
 * Cancellation never waits for an untrusted stream's cancellation hook. */
export async function readLibraryImportBody(request: Request, transferMs = IMPORT_TRANSFER_MS,
  beforeDecode: () => Promise<void> = async () => undefined): Promise<unknown> {
  checkImportLength(request);
  if (!request.body) throw new FileImportInvalid('Choose a library import body');
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve,reject) => {
    stop = error => { reject(error); void reader.cancel(error).catch(() => undefined); };
    timer = setTimeout(() => stop(new LibraryImportTimedOut()),transferMs);
  });
  const abort = () => stop(new FileImportInvalid('Import transfer aborted'));
  request.signal.addEventListener('abort',abort,{ once: true });
  const deadline = performance.now()+transferMs;
  const transfer = async () => {
    const bytes = new Uint8Array(LIBRARY_IMPORT_BODY_BYTES);
    let length = 0;
    for (;;) {
      if (request.signal.aborted) throw new FileImportInvalid('Import transfer aborted');
      if (performance.now() >= deadline) throw new LibraryImportTimedOut();
      const { done,value } = await reader.read();
      if (request.signal.aborted) throw new FileImportInvalid('Import transfer aborted');
      if (performance.now() >= deadline) throw new LibraryImportTimedOut();
      if (done) return bytes.subarray(0,length);
      if (value.byteLength > LIBRARY_IMPORT_BODY_BYTES-length) throw new LibraryImportTooLarge();
      bytes.set(value,length); length += value.byteLength;
    }
  };
  try {
    const bytes = await Promise.race([transfer(),interrupted]);
    clearTimeout(timer);
    // Verify at the end of a potentially slow transfer, so expiry or consent
    // revocation during intake cannot survive into file admission.
    await beforeDecode();
    if (request.signal.aborted) throw new FileImportInvalid('Import transfer aborted');
    try { return JSON.parse(new TextDecoder('utf-8',{ fatal: true }).decode(bytes)); }
    catch { throw new FileImportInvalid('Malformed library import JSON'); }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort',abort);
    reader.releaseLock();
  }
}
export const openApiOperations = {
  '/v1/me/library-imports': { post: { exposure: 'public', rateLimitFamily: 'upload', bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}': { delete: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows': { get: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows/{row}': { put: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/apply': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true, idempotencyKey: true },
    post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows/{row}/adoptions': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
} as const;
export const capabilities = {
  '/v1/me/library-imports/{id}': { delete: { disposition: 'supported', mcp: { tool: 'library_import_delete', title: 'Delete an uploaded library file',
    scopes: ['work:read','library:write'], description: 'Delete your uploaded source rows and import plans. Applied Library records remain. Uploads otherwise expire seven days after creation.' } } },
  '/v1/me/library-imports': { post: { disposition: 'supported', mcp: { tool: 'library_import_create', title: 'Import a library file',
    scopes: ['work:read','library:write'],
    description: 'Upload your own library export or mapped CSV. Uploads expire after seven days; save an export to retain source fields. Catalogue matches are reviewed before applying. A CSV without mapping returns headers without storing the file.' } } },
  '/v1/me/library-imports/{id}/rows': { get: { disposition: 'supported', mcp: { tool: 'library_import_rows', title: 'Review library import rows',
    scopes: ['work:read'],
    description: 'Page through every source row and its catalogue or Open Library candidates, retaining unsupported source fields.' } } },
  '/v1/me/library-imports/{id}/rows/{row}': { put: { disposition: 'supported', mcp: { tool: 'library_import_resolve', title: 'Resolve a library import row',
    scopes: ['work:read','library:write'],
    description: 'Choose a native Work and optional exact target, or keep the row private. expectedVersion protects concurrent review.' } } },
  '/v1/me/library-imports/{id}/apply': { get: { disposition: 'supported', mcp: { tool: 'library_import_status', title: 'Check a library import',
    scopes: ['work:read'],description: 'Read progress and the server-owned completion, failure or stall reason for your uploaded library.' } },
    post: { disposition: 'supported', mcp: { tool: 'library_import_apply', title: 'Apply a reviewed library import',
    scopes: ['work:read','library:write','collection:edit','rating:read','rating:submit'],
    description: 'Start a reviewed library job through ordinary commands. Read its status; explicitly resume a failed or stalled job with fresh authority.' } } },
  '/v1/me/library-imports/{id}/rows/{row}/adoptions': { post: { disposition: 'supported', mcp: { tool: 'library_import_adopt', title: 'Adopt an Open Library candidate',
    scopes: ['work:read','library:write','work:create'],
    description: 'Explicitly adopt a reviewed Open Library candidate using ordinary catalogue authority. Resolve the source row separately to the returned Work before applying.' } } },
} as const satisfies CapabilityDeclarations;
const match = t.Object({ kind: t.Union([t.Literal('matched'),t.Literal('ambiguous'),t.Literal('not-found')]),
  work: t.Nullable(readId), target: t.Nullable(readId), truncated: t.Boolean(),
  openLibraryAvailability: t.Union([t.Literal('available'),t.Literal('budget-exceeded'),t.Literal('unavailable'),t.Literal('not-requested')]),
  candidates: t.Array(t.Object({ work: readId,target: t.Nullable(readId),title: t.String(),creators: t.Array(t.String()) }),{ maxItems: 80 }),
  openLibrary: t.Array(t.Object({ workId: t.String(),title: t.String(),authors: t.Array(t.String()),coverId: t.Nullable(t.Integer()) }),{ maxItems: 6 }) });
const resolution = t.Object({ choice: t.Union([t.Literal('apply'),t.Literal('private')]), work: t.Optional(readId), target: t.Optional(readId),
  conflictChoice: t.Optional(t.Union([t.Literal('keep'),t.Literal('replace')])) },closed);
const rowView = t.Object({ index: t.Integer(), source: canonicalRow, match: t.Nullable(match), resolution: t.Nullable(resolution),
  outcome: t.Nullable(t.Object({ applied: t.Array(t.String()),issues: t.Array(t.String()) })),version: t.Integer() });
const applyProgress = t.Object({ total: t.Integer(),completed: t.Integer(),issues: t.Integer(),pending: t.Boolean(),
  state: t.Union(['review','pending','completed','stalled','failed'].map(value => t.Literal(value))),
  reason: t.Nullable(t.Union(['no-progress','lease-expired','owner-refused','apply-failed','worker-stopped'].map(value => t.Literal(value)))),
  receipt: t.Optional(t.String()) });
function failure(error: unknown): Response {
  if (error instanceof LibraryImportTooLarge) return problem(413,'library_import_too_large','Import body exceeds 2 MiB plus the 16 KiB request envelope');
  if (error instanceof LibraryImportTimedOut) return problem(408,'library_import_timeout','Import transfer timed out');
  if (error instanceof LibraryFileMissing) return problem(404,'library_import_missing',error.message);
  if (error instanceof FileImportInvalid || error instanceof ReaderImportInvalid || error instanceof TargetNotBound) return problem(400,'invalid_library_file',error.message);
  if (error instanceof FileImportUnsupported) return problem(422,'library_format_unavailable',error.message);
  if (error instanceof ReaderImportConflict) return problem(409,'library_import_conflict',error.message);
  if (error instanceof ReaderImportUnavailable) return problem(503,'library_import_unavailable',error.message);
  return workReadError(error);
}
export function libraryImportsRoutes(deps: MainWorkDependencies) {
  const worker=deps.libraryFiles && deps.libraryImport ? getLibraryImportApplyWorker(deps.libraryFiles,deps.libraryImport) : null;
  const intakePrincipals = new WeakMap<Request,VerifiedAccountAssertion>();
  async function own(request: Request, agent: string, write = false, verified?: VerifiedAccountAssertion) {
    const key = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new ReaderImportInvalid('A valid Idempotency-Key is required');
    const principal = verified ?? await deps.account.verify(request,write ? ['work:read','library:write'] : ['work:read']);
    if (!await deps.access.canReadAsBaselineMember?.(principal,agent)) return problem(403,'library_import_denied','Import files are private to your own Person');
    if (!deps.libraryFiles || !deps.libraryImport) throw new ReaderImportUnavailable('Library import is unavailable');
    return { key, principal };
  }
  return new Elysia()
    .cleanup(async () => { await worker?.stop(); })
    .delete(`${base}/:id`, { params: t.Object({ id: readUuid }),
      query: t.Object({ actingSubject: readId },closed),response: { 200: t.Object({ deleted: t.Literal(true) }),...errors },
    },async ({ request,params,query }) => {
      try {
        const admission = await own(request,query.actingSubject,true); if (admission instanceof Response) return admission;
        await deps.libraryFiles!.delete(query.actingSubject,params.id,admission.key);
        return Response.json({ deleted: true },{ headers });
      } catch (error) { return failure(error); }
    })
    .post(base, { body: t.Object({ actingSubject: readId,
      format: t.Union([t.Literal('goodreads'),t.Literal('storygraph'),t.Literal('generic-csv'),t.Literal('vndb'),t.Literal('mal'),t.Literal('rezics')]),
      file: t.String({ maxLength: FILE_IMPORT_COST.bytes }),mapping: t.Optional(csvMapping) },closed),
      parse: 'none',
      // Preserve the authored request schema while supplying its body only
      // after bounded intake. Global upload-budget admission then precedes the
      // handler's actor check and every format adapter (including CSV preview).
      transform: async context => {
        try {
          checkImportLength(context.request);
          context.body = await readLibraryImportBody(context.request,IMPORT_TRANSFER_MS,async () => {
            const principal = await deps.account.verify(context.request,['work:read','library:write']);
            intakePrincipals.set(context.request,principal);
          }) as typeof context.body;
        } catch (error) { throw new LibraryImportIntakeRefused(failure(error)); }
        finally { cancelImportBody(context.request); }
      },
      error: ({ error }) => {
        if (error instanceof LibraryImportIntakeRefused) return error.response;
        if (error instanceof ValidationError) return problem(400,'invalid_request','Request does not match the Work contract');
      },
      response: { 201: t.Object({ id: readUuid,total: t.Integer({ minimum: 1,maximum: 5000 }) }),
        200: t.Object({ headers: t.Array(t.String(),{ maxItems: 64 }),distinctValues: t.Record(t.String(),t.Array(t.String(),{ maxItems: 50 })) }),
        ...errors,408: problemResult(408),413: problemResult(413),429: problemResult(429) },
    }, async ({ request,body }) => {
      try {
        const admission = await own(request,body.actingSubject,true,intakePrincipals.get(request)); if (admission instanceof Response) return admission;
        if (new TextEncoder().encode(body.file).length > FILE_IMPORT_COST.bytes) throw new FileImportInvalid('File exceeds 2 MiB');
        if (body.format === 'generic-csv' && !body.mapping) return Response.json(inspectGenericCsv(body.file),{ headers });
        const rows = parseLibraryFile(body.format,body.file,body.mapping);
        const value = await deps.libraryFiles!.create(body.actingSubject,admission.key,importDigest([body.format,body.file,body.mapping ?? null]),body.format,rows);
        return Response.json(value,{ status: 201,headers });
      } catch (error) { return failure(error); }
    })
    .get(`${base}/:id/rows`, { params: t.Object({ id: readUuid }),
      query: t.Object({ actingSubject: readId,cursor: t.Optional(t.Integer({ minimum: -1,maximum: 4999 })) },closed),
      response: { 200: t.Object({ rows: t.Array(rowView,{ maxItems: FILE_IMPORT_COST.page }),nextCursor: t.Nullable(t.Integer()) }),...errors },
    }, async ({ request,params,query }) => {
      try {
        const admission = await own(request,query.actingSubject); if (admission instanceof Response) return admission;
        const page = await deps.libraryFiles!.page(query.actingSubject,params.id,query.cursor ?? -1);
        for (const row of page.rows) if (!row.match) {
          const matched = row.resolution?.choice === 'private'
            ? { kind: 'not-found' as const,work: null,target: null,candidates: [],truncated: false,
              openLibrary: [],openLibraryAvailability: 'not-requested' as const }
            : row.resolution?.work ? { kind: 'matched' as const,work: row.resolution.work,target: row.resolution.target ?? null,
              candidates: [],truncated: false,openLibrary: [],openLibraryAvailability: 'not-requested' as const }
              : await matchLibraryRow(deps.libraryImport!,request,query.actingSubject,row.source, search => searchLibrarySource(deps,request,search));
          // Read consent permits candidate discovery, but only write consent may
          // retain a match and advance the uploaded row's version.
          if (admission.principal.accountScopes?.includes('library:write')) {
            const current = await own(request,query.actingSubject,true);
            if (current instanceof Response) return current;
            await deps.libraryFiles!.saveMatch(query.actingSubject,params.id,row.index,matched);
          }
          row.match = matched;
        }
        const saved = await deps.libraryFiles!.page(query.actingSubject,params.id,query.cursor ?? -1);
        const stillOwn = await own(request,query.actingSubject); if (stillOwn instanceof Response) return stillOwn;
        const matches = new Map(page.rows.map(row => [row.index,row.match]));
        return Response.json({ rows: saved.rows.map(row => ({ ...row,match: row.match ?? matches.get(row.index) ?? null })),
          nextCursor: saved.more ? saved.rows.at(-1)!.index : null },{ headers });
      } catch (error) { return failure(error); }
    })
    .put(`${base}/:id/rows/:row`, { params: t.Object({ id: readUuid,row: t.Integer({ minimum: 0,maximum: 4999 }) }),
      body: t.Object({ actingSubject: readId,expectedVersion: t.Integer({ minimum: 1 }),...resolution.properties },closed),
      response: { 200: t.Object({ resolved: t.Literal(true) }),...errors },
    }, async ({ request,params,body }) => {
      try {
        const admission = await own(request,body.actingSubject,true); if (admission instanceof Response) return admission;
        const { actingSubject,expectedVersion,...choice } = body;
        if (choice.choice === 'apply' && !choice.work) throw new ReaderImportInvalid('Choose a Work before applying this row');
        if (choice.work) {
          const visible = await mainCall(deps.libraryImport!,request,'GET',`/v1/works/${choice.work.slice(-36)}?actingSubject=${encodeURIComponent(actingSubject)}`);
          if (!visible.ok) throw new ReaderImportInvalid('Chosen Work is unavailable');
          if (choice.target && choice.target !== choice.work) {
            const targets = await workRead(deps,request,{ actingSubject },session => resolveTargets(session,[choice.target!],'session'));
            if (targets[0]?.work !== choice.work) throw new ReaderImportInvalid('Chosen target belongs to another Work');
          }
        }
        await deps.libraryFiles!.resolve(actingSubject,params.id,params.row,expectedVersion,choice,admission.key);
        return Response.json({ resolved: true },{ headers });
      } catch (error) { return failure(error); }
    })
    .get(`${base}/:id/apply`, { params: t.Object({ id: readUuid }),query: t.Object({ actingSubject: readId },closed),
      response: { 200: applyProgress,...errors },
    },async ({ request,params,query }) => {
      try {
        const admission=await own(request,query.actingSubject);if (admission instanceof Response) return admission;
        return Response.json(await deps.libraryFiles!.progress(query.actingSubject,params.id),{ headers });
      } catch (error) { return failure(error); }
    })
    .post(`${base}/:id/apply`, { params: t.Object({ id: readUuid }),
      body: t.Object({ actingSubject: readId,context: t.Nullable(readId),language: readLanguage,resume: t.Optional(t.Boolean()) },closed),
      response: { 200: applyProgress,202: applyProgress,...errors },
    }, async ({ request,params,body }) => {
      try {
        const admission = await own(request,body.actingSubject,true); if (admission instanceof Response) return admission;
        const intent={ context: body.context,language: body.language };
        await deps.libraryFiles!.jobs.status(body.actingSubject,params.id);
        const accepted=await deps.libraryFiles!.jobs.accept(body.actingSubject,params.id,admission.key,intent,body.resume ?? false,
          client => deps.libraryFiles!.sealOn(client,body.actingSubject,params.id,intent));
        if (accepted.token) worker!.schedule(request,body.actingSubject,params.id,intent,accepted.token);
        return Response.json(accepted.result,{ status: accepted.result.pending ? 202 : 200,headers });
      } catch (error) { return failure(error); }
    })
    .post(`${base}/:id/rows/:row/adoptions`, { params: t.Object({ id: readUuid,row: t.Integer({ minimum: 0,maximum: 4999 }) }),
      body: t.Object({ actingSubject: readId,workId: t.String({ pattern: '^OL[1-9][0-9]{0,11}W$' }),titleLanguage: t.Optional(readLanguage) },closed),
      response: { 200: t.Object({ work: readId,replayed: t.Boolean() }),202: t.Unknown(),...errors,429: problemResult(429) },
    }, async ({ request,params,body }: { request: Request; params: { id: string; row: number };
      body: { actingSubject: string; workId: string; titleLanguage?: string } }) => {
      try {
        const admission = await own(request,body.actingSubject,true); if (admission instanceof Response) return admission;
        const page = await deps.libraryFiles!.page(body.actingSubject,params.id,params.row-1,1);
        if (page.rows[0]?.index !== params.row || !page.rows[0].match?.openLibrary.some(c => c.workId === body.workId)) {
          throw new ReaderImportInvalid('Choose an Open Library candidate from this row');
        }
        return await adoptLibrarySource(deps,request,body);
      } catch (error) { return failure(error); }
    });
}
