import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, readProblems, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { selectAdmittedAvatar } from '../modules/media/commands.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaInvalid, MediaMissing } from '../modules/media/store.ts';
import { MAX_SUMMARY_BATCH, readContentAvailability, readResourceSummaries,
  type SummaryReader } from '../modules/media/summary.ts';
import { DATASET, GRAPHS, RV, iri, lit } from '../modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { mediaError, mediaRoutes } from './media.ts';
import { problem } from './problems.ts';

const ID = 'https://rezics.com/id/';
const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const context = t.Union([t.Literal(DEFAULT_MEDIA_CONTEXT), nativeId]);
const language = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });
const SITEMAP_PAGE = 500;

const unavailable = () => problem(404, 'resource_unavailable', 'Resource is unavailable');

export const openApiOperations = {
  '/v1/resources/{resource}/avatar': { put: { bearer: true, idempotencyKey: true } },
} as const;

/** Resource summaries, previews, sitemap and avatar selection, plus the media owner routes. */
export function resourceRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const governanceReader = work.governance?.store
    ? { restrictedTitles: (heads: readonly { work: string; revision: string }[], context: string) =>
      work.governance!.store.restrictedTitles(heads, context) } : {};
  const readerFor = async (request: Request, actingSubject: string | undefined): Promise<SummaryReader> => {
    if (!request.headers.get('authorization')) return governanceReader;
    if (!actingSubject) throw new MediaInvalid('actingSubject is required for an authenticated read');
    let verifiedWork: ReturnType<typeof work.account.verify> | undefined;
    const workPrincipal = () => verifiedWork ??= work.account.verify(request, ['work:read']);
    const contextPrincipal = () => work.account.verify(request, ['context:read']);
    return { ...governanceReader, canReadWorks: work.mediaAccess
      ? async resources => work.mediaAccess!.canReadWorks(await workPrincipal(), actingSubject, resources) : undefined,
    canReadWork: async resource => work.access.canReadWork(await workPrincipal(), actingSubject, resource),
    canReadSemantic: async resource => !!work.access.canReadSemanticResource
      && work.access.canReadSemanticResource(await workPrincipal(), actingSubject, resource),
    canReadPrivateContext: async context => !!work.contextSelections
      && work.contextSelections.canReadPrivate(await contextPrincipal(), actingSubject, context) };
  };
  const summarize = async (request: Request, input: { resources: string[]; actingSubject?: string;
    context?: string; language?: string }) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    return readResourceSummaries(work.environment, work.media?.store,
      await readerFor(request, input.actingSubject), { resources: input.resources,
        context: input.context ?? DEFAULT_MEDIA_CONTEXT, language: input.language ?? null });
  };
  // Summaries and previews revalidate on every use: generation-bound, never stale-served.
  const headers = (generation: { graph: string; media: string | null }, shared: boolean) => ({
    'cache-control': shared ? 'public, no-cache' : 'private, no-store',
    etag: `"${new Bun.CryptoHasher('sha256').update(JSON.stringify(generation)).digest('hex').slice(0, 32)}"` });
  return new Elysia()
    .use(mediaRoutes(fuseki, work))
    .get('/v1/resources/:resource', {
      params: t.Object({ resource: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId), context: t.Optional(context),
        language: t.Optional(language) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const batch = await summarize(request, { resources: [`${ID}${params.resource}`], ...query });
        const summary = batch.summaries[0]!;
        if (summary.status !== 'available') return unavailable();
        const main = summary.type === 'main-version' ? summary.reference : summary.type === 'work'
          ? (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
              ${iri(summary.reference)} rv:mainVersion ?main } }`)).results?.bindings[0]?.main?.value : undefined;
        const content = main ? await readContentAvailability(work.environment, main, query.language ?? null) : null;
        return Response.json({ profile: 'resource-summary-v1', ...summary,
          ...(content ? { mainVersion: main, content } : {}), generation: batch.generation },
        { headers: headers(batch.generation, summary.disclosure === 'public' && !request.headers.get('authorization')) });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/resources/summaries', {
      body: t.Object({ profile: t.Literal('resource-summary-batch-v1'),
        resources: t.Array(nativeId, { minItems: 1, maxItems: MAX_SUMMARY_BATCH }),
        actingSubject: t.Optional(nativeId), context: t.Optional(context), language: t.Optional(language) },
      { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, body }) => {
      try {
        const { profile: _profile, ...input } = body;
        const batch = await summarize(request, input);
        return Response.json({ profile: 'resource-summary-batch-v1', complete: true,
          summaries: batch.summaries, generation: batch.generation, cost: batch.cost },
        { headers: headers(batch.generation, false) });
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/public-previews/:resource', {
      params: t.Object({ resource: uuid }),
      query: t.Object({ language: t.Optional(language) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...readProblems },
    }, async ({ params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        // Anonymous: only public resources resolve; private and absent share one answer.
        const batch = await readResourceSummaries(work.environment, work.media?.store, governanceReader,
          { resources: [`${ID}${params.resource}`], context: DEFAULT_MEDIA_CONTEXT,
            language: query.language ?? null });
        const summary = batch.summaries[0]!;
        if (summary.status !== 'available' || summary.disclosure !== 'public') return unavailable();
        return Response.json({ profile: 'public-preview-v1', ...summary, generation: batch.generation },
          { headers: headers(batch.generation, true) });
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/sitemap', {
      query: t.Object({ after: t.Optional(nativeId) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...readProblems },
    }, async ({ query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        // Public Works only: the current Main selection names a public publication decision.
        const result = await fuseki.query(`PREFIX rv: <${RV}> PREFIX schema: <https://schema.org/>
          SELECT ?sequence ?work WHERE {
            GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(work.environment.lineage.dataEpoch)} ;
              rv:sequence ?sequence . }
            OPTIONAL {
              { SELECT ?work WHERE {
                GRAPH ${iri(GRAPHS.current)} { ?work a schema:CreativeWork ; rv:mainVersion ?main .
                  ?main rv:selectionHead ?selection . }
                GRAPH ${iri(GRAPHS.revisions)} { ?selection rv:publicationDecision ?decision .
                  ?decision rv:disclosure rv:Public . }
                ${query.after ? `FILTER(STR(?work) > ${lit(query.after)})` : ''}
              } ORDER BY ?work LIMIT ${SITEMAP_PAGE + 1} }
            }
          }`);
        const rows = result.results?.bindings ?? [];
        if (!rows[0]?.sequence) return problem(503, 'graph_unavailable', 'Graph lineage is unavailable');
        const works = rows.map(row => row.work?.value).filter((value): value is string => Boolean(value));
        const page = works.slice(0, SITEMAP_PAGE);
        return Response.json({ profile: 'public-sitemap-v1',
          entries: page.map(reference => ({ reference, preview: `/v1/public-previews/${reference.slice(ID.length)}` })),
          next: works.length > SITEMAP_PAGE ? page.at(-1) : null,
          generation: rows[0].sequence.value }, { headers: { 'cache-control': 'public, no-cache' } });
      } catch (error) { return mediaError(error); }
    })
    .put('/v1/resources/:resource/avatar', {
      params: t.Object({ resource: uuid }),
      body: t.Object({ profile: t.Literal('resource-avatar-selection-v1'), context: t.Optional(context),
        expectedSelection: t.Nullable(uuid), asset: t.Nullable(uuid),
        crop: t.Optional(t.Nullable(t.String({ maxLength: 64 }))), actingSubject: nativeId },
      { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = request.headers.get('idempotency-key');
      if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key)) {
        return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      }
      try {
        const target = `${ID}${params.resource}`;
        // The actor must be able to read the target before Access admits the change.
        const current = await summarize(request, { resources: [target], actingSubject: body.actingSubject });
        if (current.summaries[0]?.status !== 'available') throw new MediaMissing('resource is unavailable');
        const result = await selectAdmittedAvatar(work.environment, work.media, work.account, work.access,
          request, { target, context: body.context ?? DEFAULT_MEDIA_CONTEXT,
            expectedSelection: body.expectedSelection, asset: body.asset, crop: body.crop ?? null,
            actingSubject: body.actingSubject, idempotencyKey: key });
        if (result.outcome === 'stale_head') {
          return Response.json({ type: 'https://rezics.com/problems/stale_head', title: 'Avatar selection changed',
            status: 409, code: 'stale_head', current: result.predecessor, replayed: result.replayed },
          { status: 409, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
        }
        return Response.json({ target, selection: result.id, predecessor: result.predecessor,
          position: result.position, replayed: result.replayed },
        { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    });
}
