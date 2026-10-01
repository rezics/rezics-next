import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { readId, readLanguage, readUuid } from '../modules/work/read-contract.ts';
import { canonicalRow, csvMapping, FILE_IMPORT_COST, FileImportInvalid, FileImportUnsupported } from '../modules/library-import/formats/contract.ts';
import { parseLibraryFile } from '../modules/library-import/formats/index.ts';
import { inspectGenericCsv } from '../modules/library-import/formats/generic-csv.ts';
import { importDigest, LibraryFileMissing } from '../modules/library-import/file-store.ts';
import { mainCall, matchLibraryRow } from '../modules/library-import/match.ts';
import { applyLibraryFile } from '../modules/library-import/apply.ts';
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
export const openApiOperations = {
  '/v1/me/library-imports': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}': { delete: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows': { get: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows/{row}': { put: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/apply': { post: { bearer: true, idempotencyKey: true } },
  '/v1/me/library-imports/{id}/rows/{row}/adoptions': { post: { bearer: true, idempotencyKey: true } },
} as const;
export const capabilities = {
  '/v1/me/library-imports/{id}': { delete: { disposition: 'supported', mcp: { tool: 'library_import_delete', title: 'Delete an uploaded library file',
    scopes: ['work:read'], description: 'Delete your uploaded source rows and import plans. Applied Library records remain. Uploads otherwise expire seven days after creation.' } } },
  '/v1/me/library-imports': { post: { disposition: 'supported', mcp: { tool: 'library_import_create', title: 'Import a library file',
    scopes: ['work:read'],
    description: 'Upload your own library export or mapped CSV. Source rows stay private; catalogue matches are reviewed before applying. A CSV without mapping returns headers without storing the file.' } } },
  '/v1/me/library-imports/{id}/rows': { get: { disposition: 'supported', mcp: { tool: 'library_import_rows', title: 'Review library import rows',
    scopes: ['work:read'],
    description: 'Page through every source row and its catalogue or Open Library candidates, retaining unsupported source fields.' } } },
  '/v1/me/library-imports/{id}/rows/{row}': { put: { disposition: 'supported', mcp: { tool: 'library_import_resolve', title: 'Resolve a library import row',
    scopes: ['work:read'],
    description: 'Choose a native Work and optional exact target, or keep the row private. expectedVersion protects concurrent review.' } } },
  '/v1/me/library-imports/{id}/apply': { post: { disposition: 'supported', mcp: { tool: 'library_import_apply', title: 'Apply a reviewed library import',
    scopes: ['work:read','collection:edit','rating:read','rating:submit'],
    description: 'Apply a bounded group of reviewed rows through ordinary library commands. Repeat until pending is false; retries resume one effect.' } } },
  '/v1/me/library-imports/{id}/rows/{row}/adoptions': { post: { disposition: 'supported', mcp: { tool: 'library_import_adopt', title: 'Adopt an Open Library candidate',
    scopes: ['work:read','work:create'],
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
function failure(error: unknown): Response {
  if (error instanceof LibraryFileMissing) return problem(404,'library_import_missing',error.message);
  if (error instanceof FileImportInvalid || error instanceof ReaderImportInvalid || error instanceof TargetNotBound) return problem(400,'invalid_library_file',error.message);
  if (error instanceof FileImportUnsupported) return problem(422,'library_format_unavailable',error.message);
  if (error instanceof ReaderImportConflict) return problem(409,'library_import_conflict',error.message);
  if (error instanceof ReaderImportUnavailable) return problem(503,'library_import_unavailable',error.message);
  return workReadError(error);
}
export function libraryImportsRoutes(deps: MainWorkDependencies) {
  async function own(request: Request, agent: string) {
    const key = request.headers.get('idempotency-key') ?? '';
    if (!/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) throw new ReaderImportInvalid('A valid Idempotency-Key is required');
    const principal = await deps.account.verify(request,['work:read']);
    if (!await deps.access.canReadAsBaselineMember?.(principal,agent)) return problem(403,'library_import_denied','Import files are private to your own Person');
    if (!deps.libraryFiles || !deps.libraryImport) throw new ReaderImportUnavailable('Library import is unavailable');
    return key;
  }
  return new Elysia()
    .delete(`${base}/:id`, { params: t.Object({ id: readUuid }),
      query: t.Object({ actingSubject: readId },closed),response: { 200: t.Object({ deleted: t.Literal(true) }),...errors },
    },async ({ request,params,query }) => {
      try {
        const key = await own(request,query.actingSubject); if (key instanceof Response) return key;
        await deps.libraryFiles!.delete(query.actingSubject,params.id,key);
        return Response.json({ deleted: true },{ headers });
      } catch (error) { return failure(error); }
    })
    .post(base, { body: t.Object({ actingSubject: readId,
      format: t.Union([t.Literal('goodreads'),t.Literal('storygraph'),t.Literal('generic-csv'),t.Literal('vndb'),t.Literal('mal'),t.Literal('rezics')]),
      file: t.String({ maxLength: FILE_IMPORT_COST.bytes }),mapping: t.Optional(csvMapping) },closed),
      response: { 201: t.Object({ id: readUuid,total: t.Integer({ minimum: 1,maximum: 5000 }) }),
        200: t.Object({ headers: t.Array(t.String(),{ maxItems: 64 }),distinctValues: t.Record(t.String(),t.Array(t.String(),{ maxItems: 50 })) }),...errors },
    }, async ({ request,body }) => {
      try {
        const key = await own(request,body.actingSubject); if (key instanceof Response) return key;
        if (new TextEncoder().encode(body.file).length > FILE_IMPORT_COST.bytes) throw new FileImportInvalid('File exceeds 2 MiB');
        if (body.format === 'generic-csv' && !body.mapping) return Response.json(inspectGenericCsv(body.file),{ headers });
        const rows = parseLibraryFile(body.format,body.file,body.mapping);
        const value = await deps.libraryFiles!.create(body.actingSubject,key,importDigest([body.format,body.file,body.mapping ?? null]),body.format,rows);
        return Response.json(value,{ status: 201,headers });
      } catch (error) { return failure(error); }
    })
    .get(`${base}/:id/rows`, { params: t.Object({ id: readUuid }),
      query: t.Object({ actingSubject: readId,cursor: t.Optional(t.Integer({ minimum: -1,maximum: 4999 })) },closed),
      response: { 200: t.Object({ rows: t.Array(rowView,{ maxItems: FILE_IMPORT_COST.page }),nextCursor: t.Nullable(t.Integer()) }),...errors },
    }, async ({ request,params,query }) => {
      try {
        const key = await own(request,query.actingSubject); if (key instanceof Response) return key;
        const page = await deps.libraryFiles!.page(query.actingSubject,params.id,query.cursor ?? -1);
        for (const row of page.rows) if (!row.match) {
          const matched = row.resolution?.choice === 'private'
            ? { kind: 'not-found' as const,work: null,target: null,candidates: [],truncated: false,
              openLibrary: [],openLibraryAvailability: 'not-requested' as const }
            : row.resolution?.work ? { kind: 'matched' as const,work: row.resolution.work,target: row.resolution.target ?? null,
              candidates: [],truncated: false,openLibrary: [],openLibraryAvailability: 'not-requested' as const }
              : await matchLibraryRow(deps.libraryImport!,request,query.actingSubject,row.source);
          await deps.libraryFiles!.saveMatch(query.actingSubject,params.id,row.index,matched);
        }
        const saved = await deps.libraryFiles!.page(query.actingSubject,params.id,query.cursor ?? -1);
        const stillOwn = await own(request,query.actingSubject); if (stillOwn instanceof Response) return stillOwn;
        return Response.json({ rows: saved.rows,nextCursor: saved.more ? saved.rows.at(-1)!.index : null },{ headers });
      } catch (error) { return failure(error); }
    })
    .put(`${base}/:id/rows/:row`, { params: t.Object({ id: readUuid,row: t.Integer({ minimum: 0,maximum: 4999 }) }),
      body: t.Object({ actingSubject: readId,expectedVersion: t.Integer({ minimum: 1 }),...resolution.properties },closed),
      response: { 200: t.Object({ resolved: t.Literal(true) }),...errors },
    }, async ({ request,params,body }) => {
      try {
        const key = await own(request,body.actingSubject); if (key instanceof Response) return key;
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
        await deps.libraryFiles!.resolve(actingSubject,params.id,params.row,expectedVersion,choice,key);
        return Response.json({ resolved: true },{ headers });
      } catch (error) { return failure(error); }
    })
    .post(`${base}/:id/apply`, { params: t.Object({ id: readUuid }),
      body: t.Object({ actingSubject: readId,context: t.Nullable(readId),language: readLanguage },closed),
      response: { 200: t.Object({ total: t.Integer(),completed: t.Integer(),issues: t.Integer(),pending: t.Boolean() }),
        202: t.Object({ total: t.Integer(),completed: t.Integer(),issues: t.Integer(),pending: t.Boolean() }),...errors },
    }, async ({ request,params,body }) => {
      try {
        const key = await own(request,body.actingSubject); if (key instanceof Response) return key;
        const value = await applyLibraryFile(deps.libraryFiles!,deps.libraryImport!,request,body.actingSubject,params.id,
          { context: body.context,language: body.language });
        return Response.json(value,{ status: value.pending ? 202 : 200,headers });
      } catch (error) { return failure(error); }
    })
    .post(`${base}/:id/rows/:row/adoptions`, { params: t.Object({ id: readUuid,row: t.Integer({ minimum: 0,maximum: 4999 }) }),
      body: t.Object({ actingSubject: readId,workId: t.String({ pattern: '^OL[1-9][0-9]{0,11}W$' }),titleLanguage: t.Optional(readLanguage) },closed),
      response: { 200: t.Object({ work: readId,replayed: t.Boolean() }),202: t.Unknown(),...errors,429: problemResult(429) },
    }, async ({ request,params,body }: { request: Request; params: { id: string; row: number };
      body: { actingSubject: string; workId: string; titleLanguage?: string } }) => {
      try {
        const key = await own(request,body.actingSubject); if (key instanceof Response) return key;
        const page = await deps.libraryFiles!.page(body.actingSubject,params.id,params.row-1,1);
        if (page.rows[0]?.index !== params.row || !page.rows[0].match?.openLibrary.some(c => c.workId === body.workId)) {
          throw new ReaderImportInvalid('Choose an Open Library candidate from this row');
        }
        return mainCall(deps.libraryImport!,request,'POST','/v1/me/library-import/open-library/adoptions',body,key);
      } catch (error) { return failure(error); }
    });
}
