import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, readProblems, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { selectAdmittedAvatar, selectAdmittedShowcase } from '../modules/media/commands.ts';
import { showcaseBatchCommand, showcaseBatchResult, showcaseSelectionCommand, showcaseSelectionResult,
  showcaseTrailerCommand, type ShowcaseSelectionInput, type ShowcaseTrailerInput } from '../modules/media/showcase-contract.ts';
import { publicAgent } from '../modules/profiles/read.ts';
import { DEFAULT_MEDIA_CONTEXT, MediaInvalid, MediaMissing } from '../modules/media/store.ts';
import { MAX_SUMMARY_BATCH, readContentAvailability, readResourceSummaries,
  MAX_SUMMARY_REFERENCE_LENGTH, SUMMARY_REFERENCE_PATTERN, type SummaryReader } from '../modules/media/summary.ts';
import { GRAPHS, RV, iri } from '../modules/work/activate.ts';
import { readSitemap } from '../modules/disclosure/sitemap.ts';
import { disclosureViewer, withDisclosureViewer } from '../modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../modules/suitability/policy.ts';
import { discloseInventory, hasDisclosure, type DisclosureTarget } from '../modules/disclosure/read.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { mediaError, mediaRoutes } from './media.ts';
import { resourceSummaryBatch } from '../modules/media/summary-contract.ts';
import { readerLanguages } from '../modules/display-language/select.ts';
import { problem } from './problems.ts';
import { readingPositionQuery } from './reading-positions.ts';
import { boundedReadingPositionRead } from '../modules/reading-position/read.ts';
import type { VerifiedPrincipal } from '../modules/access/admission.ts';
import { WorkReadInvalid, WorkReadMissing, WorkReadMoved, WorkReadUnavailable } from '../modules/work/read-session.ts';
import { workReadError } from './work-reads.ts';

const ID = 'https://rezics.com/id/';
const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const context = t.Union([t.Literal(DEFAULT_MEDIA_CONTEXT), nativeId]);
const language = t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 });

const unavailable = () => problem(404, 'resource_unavailable', 'Resource is unavailable');

export const openApiOperations = {
  '/v1/resources/{resource}/avatar': { put: { bearer: true, idempotencyKey: true } },
  '/v1/resources/{resource}/showcase/art': { put: { bearer: true, idempotencyKey: true } },
  '/v1/resources/{resource}/showcase/trailer': { put: { bearer: true, idempotencyKey: true } },
  '/v1/resources/showcase': { post: { bearer: false } },
} as const;

