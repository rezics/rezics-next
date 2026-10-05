import { Elysia, t } from 'elysia';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionExpired, AdmissionUnavailable }
  from '../modules/access/admission.ts';
import type { AccessDownloadLeases, DownloadReadLease } from '../modules/access/download-leases.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { activateUploadedBytes, changeAdmittedAssetState, MediaDenied, reserveAdmittedUpload,
  saveAdmittedMediaSet, changeAdmittedMediaField, recordAdmittedImageInference, createAdmittedDocumentImageUse,
  type MediaDependencies } from '../modules/media/commands.ts';
import { concealCommand, documentUseCommand, imageLabelCommand, inferenceCommand,
  mediaDescriptor, metadataRead, metadataResult } from '../modules/media/presentation-contract.ts';
import type { MetadataRef } from '../modules/media/presentation.ts';
import { DEFAULT_MEDIA_CONTEXT, MAX_UPLOAD_BYTES, MediaConflict, MediaFenced, MediaInvalid, MediaMissing, MediaStale,
  MediaUnavailable, avatarImageEligible } from '../modules/media/store.ts';
import { readResourceSummaries } from '../modules/media/summary.ts';
import { publicAgent } from '../modules/profiles/read.ts';
import { GRAPHS, RV, iri, lit } from '../modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { disclosureViewer, withDisclosureViewer } from '../modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../modules/suitability/policy.ts';

declare module './dependencies.ts' {
  interface MainWorkDependencies {
    /** Media owner; absent media routes answer 503. */
    media?: MediaDependencies;
    /** Access read lease owner for private media download streams. */
    downloadLeases?: AccessDownloadLeases;
  }
}

const nativeId = t.String({ pattern: '^https://rezics\\.com/id/[0-9a-f-]{36}$' });
const uuid = t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
const position = t.Object({ owner: t.Literal('content'), dataEpoch: t.String(), sequence: t.String() });
const clearance = t.Union([t.Literal('screening'), t.Literal('cleared'), t.Literal('held'), t.Literal('rejected')]);
const uploadResult = t.Object({ asset: uuid, upload: uuid, status: t.Union([t.Literal('activated'), t.Literal('rejected')]), reason: t.Nullable(t.String()),
  clearance, clearanceReason: t.Nullable(t.String()),
  representation: t.Nullable(uuid), revision: t.Nullable(uuid), replayed: t.Boolean() }, { additionalProperties: false });
const uploadStatus = t.Object({ upload: uuid, asset: uuid, status: t.Union([t.Literal('reserved'), t.Literal('activated'), t.Literal('rejected'), t.Literal('expired')]),
  reason: t.Nullable(t.String()), clearance, clearanceReason: t.Nullable(t.String()),
  representation: t.Nullable(uuid) }, { additionalProperties: false });
const commandResult = t.Object({ outcome: t.String(), id: t.Nullable(t.String()),
  predecessor: t.Nullable(t.String()), position, replayed: t.Boolean(), admission: t.String() });

/** Media errors first; everything else keeps the shared command mapping. */
export function mediaError(error: unknown): Response {
  if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
    return problem(403, 'authority_denied', 'Authority is not admitted');
  }
  if (error instanceof AdmissionUnavailable) {
    return problem(503, 'media_unavailable', 'Media owner is unavailable');
  }
  if (error instanceof MediaInvalid) return problem(400, 'invalid_media_request', 'Media request is invalid');
  if (error instanceof MediaDenied || error instanceof MediaFenced) return problem(403, 'authority_denied', 'Authority is not admitted');
  if (error instanceof MediaMissing) return problem(404, 'media_unavailable', 'Media is unavailable');
  if (error instanceof MediaConflict) return problem(409, 'idempotency_conflict', 'Operation key binds another intent');
  if (error instanceof MediaStale) return problem(409, 'stale_head', 'Media head or reservation changed');
  if (error instanceof MediaUnavailable || error instanceof ObjectUnavailable
    || error instanceof ObjectIntegrityError) {
    return problem(503, 'media_unavailable', 'Media owner is unavailable');
  }
  return commandError(error);
}

function idempotencyKey(request: Request): string | null {
  const key = request.headers.get('idempotency-key');
  return key && /^[A-Za-z0-9:_./-]{1,128}$/.test(key) ? key : null;
}

const unavailable = () => problem(404, 'media_unavailable', 'Media is unavailable');

