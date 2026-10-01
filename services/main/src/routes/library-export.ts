import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { canonicalRow } from '../modules/library-import/formats/contract.ts';
import { LIBRARY_EXPORT_COST } from '../modules/library-export/bundle.ts';
import { readId } from '../modules/work/read-contract.ts';
import { workRead } from '../modules/work/read-session.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { problem } from './problems.ts';
import { workReadError } from './work-reads.ts';

export const openApiOperations = { '/v1/me/library-export': { get: { bearer: true } } } as const;
export const capabilities = { '/v1/me/library-export': { get: { disposition: 'supported', mcp: {
  tool: 'library_export',title: 'Export your complete library',
  description: 'Download a private rezics-library-export-v1 bundle in resumable pages. Keep snapshot with nextCursor; a changed library requires a new export. Import pages individually or join their rows into one bundle.' } } } } as const;
export function libraryExportRoutes(deps: MainWorkDependencies) {
  return new Elysia().get('/v1/me/library-export', {
    query: t.Object({ actingSubject: readId,limit: t.Optional(t.Integer({ minimum: 1,maximum: LIBRARY_EXPORT_COST.page })),
      cursor: t.Optional(t.String({ maxLength: 2048 })),snapshot: t.Optional(t.String({ maxLength: 2048 })) },{ additionalProperties: false }),
    response: { 200: t.Object({ profile: t.Literal('rezics-library-export-v1'),rows: t.Array(canonicalRow,{ maxItems: LIBRARY_EXPORT_COST.page }),
      snapshot: t.String(),nextCursor: t.Nullable(t.String()) }),
      ...Object.fromEntries([400,401,403,409,503].map(code => [code,problemResult(code)])) },
  },async ({ request,query }) => {
    if (!deps.libraryBundle) return problem(503,'library_export_unavailable','Library export is unavailable');
    try {
      const principal = await deps.account.verify(request,['work:read']);
      if (!await deps.access.canReadAsBaselineMember?.(principal,query.actingSubject)) return problem(403,'library_export_denied','Your library export is private to your own Person');
      const result = await workRead(deps,request,{ actingSubject: query.actingSubject },
        session => deps.libraryBundle!.page(session,query.actingSubject,query));
      return Response.json(result,{ headers: { 'cache-control': 'private, no-store' } });
    } catch (error) { return workReadError(error); }
  });
}