/** Resource summaries, previews, sitemap and avatar selection, plus the media owner routes. */
export function resourceRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const anonymousReader: SummaryReader = {
    canReadSemantics: work.mediaAccess
      ? resources => work.mediaAccess!.canReadSemantics(null, null, resources, fuseki)
      : undefined };
  const readerFor = async (request: Request, actingSubject: string | undefined, batch = true): Promise<{ reader: SummaryReader; principal: VerifiedPrincipal | null }> => {
    if (!request.headers.get('authorization')) return { reader: anonymousReader,principal: null };
    if (!actingSubject) throw new MediaInvalid('actingSubject is required for an authenticated read');
    let verifiedWork: ReturnType<typeof work.account.verify> | undefined;
    const workPrincipal = () => verifiedWork ??= work.account.verify(request, ['work:read']);
    const contextPrincipal = () => work.account.verify(request, ['context:read']);
    const principal = await workPrincipal();
    return { principal,reader: { viewer: disclosureViewer(principal), canReadWorks: batch && work.mediaAccess
      ? async resources => work.mediaAccess!.canReadWorks(await workPrincipal(), actingSubject, resources) : undefined,
    canReadWork: async resource => work.access.canReadWork(await workPrincipal(), actingSubject, resource),
    canReadSemantic: async resource => !!work.access.canReadSemanticResource
      && work.access.canReadSemanticResource(await workPrincipal(), actingSubject, resource, undefined, fuseki),
    realmReadProof: async realm => work.access.realmReadProof?.(await workPrincipal(), actingSubject, realm) ?? null,
    canReadSemantics: work.mediaAccess
      ? async resources => work.mediaAccess!.canReadSemantics(await workPrincipal(), actingSubject, resources, fuseki)
      : undefined,
    canReadPrivateContext: async context => !!work.contextSelections
      && work.contextSelections.canReadPrivate(await contextPrincipal(), actingSubject, context),
    canReadPrivateContexts: work.mediaAccess
      ? async contexts => work.mediaAccess!.canReadPrivateContexts(await contextPrincipal(), actingSubject, contexts)
      : undefined } };
  };
  const summarize = async (request: Request, input: { resources: string[]; actingSubject?: string;
    context?: string; language?: string; position?: string }, batch = true, includeMedia = true) => {
    await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
    const { reader,principal } = await readerFor(request, input.actingSubject, batch);
    const url = new URL(request.url);
    if (input.position !== undefined) url.searchParams.set('position',input.position);
    const selected = new Request(url,{ headers: request.headers,signal: request.signal });
    return boundedReadingPositionRead(work,selected,principal,input.actingSubject,boundary =>
      readResourceSummaries(work.environment, includeMedia ? work.media?.store : undefined,
      { ...reader,visibleRecords: records => boundary.visible(records) }, { resources: input.resources,
        context: input.context ?? DEFAULT_MEDIA_CONTEXT, language: input.language ?? null,
        languages: readerLanguages([input.language, request.headers.get('x-rezics-display-languages')]
          .filter(Boolean).join(',') || null, request.headers.get('accept-language')) }));
  };
  const summaryError = (error: unknown) => error instanceof WorkReadInvalid || error instanceof WorkReadMissing
    || error instanceof WorkReadMoved || error instanceof WorkReadUnavailable ? workReadError(error) : mediaError(error);
  // Summaries and previews revalidate on every use: generation-bound, never stale-served.
  const headers = (generation: { graph: string; media: string | null }, shared: boolean) => ({
    'cache-control': shared ? 'public, no-cache' : 'private, no-store',
    etag: `"${new Bun.CryptoHasher('sha256').update(JSON.stringify(generation)).digest('hex').slice(0, 32)}"` });
  const showcaseWrite = async (request: Request,
    input: (ShowcaseSelectionInput | ShowcaseTrailerInput) & { actingSubject: string }) => {
    if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
    const key = request.headers.get('idempotency-key');
    if (!key || !/^[A-Za-z0-9:_./-]{1,128}$/.test(key))
      return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
    try {
      // The same target read proof as avatar writes, before independent Access admission.
      const current = await summarize(request,{ resources:[input.target],actingSubject:input.actingSubject },false,false);
      const target = current.summaries[0];
      if (target?.status !== 'available' || target.type !== 'work') return unavailable();
      const result = await selectAdmittedShowcase(work.environment,work.media,work.account,work.access,request,
        { ...input,idempotencyKey:key });
      if (result.outcome === 'stale_head') return Response.json({ type:'https://rezics.com/problems/stale_head',
        title:'Showcase selection changed',status:409,code:'stale_head',current:result.predecessor,replayed:result.replayed },
      { status:409,headers:{ 'content-type':'application/problem+json','cache-control':'no-store' } });
      return Response.json({ target:input.target,selection:result.id,predecessor:result.predecessor,
        position:result.position,replayed:result.replayed },{ status:result.replayed?200:201,headers:{ 'cache-control':'no-store' } });
    } catch (error) { return summaryError(error); }
  };
  return new Elysia()
    .use(mediaRoutes(fuseki, work))
    .put('/v1/resources/:resource/showcase/art',{ params:t.Object({ resource:uuid }),body:showcaseSelectionCommand,
      response:{ 200:showcaseSelectionResult,201:showcaseSelectionResult,...writeProblems,404:problemResult(404),422:problemResult(422) } },
    ({request,params,body}) => {
      const { profile:_profile,...input } = body;
      return showcaseWrite(request,{ ...input,target:`${ID}${params.resource}`,context:input.context??DEFAULT_MEDIA_CONTEXT,
        crop:input.crop??null,focalArea:input.focalArea??null });
    })
    .put('/v1/resources/:resource/showcase/trailer',{ params:t.Object({ resource:uuid }),body:showcaseTrailerCommand,
      response:{ 200:showcaseSelectionResult,201:showcaseSelectionResult,...writeProblems,404:problemResult(404),422:problemResult(422) } },
    ({request,params,body}) => {
      const { profile:_profile,...input } = body;
      return showcaseWrite(request,{ ...input,target:`${ID}${params.resource}`,context:input.context??DEFAULT_MEDIA_CONTEXT });
    })
    .post('/v1/resources/showcase',{ body:showcaseBatchCommand,response:{ 200:showcaseBatchResult,...authorizedReadProblems } },
    async ({request,body}) => {
      if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
      try {
        const context = body.context??DEFAULT_MEDIA_CONTEXT;
        const summaries = await summarize(request,{ resources:body.targets,context,actingSubject:body.actingSubject },true,false);
        const targets = summaries.summaries.filter(item => item.status === 'available' && item.type === 'work')
          .map(item => item.reference);
        const principal = request.headers.get('authorization') ? await work.account.verify(request,['work:read']) : null;
        const batch = await withDisclosureViewer(principal ? disclosureViewer(principal) : ANONYMOUS_VIEWER,
          () => work.media!.store.showcase.readBatch(targets,context));
        const facts: DisclosureTarget[] = [];
        const indexes = new Map<string, number[]>();
        for (const item of batch.art.values()) {
          for (const image of item.images) {
            indexes.set(image.use,[facts.length,facts.length+1]);
            facts.push({ owner:'media',resource:`${ID}${image.asset}`,component:'cover',context:image.context,work:item.reference },
              { owner:'media',resource:`${ID}${image.use}`,component:'media_use',context:image.context,work:item.reference });
          }
          if (item.trailer) {
            indexes.set(item.trailer.selection,[facts.length]);
            facts.push({ owner:'media',resource:item.reference,component:'media_use',context:item.trailer.context,work:item.reference });
          }
        }
        const decisions = await discloseInventory(work.environment,facts,
          principal ? disclosureViewer(principal) : ANONYMOUS_VIEWER,'media');
        for (const item of batch.art.values()) {
          item.images = item.images.filter(image => indexes.get(image.use)!.every(index => decisions[index]==='visible'));
          if (item.trailer && !indexes.get(item.trailer.selection)!.every(index => decisions[index]==='visible')) item.trailer=null;
        }
        const governed = hasDisclosure(work.environment) && facts.length>0;
        return Response.json({ profile:'work-showcase-batch-v1',complete:true,
          items:body.targets.map(reference => batch.art.get(reference)??{ reference,status:'unavailable' }),
          generation:{ ...summaries.generation,media:batch.generation },
          cost:{ ...summaries.cost,mediaQueries:summaries.cost.mediaQueries+1,
            graphQueries:summaries.cost.graphQueries+(governed?1:0),
            disclosureQueries:governed?Math.ceil(facts.length/64):0 } },{ headers:{ 'cache-control':'private, no-store' } });
      } catch (error) { return summaryError(error); }
    })
    .get('/v1/resources/:resource', {
      params: t.Object({ resource: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId), context: t.Optional(context),
        language: t.Optional(language),position: readingPositionQuery }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      try {
        const batch = await summarize(request, { resources: [`${ID}${params.resource}`], ...query });
        const summary = batch.summaries[0]!;
        if (summary.status !== 'available') return unavailable();
        if (summary.resolution) return Response.json({ profile: 'resource-summary-v1', ...summary,
          status: 'merged', generation: batch.generation }, { headers: { 'cache-control': 'no-store' } });
        const main = summary.type === 'main-version' ? summary.reference : summary.type === 'work'
          ? (await fuseki.query(`PREFIX rv: <${RV}> SELECT ?main WHERE { GRAPH ${iri(GRAPHS.current)} {
              ${iri(summary.reference)} rv:mainVersion ?main } }`)).results?.bindings[0]?.main?.value : undefined;
        const content = main ? await readContentAvailability(work.environment, main, query.language ?? null) : null;
        return Response.json({ profile: 'resource-summary-v1', ...summary,
          ...(content ? { mainVersion: main, content } : {}), generation: batch.generation },
        { headers: headers(batch.generation, summary.disclosure === 'public' && !request.headers.get('authorization')) });
      } catch (error) { return summaryError(error); }
    })
    .post('/v1/resources/summaries', {
      body: t.Object({ profile: t.Literal('resource-summary-batch-v1'),
        resources: t.Array(t.String({ pattern: SUMMARY_REFERENCE_PATTERN, maxLength: MAX_SUMMARY_REFERENCE_LENGTH }),
          { minItems: 1, maxItems: MAX_SUMMARY_BATCH }),
        actingSubject: t.Optional(nativeId), context: t.Optional(context), language: t.Optional(language),position: readingPositionQuery },
      { additionalProperties: false }),
      response: { 200: resourceSummaryBatch, ...authorizedReadProblems },
    }, async ({ request, body }) => {
      try {
        const { profile: _profile, ...input } = body;
        const batch = await summarize(request, input);
        return Response.json({ profile: 'resource-summary-batch-v1', complete: true,
          summaries: batch.summaries, generation: batch.generation, cost: batch.cost },
        { headers: headers(batch.generation, false) });
      } catch (error) { return summaryError(error); }
    })
    .get('/v1/public-previews/:resource', {
      params: t.Object({ resource: uuid }),
      query: t.Object({ language: t.Optional(language) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...readProblems },
    }, async ({ request, params, query }) => {
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        // Anonymous: only public resources resolve; private and absent share one answer.
        const batch = await readResourceSummaries(work.environment, work.media?.store, anonymousReader,
          { resources: [`${ID}${params.resource}`], context: DEFAULT_MEDIA_CONTEXT, channel: 'preview',
            language: query.language ?? null,
            languages: readerLanguages([query.language, request.headers.get('x-rezics-display-languages')]
              .filter(Boolean).join(',') || null, request.headers.get('accept-language')) });
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
        return Response.json(await readSitemap(work.environment, query.after),
          { headers: { 'cache-control': 'public, no-cache' } });
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
        // One target: use the full Access read proof, including sealed creator
        // authority, before admitting the independent avatar write.
        const current = await summarize(request, { resources: [target], actingSubject: body.actingSubject }, false);
        if (current.summaries[0]?.status !== 'available') {
          const agent = (await fuseki.query(`PREFIX rv: <${RV}>
            PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
            SELECT ?agentHead WHERE {
            ${publicAgent(iri(target))} } LIMIT 2`, 8192)).results?.bindings ?? [];
          if (agent.length !== 1 || !agent[0]?.agentHead) throw new MediaMissing('resource is unavailable');
        }
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