export const openApiOperations = {
  '/v1/media/uploads': { post: { bearer: true, idempotencyKey: true } },
  '/v1/media/uploads/{upload}': { get: { bearer: true } },
  '/v1/media/uploads/{upload}/bytes': { put: { bearer: true } },
  '/v1/media/assets/{asset}/state': { post: { bearer: true, idempotencyKey: true } },
  '/v1/media/publications': { post: { bearer: true, idempotencyKey: true } },
  '/v1/media/assets/{asset}/bytes': { get: { bearer: true } },
  '/v1/media/metadata': { post: { bearer: false } },
  '/v1/media/representations/{representation}': { get: { bearer: false } },
  '/v1/media/representations/{representation}/bytes': { get: { bearer: false } },
  '/v1/media/representations/{representation}/labels': { post: { bearer: true,idempotencyKey:true } },
  '/v1/media/representations/{representation}/inferences': { post: { bearer: true,idempotencyKey:true } },
  '/v1/media/uses': { post: { bearer: true,idempotencyKey:true } },
  '/v1/media/uses/{use}/conceal': { post: { bearer: true,idempotencyKey:true } },
} as const;

const DOWNLOAD_CHUNK_BYTES = 64 * 1024;

function downloadBody(bytes: Uint8Array, lease: DownloadReadLease, leases: AccessDownloadLeases) {
  let offset = 0;
  let finished = false;
  const finish = async (outcome: 'delivered' | 'aborted') => {
    if (finished) return;
    finished = true;
    await leases.finish(lease.id, outcome);
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.length) {
        await finish('delivered');
        controller.close();
        return;
      }
      const end = Math.min(offset + DOWNLOAD_CHUNK_BYTES, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
    async cancel() { await finish('aborted'); },
  });
}

/** Serve one exact representation after the caller-independent disclosure checks. */
async function deliver(media: MediaDependencies, basis: { objectNamespace: string; sha256: string;
  mediaType: string }, publicTarget: boolean): Promise<Response> {
  const bytes = await media.objects(basis.objectNamespace).get(basis.sha256);
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': basis.mediaType,
    etag: `"${basis.sha256}"`, 'x-content-type-options': 'nosniff',
    // Revalidation keeps shared caches from outliving a revoked selection or disclosure.
    'cache-control': publicTarget ? 'public, no-cache' : 'private, no-store' } });
}

export function mediaRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const readerFor = async (request: Request, actingSubject: string | undefined) => {
    if (!request.headers.get('authorization')) return { canReadSemantics: work.mediaAccess
      ? (resources: readonly string[]) => work.mediaAccess!.canReadSemantics(null, null, resources, fuseki)
      : undefined };
    if (!actingSubject) throw new MediaInvalid('actingSubject is required for an authenticated read');
    let verifiedWork: ReturnType<typeof work.account.verify> | undefined;
    const workPrincipal = () => verifiedWork ??= work.account.verify(request, ['work:read']);
    return { viewer: disclosureViewer(await workPrincipal()), realmReadProof: async (realm: string) =>
      await work.access.realmReadProof?.(await workPrincipal(), actingSubject, realm) ?? null,
    canReadWorks: work.mediaAccess
      ? async (resources: readonly string[]) => work.mediaAccess!.canReadWorks(await workPrincipal(), actingSubject, resources)
      : undefined,
    canReadWork: async (resource: string) => work.access.canReadWork(await workPrincipal(), actingSubject, resource),
    canReadSemantic: async (resource: string) => !!work.access.canReadSemanticResource
      && work.access.canReadSemanticResource(await workPrincipal(), actingSubject, resource, undefined, fuseki),
    canReadSemantics: work.mediaAccess
      ? async (resources: readonly string[]) => work.mediaAccess!.canReadSemantics(
        await workPrincipal(), actingSubject, resources, fuseki) : undefined,
    canReadPrivateContext: async (context: string) => !!work.contextSelections
      && work.contextSelections.canReadPrivate(await work.account.verify(request, ['context:read']),
        actingSubject, context),
    canReadPrivateContexts: work.mediaAccess
      ? async (contexts: readonly string[]) => work.mediaAccess!.canReadPrivateContexts(
        await work.account.verify(request, ['context:read']), actingSubject, contexts) : undefined };
  };
  const metadataFor = async (request: Request,refs: readonly MetadataRef[],actingSubject?:string) => {
    if (!work.media) throw new MediaUnavailable('media owner unavailable');
    await assertGraphAdmissionOpen(fuseki,work.environment.lineage);
    const reader=await readerFor(request,actingSubject);
    const principal=request.headers.get('authorization') ? await work.account.verify(request,['work:read']) : null;
    const controlsActor=principal && actingSubject && !!(await work.access.canManageMedia?.(principal,actingSubject)
      || await work.access.canReadAsBaselineMember?.(principal,actingSubject));
    const administrator=!!(principal&&actingSubject&&(work.access.canActAsPlatformAdministrator
      ? await work.access.canActAsPlatformAdministrator(principal,actingSubject):true));
    const bases=await work.media.store.presentation.metadata(refs);
    const groups=new Map<string,Set<string>>();
    for (const basis of bases) if (basis?.target) {
      const targets=groups.get(basis.context)??new Set<string>();targets.add(basis.target);groups.set(basis.context,targets);
    }
    const available=new Set<string>();
    for (const [context,targets] of groups) {
      const summaries=await readResourceSummaries(work.environment,undefined,reader,
        {resources:[...targets],context,language:null,channel:'media'});
      for (const summary of summaries.summaries) if (summary.status==='available') available.add(`${context}\0${summary.reference}`);
    }
    // Public profile avatar targets are Agents rather than Work/semantic resources.
    const agentTargets=[...groups.get(DEFAULT_MEDIA_CONTEXT)??[]].filter(target=>!available.has(`${DEFAULT_MEDIA_CONTEXT}\0${target}`));
    if (agentTargets.length) {
      const agents=(await fuseki.query(`PREFIX rv: <${RV}>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?agent WHERE {
        VALUES ?agent { ${agentTargets.map(iri).join(' ')} } ${publicAgent('?agent')} } LIMIT 65`,64*1024)).results?.bindings??[];
      for (const agent of agents) if (agent.agent) available.add(`${DEFAULT_MEDIA_CONTEXT}\0${agent.agent.value}`);
    }
    return Promise.all(bases.map(async basis=>{
      if (!basis || basis.target && !available.has(`${basis.context}\0${basis.target}`)
        || basis.disclosure!=='public' && !(controlsActor && basis.owner===actingSubject)) return null;
      const canProtectLabels=!!(administrator && principal && actingSubject && await work.access.canProtectMedia?.(principal,actingSubject,
        `https://rezics.com/id/${basis.metadata.representation}`));
      const canProtectConceal=!!(administrator && principal && actingSubject && basis.metadata.use
        && await work.access.canProtectMedia?.(principal,actingSubject,`https://rezics.com/id/${basis.metadata.use}`,'media.conceal.protect'));
      const labelControls={canEdit:!!(canProtectLabels || controlsActor && basis.owner===actingSubject),canProtect:canProtectLabels};
      const concealControls={canEdit:!!(canProtectConceal || controlsActor && basis.actor===actingSubject),canProtect:canProtectConceal};
      const nsfw={...basis.metadata.controls.nsfw,...labelControls,
        canEdit:labelControls.canEdit&&(!basis.metadata.controls.nsfw.locked||canProtectLabels)};
      const ageRating={...basis.metadata.controls.ageRating,...labelControls,
        canEdit:labelControls.canEdit&&(!basis.metadata.controls.ageRating.locked||canProtectLabels)};
      const conceal=basis.metadata.controls.conceal?{...basis.metadata.controls.conceal,...concealControls,
        canEdit:concealControls.canEdit&&(!basis.metadata.controls.conceal.locked||canProtectConceal)}:null;
      return {...basis,metadata:{...basis.metadata,
        controls:{nsfw,ageRating,conceal},
        canEdit:nsfw.canEdit||ageRating.canEdit||!!conceal?.canEdit,canProtect:canProtectLabels||canProtectConceal}};
    }));
  };
  const fieldResult=t.Object({revision:t.Nullable(nativeId),position,replayed:t.Boolean(),admission:t.String()});
  const fieldResponses={200:fieldResult,201:fieldResult,...writeProblems,404:problemResult(404)};
  return new Elysia()
    .post('/v1/media/metadata',{body:metadataRead,detail:{security:[{}, {bearerAuth:[]}]},response:{200:metadataResult,...authorizedReadProblems}},
      async ({request,body})=>{
        try {
          const items=await metadataFor(request,body.items,body.actingSubject);
          return Response.json({items:items.map((basis,index)=>basis ? {status:'available',...basis.metadata}
            : {status:'unavailable',reference:body.items[index]})},{headers:{'cache-control':'private, no-store'}});
        } catch(error) {return mediaError(error);}
      })
    .get('/v1/media/representations/:representation',{params:t.Object({representation:uuid}),
      query:t.Object({actingSubject:t.Optional(nativeId),use:t.Optional(uuid)},{additionalProperties:false}),
      response:{200:mediaDescriptor,...authorizedReadProblems}},async ({request,params,query})=>{
      try {
        const basis=(await metadataFor(request,[{representation:params.representation,...(query.use?{use:query.use}:{})}],query.actingSubject))[0];
        return basis ? Response.json(basis.metadata,{headers:{'cache-control':'private, no-store'}}) : unavailable();
      } catch(error) {return mediaError(error);}
    })
    .get('/v1/media/representations/:representation/bytes',{params:t.Object({representation:uuid}),
      query:t.Object({actingSubject:t.Optional(nativeId),use:t.Optional(uuid)},{additionalProperties:false}),
      response:{200:t.Any(),...authorizedReadProblems}},async ({request,params,query}: {request:Request;
        params:{representation:string};query:{actingSubject?:string;use?:string}})=>{
      let lease: DownloadReadLease|undefined;
      try {
        const basis=(await metadataFor(request,[{representation:params.representation,...(query.use?{use:query.use}:{})}],query.actingSubject))[0];
        if (!basis || !work.media) return unavailable();
        if (basis.disclosure==='public') return deliver(work.media,{objectNamespace:basis.objectNamespace,
          sha256:basis.metadata.sha256,mediaType:basis.metadata.mediaType},true);
        if (!work.downloadLeases || !basis.target || !query.actingSubject) return unavailable();
        const principal=await work.account.verify(request,['work:read']);
        lease=await work.downloadLeases.admit(principal,query.actingSubject,basis.target,basis.metadata.asset);
        await work.downloadLeases.begin(lease,principal);
        const bytes=await work.media.objects(basis.objectNamespace).get(basis.metadata.sha256);
        if (bytes.byteLength!==basis.byteLength) throw new ObjectIntegrityError('media byte length differs');
        return new Response(downloadBody(bytes,lease,work.downloadLeases),{headers:{'content-type':basis.metadata.mediaType,
          'content-length':String(basis.byteLength),'x-content-type-options':'nosniff','cache-control':'private, no-store'}});
      } catch(error) {
        if (lease) await work.downloadLeases?.finish(lease.id,'aborted').catch(()=>undefined);
        return mediaError(error);
      }
    })
    .post('/v1/media/representations/:representation/labels',{params:t.Object({representation:uuid}),body:imageLabelCommand,response:fieldResponses},
      async ({request,params,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await changeAdmittedMediaField(work.environment,work.media,work.account,work.access,request,
            {...body,representation:params.representation,authority:body.authority??'author',idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uses/:use/conceal',{params:t.Object({use:uuid}),body:concealCommand,response:fieldResponses},
      async ({request,params,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await changeAdmittedMediaField(work.environment,work.media,work.account,work.access,request,
            {...body,use:params.use,field:'conceal',authority:body.authority??'author',idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/representations/:representation/inferences',{params:t.Object({representation:uuid}),body:inferenceCommand,
      response:{200:t.Object({},{additionalProperties:true}),201:t.Object({},{additionalProperties:true}),...writeProblems,404:problemResult(404)}},
      async ({request,params,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await recordAdmittedImageInference(work.environment,work.media,work.account,work.access,request,
            {...body,representation:params.representation,idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uses',{body:documentUseCommand,response:{200:t.Object({},{additionalProperties:true}),201:t.Object({},{additionalProperties:true}),...writeProblems,404:problemResult(404)}},
      async ({request,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await createAdmittedDocumentImageUse(work.environment,work.media,work.account,work.access,request,
            {...body,context:body.context??DEFAULT_MEDIA_CONTEXT,conceal:body.conceal??false,idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uploads', {
      body: t.Object({ profile: t.Literal('media-image-upload-v1'), asset: t.Nullable(uuid),
        mediaType: t.Union([t.Literal('image/png'), t.Literal('image/jpeg'), t.Literal('image/webp'),
          t.Literal('image/gif')]),
        byteLength: t.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
        sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const { profile: _profile, ...input } = body;
        const reserved = await reserveAdmittedUpload(work.environment, work.media, work.account, work.access,
          request, { ...input, idempotencyKey: key });
        return Response.json({ ...reserved, uploadUrl: `/v1/media/uploads/${reserved.upload}/bytes` },
          { status: reserved.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/uploads/:upload', {
      params: t.Object({ upload: uuid }),
      response: { 200: uploadStatus, ...authorizedReadProblems },
    }, async ({ request, params }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:edit']);
        const principalId = await work.access.activePrincipalId(principal);
        const row = await work.media.store.readUpload(params.upload);
        if (!row || !principalId || row.principal !== principalId) return unavailable();
        return Response.json({ upload: row.id, asset: row.asset, status: row.status,
          clearance: row.clearance ?? (row.status === 'rejected' || row.status === 'expired' ? 'rejected' : 'screening'),
          reason: row.reason, clearanceReason: row.clearanceReason, representation: row.representation },
        { headers: { 'cache-control': 'private, no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .put('/v1/media/uploads/:upload/bytes', {
      params: t.Object({ upload: uuid }),
      parse: 'none',
      response: { 200: uploadResult, 201: uploadResult, ...writeProblems, 404: problemResult(404),
        413: problemResult(413), 422: uploadResult },
    }, async ({ request, params }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (declared > MAX_UPLOAD_BYTES) return problem(413, 'media_too_large', 'Upload exceeds the admitted size');
      try {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.length > MAX_UPLOAD_BYTES) return problem(413, 'media_too_large', 'Upload exceeds the admitted size');
        const result = await activateUploadedBytes(work.environment, work.media, work.account, work.access,
          request, params.upload, bytes);
        if (result.status === 'rejected' && result.representation === null) {
          return Response.json({ ...result }, { status: 422, headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/media/assets/:asset/state', {
      params: t.Object({ asset: uuid }),
      body: t.Object({ profile: t.Literal('media-asset-state-v1'), expectedState: uuid,
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        lifecycle: t.Union([t.Literal('active'), t.Literal('deleted'), t.Literal('erased')]),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: commandResult, 201: commandResult, ...writeProblems, 404: problemResult(404) },
    }, async ({ request, params, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const result = await changeAdmittedAssetState(work.environment, work.media, work.account, work.access,
          request, { asset: params.asset, expectedState: body.expectedState, disclosure: body.disclosure,
            lifecycle: body.lifecycle, actingSubject: body.actingSubject, idempotencyKey: key });
        if (result.outcome === 'stale_head') {
          return Response.json({ type: 'https://rezics.com/problems/stale_head', title: 'Asset state changed',
            status: 409, code: 'stale_head', current: result.predecessor, replayed: result.replayed },
          { status: 409, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
        }
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/media/publications', {
      body: t.Object({ profile: t.Literal('media-set-v1'), resourceId: nativeId,
        variantId: t.String({ pattern: '^urn:rezics:variant:[0-9a-f-]{36}$' }),
        expectedHead: t.Nullable(uuid), assets: t.Array(uuid, { minItems: 1, maxItems: 16 }),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) },
    }, async ({ request, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const saved = await saveAdmittedMediaSet(work.environment, work.media, work.account, work.access,
          request, { resourceId: body.resourceId, variantId: body.variantId, expectedHead: body.expectedHead,
            assets: body.assets, actingSubject: body.actingSubject, idempotencyKey: key });
        return Response.json(saved, { status: saved.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/avatars/:selection', {
      params: t.Object({ selection: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        // A public Agent avatar needs no representation selection, even when
        // the browser also sends its bearer. Other targets keep the read proof.
        const publicOnly = !!request.headers.get('authorization') && !query.actingSubject;
        const reader = publicOnly ? { viewer: ANONYMOUS_VIEWER } : await readerFor(request, query.actingSubject);
        const basis = await withDisclosureViewer(reader.viewer ?? ANONYMOUS_VIEWER,
          () => work.media!.store.avatarDelivery(params.selection));
        if (!basis || !avatarImageEligible(basis)) return unavailable();
        const agents = (await fuseki.query(`PREFIX rv: <${RV}>
          PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
          SELECT ?avatar WHERE {
            GRAPH ${iri(GRAPHS.current)} { ${iri(basis.target)} a rv:Agent }
            OPTIONAL { ${publicAgent(iri(basis.target))}
              GRAPH ${iri(GRAPHS.current)} { ${iri(basis.target)} rv:profileAvatarSelection ?avatar }
              FILTER(?avatar = ${lit(params.selection)}) }
          } LIMIT 2`, 8192)).results?.bindings ?? [];
        if (agents.length) {
          // An Agent's profile owns its avatar. A cleared or hidden profile
          // cannot regain delivery through the generic resource-summary path.
          if (basis.context !== DEFAULT_MEDIA_CONTEXT || agents.length !== 1
            || agents[0]?.avatar?.value !== params.selection) return unavailable();
          return await deliver(work.media, { objectNamespace: basis.objectNamespace,
            sha256: basis.sha256!, mediaType: basis.mediaType! }, true);
        }
        if (publicOnly) throw new MediaInvalid('actingSubject is required for an authenticated read');
        const target = (await readResourceSummaries(work.environment, undefined,
          reader, { resources: [basis.target], context: basis.context!, language: null, channel: 'media' })).summaries[0]!;
        if (target.status !== 'available') return unavailable();
        return await deliver(work.media, { objectNamespace: basis.objectNamespace,
          sha256: basis.sha256!, mediaType: basis.mediaType! }, target.disclosure === 'public');
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/uses/:use', {
      params: t.Object({ use: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId) }, { additionalProperties: false }),
      response: { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems },
    }, async ({ request, params, query }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const reader = await readerFor(request, query.actingSubject);
        const item = await withDisclosureViewer(reader.viewer ?? ANONYMOUS_VIEWER,
          () => work.media!.store.itemDelivery(params.use));
        if (!item || item.availability !== 'available' || item.disclosure !== 'public'
          || item.moderation !== 'none' || item.lifecycle !== 'active' || item.clearance !== 'cleared') return unavailable();
        const target = (await readResourceSummaries(work.environment, undefined,
          reader, { resources: [item.target], context: DEFAULT_MEDIA_CONTEXT, language: null, channel: 'media' })).summaries[0]!;
        if (target.status !== 'available') return unavailable();
        return await deliver(work.media, item, target.disclosure === 'public');
      } catch (error) { return mediaError(error); }
    })
    .get('/v1/media/assets/:asset/bytes', {
      params: t.Object({ asset: uuid }),
      query: t.Object({ target: nativeId, actingSubject: nativeId,
        context: t.Optional(t.Union([t.Literal(DEFAULT_MEDIA_CONTEXT), nativeId])) },
      { additionalProperties: false }),
      response: { 200: t.Any(), ...authorizedReadProblems },
    }, async ({ request, params, query }: { request: Request; params: { asset: string };
      query: { target: string; actingSubject: string; context?: string } }) => {
      if (!work.media || !work.downloadLeases) {
        return problem(503, 'media_unavailable', 'Media download is unavailable');
      }
      let lease: DownloadReadLease | undefined;
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const principal = await work.account.verify(request, ['work:read']);
        const reader = await readerFor(request, query.actingSubject);
        const basis = await withDisclosureViewer(reader.viewer ?? ANONYMOUS_VIEWER,
          () => work.media!.store.assetDelivery(params.asset, query.target, query.context ?? DEFAULT_MEDIA_CONTEXT));
        if (!basis || basis.availability !== 'available' || (basis.disclosure !== 'private' && basis.owner !== query.actingSubject)
          || basis.moderation !== 'none' || basis.lifecycle !== 'active'
          || !(basis.clearance === 'cleared' || (basis.clearance === 'screening' && basis.owner === query.actingSubject
            && basis.uploader === await work.access.activePrincipalId(principal)))
          || !Number.isSafeInteger(basis.byteLength) || basis.byteLength < 1
          || basis.byteLength > MAX_UPLOAD_BYTES) return unavailable();
        lease = await work.downloadLeases.admit(principal, query.actingSubject, query.target, params.asset);
        const target = (await readResourceSummaries(work.environment, undefined,
          reader, { resources: [query.target], context: DEFAULT_MEDIA_CONTEXT,
            language: null, channel: 'media' })).summaries[0]!;
        if (target.status !== 'available') {
          await work.downloadLeases.finish(lease.id, 'aborted');
          lease = undefined;
          return unavailable();
        }
        await work.downloadLeases.begin(lease, principal);
        const bytes = await work.media.objects(basis.objectNamespace).get(basis.sha256);
        if (bytes.byteLength !== basis.byteLength) throw new ObjectIntegrityError('media byte length differs');
        return new Response(downloadBody(bytes, lease, work.downloadLeases), { headers: {
          'content-type': basis.mediaType,
          etag: `"${basis.sha256}"`,
          'content-length': String(basis.byteLength),
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        } });
      } catch (error) {
        if (lease) await work.downloadLeases.finish(lease.id, 'aborted').catch(() => undefined);
        return mediaError(error);
      }
    });
}
