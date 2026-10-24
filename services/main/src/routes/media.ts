import { transportResponses } from '../transport-responses.ts';
import { Elysia, t } from 'elysia';
import { readPublicInstructionAdoptions } from '../modules/work/instruction-adoption.ts';
import { mediaContextInput } from '../modules/media/context-input.ts';
import { problemResult } from '../api-contract.ts';
import { authorizedReadProblems, selectionConflictProblem, writeProblems } from '../api-responses.ts';
import type { FusekiClient } from '../infrastructure/fuseki.ts';
import { AdmissionDenied, AdmissionExpired, AdmissionUnavailable }
  from '../modules/access/admission.ts';
import type { AccessDownloadLeases, DownloadReadLease } from '../modules/access/download-leases.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../infrastructure/immutable-objects.ts';
import { activateUploadedBytes, changeAdmittedAssetState, MediaDenied, reserveAdmittedUpload,
  saveAdmittedMediaSet, changeAdmittedMediaField, recordAdmittedImageInference, createAdmittedDocumentImageUse,
  createAdmittedCampaignArt, createAdmittedImportedArtUse,
  type MediaDependencies } from '../modules/media/commands.ts';
import { concealCommand, documentUseCommand, imageLabelCommand, inferenceCommand,
  importedCoverIntent, importedArtUseCommand, mediaDescriptor, metadataRead, metadataResult } from '../modules/media/presentation-contract.ts';
import type { MetadataBasis, MetadataRef } from '../modules/media/presentation.ts';
import { ShowcaseRefused, campaignArtCommand } from '../modules/media/showcase-contract.ts';
import { DEFAULT_MEDIA_CONTEXT, MAX_UPLOAD_BYTES, MediaConflict, MediaFenced, MediaInvalid, MediaMissing, MediaStale,
  MediaUnavailable, avatarImageEligible, MEDIA_TYPES } from '../modules/media/store.ts';
import { readResourceSummaries } from '../modules/media/summary.ts';
import { publicAgent } from '../modules/profiles/read.ts';
import { GRAPHS, RV, iri, lit } from '../modules/work/activate.ts';
import { assertGraphAdmissionOpen } from '../modules/work/restore-lineage.ts';
import type { MainWorkDependencies } from './dependencies.ts';
import { commandError, problem } from './problems.ts';
import { disclosureViewer, withDisclosureViewer } from '../modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../modules/suitability/policy.ts';
import { discloseInventory, discloseInventoryWithAnonymousNames, type DisclosureTarget } from '../modules/disclosure/read.ts';
import { bindZoneCampaignReader, currentZoneCampaignUses } from '../modules/zone/showcase-disclosure.ts';
import { bindNativeAssetAudience, mediaVisibility } from '../modules/media/visibility.ts';
import { readClosedRealmMediaSelection } from '../modules/media/closed-realm-media.ts';
import { readableReplyAttachments } from '../modules/media/reply-attachments.ts';

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
  if (error instanceof ShowcaseRefused) return problem(422, error.code, 'Showcase media does not meet the selected role');
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
  '/v1/zones/{id}/campaign-art': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/media/uploads': { post: { exposure: 'public', rateLimitFamily: 'upload', bearer: true, idempotencyKey: true } },
  '/v1/media/uploads/{upload}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/media/uploads/{upload}/bytes': { put: { exposure: 'public', rateLimitFamily: 'upload', bearer: true } },
  '/v1/media/assets/{asset}/state': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/media/publications': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true, idempotencyKey: true } },
  '/v1/media/assets/{asset}/bytes': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: true } },
  '/v1/media/metadata': { post: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/media/representations/{representation}': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/media/representations/{representation}/bytes': { get: { exposure: 'public', rateLimitFamily: 'read', bearer: false } },
  '/v1/media/representations/{representation}/labels': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true,idempotencyKey:true } },
  '/v1/media/representations/{representation}/inferences': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true,idempotencyKey:true } },
  '/v1/media/uses': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true,idempotencyKey:true } },
  '/v1/media/uses/{use}/conceal': { post: { exposure: 'public', rateLimitFamily: 'write', bearer: true,idempotencyKey:true } },
  '/v1/media/uses/{use}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
  '/v1/media/avatars/{selection}': { get: { exposure: 'public', rateLimitFamily: 'read' } },
} as const;

const DOWNLOAD_CHUNK_BYTES = 64 * 1024;
const UPLOAD_TRANSFER_MS = 30_000;

class UploadTooLarge extends Error {}
class UploadTimedOut extends Error {}

/** Cancel without waiting for an untrusted source's cancellation hook to finish. */
function cancelUploadBody(request: Request) {
  if (request.body && !request.body.locked) void request.body.cancel().catch(() => undefined);
}

/** Only called after bearer and live reservation admission. Retain at most the
 * reservation's byte budget, even when Content-Length is absent or inaccurate. */
export async function readMediaUploadBytes(request: Request, reservedBytes: number,
  transferMs = UPLOAD_TRANSFER_MS): Promise<Uint8Array> {
  const maximum = Math.min(reservedBytes, MAX_UPLOAD_BYTES);
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
    throw new MediaInvalid('invalid upload content length');
  }
  if (declared !== null && Number(declared) > maximum) throw new UploadTooLarge();
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stop: (error: Error) => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = error => {
      reject(error);
      void reader.cancel(error).catch(() => undefined);
    };
    timer = setTimeout(() => stop(new UploadTimedOut()), transferMs);
  });
  const abort = () => stop(new MediaInvalid('upload transfer aborted'));
  request.signal.addEventListener('abort', abort, { once: true });
  const deadline = performance.now() + transferMs;
  const transfer = async () => {
    if (request.signal.aborted) throw new MediaInvalid('upload transfer aborted');
    const bytes = new Uint8Array(maximum);
    let length = 0;
    for (;;) {
      if (performance.now() >= deadline) throw new UploadTimedOut();
      const { done, value } = await reader.read();
      if (performance.now() >= deadline) throw new UploadTimedOut();
      if (request.signal.aborted) throw new MediaInvalid('upload transfer aborted');
      if (done) return bytes.subarray(0, length);
      if (value.byteLength > maximum - length) throw new UploadTooLarge();
      bytes.set(value, length);
      length += value.byteLength;
    }
  };
  try {
    // Race once: attaching a deadline handler for every tiny chunk would itself
    // retain unbounded promise reactions until the deadline.
    return await Promise.race([transfer(), interrupted]);
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

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

/** RFC 9110 If-None-Match: a list compared weakly, or `*`. */
const notModified = (header: string | null, etag: string) => !!header && (header.trim() === '*'
  || header.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag));

/** Serve one exact representation after the disclosure checks. Bytes are named by their digest, so a
 * matching validator answers 304 without reading the object. Public targets share the same bytes
 * across readers, including signed-in readers; restricted targets stay in the reader's own cache. */
async function deliver(request: Request, media: MediaDependencies, basis: { objectNamespace: string; sha256: string;
  mediaType: string }, finalDisclosure: () => Promise<boolean | null>): Promise<Response> {
  const etag = `"${basis.sha256}"`;
  const unchanged = notModified(request.headers.get('if-none-match'), etag);
  const bytes = unchanged ? undefined : await media.objects(basis.objectNamespace).get(basis.sha256);
  const publicTarget = await finalDisclosure();
  if (publicTarget === null) return unavailable();
  const headers = { etag: `"${basis.sha256}"`, 'x-content-type-options': 'nosniff',
    // Revalidation keeps shared caches from outliving a revoked selection or disclosure.
    'cache-control': publicTarget ? 'public, no-cache' : 'private, no-store' };
  if (unchanged) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(bytes!), { headers: { 'content-type': basis.mediaType, ...headers } });
}

/**
 * A byte read naming no Agent can only be given public media; its bearer adds just the reader's
 * preferences (a signed-in reader's page sends one with every image). The anonymous reader decides
 * first: what it sees is the same for everyone, so it is cacheable and costs no Account introspection.
 * Only what it cannot see is decided again with the bearer, privately for that reader.
 */
async function publicFirst(request: Request, actingSubject: string | undefined,
  read: (request: Request) => Promise<Response>): Promise<Response> {
  if (actingSubject || !request.headers.get('authorization')) return read(request);
  const headers = new Headers(request.headers);
  headers.delete('authorization');
  const shared = await read(new Request(request.url, { headers }));
  return shared.status === 404 ? read(request) : shared;
}

export function mediaRoutes(fuseki: FusekiClient, work: MainWorkDependencies) {
  const readerFor = async (request: Request, actingSubject: string | undefined) => {
    const publicReader = bindZoneCampaignReader({ viewer: ANONYMOUS_VIEWER, canReadSemantics: work.mediaAccess
      ? (resources: readonly string[]) => work.mediaAccess!.canReadSemantics(null, null, resources, fuseki)
      : undefined }, request);
    if (!request.headers.get('authorization')) return publicReader;
    let verifiedWork: ReturnType<typeof work.account.verify> | undefined;
    const workPrincipal = () => verifiedWork ??= work.account.verify(request, ['work:read']);
    const viewer = disclosureViewer(await workPrincipal(), actingSubject);
    // Public image URLs do not choose an Agent. Keep the reader's live preferences
    // while leaving private Work/context authority absent until an Agent is supplied.
    if (!actingSubject) return { ...publicReader, viewer };
    return { ...publicReader, viewer, realmReadProof: async (realm: string) =>
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
  const metadataFor = async (request: Request,refs: readonly MetadataRef[],actingSubject?:string): Promise<Array<
    (MetadataBasis & { publicTarget: boolean }) | null>> => {
    if (!work.media) throw new MediaUnavailable('media owner unavailable');
    await assertGraphAdmissionOpen(fuseki,work.environment.lineage);
    const reader=await readerFor(request,actingSubject);
    const principal=request.headers.get('authorization') ? await work.account.verify(request,['work:read']) : null;
    const controlsActor=principal && actingSubject && !!(await work.access.canManageMedia?.(principal,actingSubject)
      || await work.access.canReadAsBaselineMember?.(principal,actingSubject));
    const administrator=!!(principal&&actingSubject&&(work.access.canActAsPlatformAdministrator
      ? await work.access.canActAsPlatformAdministrator(principal,actingSubject):true));
    const bases=await work.media.store.presentation.metadata(refs);
    const exactUses = bases.flatMap(basis => basis?.structureInstruction && basis.metadata.use ? [basis.metadata.use] : []);
    const grantedUses = new Set(exactUses.length ? (await readPublicInstructionAdoptions(work.environment,
      { mediaUses: exactUses }, reader.viewer ?? ANONYMOUS_VIEWER)).flatMap(item => item.mediaUse ? [item.mediaUse] : []) : []);
    const groups=new Map<string,Set<string>>();
    for (const basis of bases) if (basis?.target) {
      const targets=groups.get(basis.context)??new Set<string>();targets.add(basis.target);groups.set(basis.context,targets);
    }
    const available=new Set<string>();
    const publicTargets=new Set<string>();
    for (const [context,targets] of groups) {
      const summaries=await readResourceSummaries(work.environment,undefined,reader,
        {resources:[...targets],context,language:null,channel:'media'});
      for (const summary of summaries.summaries) if (summary.status==='available') {
        const key=`${context}\0${summary.reference}`;
        available.add(key);
        if (summary.disclosure==='public') publicTargets.add(key);
      }
      const missing = [...targets].filter(target => !available.has(`${context}\0${target}`));
      const publicReplies = await readableReplyAttachments(work.realmReplies, missing, context);
      for (const target of publicReplies) {
        const key = `${context}\0${target}`;
        available.add(key); publicTargets.add(key);
      }
      if (principal && actingSubject) {
        for (const target of await readableReplyAttachments(work.realmReplies,
          missing.filter(target => !publicReplies.has(target)), context, principal, actingSubject))
          available.add(`${context}\0${target}`);
      }
    }
    // Public profile avatar targets are Agents rather than Work/semantic resources.
    const agentTargets=[...groups.get(DEFAULT_MEDIA_CONTEXT)??[]].filter(target=>!available.has(`${DEFAULT_MEDIA_CONTEXT}\0${target}`));
    if (agentTargets.length) {
      const agents=(await fuseki.query(`PREFIX rv: <${RV}>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> SELECT ?agent WHERE {
        VALUES ?agent { ${agentTargets.map(iri).join(' ')} } ${publicAgent('?agent')} } LIMIT 65`,64*1024)).results?.bindings??[];
      for (const agent of agents) if (agent.agent) {
        const key=`${DEFAULT_MEDIA_CONTEXT}\0${agent.agent.value}`;
        available.add(key);publicTargets.add(key);
      }
    }
    const facts: DisclosureTarget[]=[];
    const assetFences: DisclosureTarget[]=[];
    const indexes=bases.map(basis=>{
      if (!basis) return [];
      const own=[facts.length];
      const asset: DisclosureTarget={owner:'media',resource:`https://rezics.com/id/${basis.metadata.asset}`,
        component:'cover',context:basis.context};
      assetFences.push(basis.metadata.use ? { ...asset,
        occurrence: { owner: 'media', kind: 'media-use', resource: `https://rezics.com/id/${basis.metadata.use}`,
          revision: `https://rezics.com/id/${basis.metadata.use}` } } : asset);
      // A page image names one attachment. Its sibling Uses cannot determine
      // this audience; direct Asset governance still fences every occurrence.
      if (basis.metadata.use) {
        facts.push({owner:'media',resource:`https://rezics.com/id/${basis.metadata.use}`,component:'media_use',
          context:basis.context,work:basis.target});
      } else facts.push({...asset,work:basis.target});
      return own;
    });
    // Exact Uses and their Asset restrictions share one owner batch. Repeating
    // the inventory separately would hydrate the same attachment audience twice.
    const viewer = reader.viewer ?? ANONYMOUS_VIEWER;
    const combined = await discloseInventory(work.environment,[...facts,...assetFences],viewer,'media');
    const decisions = combined.slice(0, facts.length), assetDecisions = combined.slice(facts.length);
    const publicMedia = viewer.signedIn
      ? await mediaVisibility(work.environment,facts,ANONYMOUS_VIEWER)
      : decisions.map(decision => decision === 'visible');
    const results = await Promise.all(bases.map(async (basis,index)=>{
      const assetDecision=assetDecisions[indexes[index]![0]!];
      if (!basis || assetDecision!=='visible' || basis.target && !available.has(`${basis.context}\0${basis.target}`)
        || indexes[index]!.some(index=>decisions[index]!=='visible')
        || basis.disclosure!=='public' && !grantedUses.has(basis.metadata.use ?? '') && !(controlsActor && basis.owner===actingSubject)) return null;
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
      // A public Asset can still be used by a draft Work or a private Context.
      const publicTarget=(basis.disclosure==='public' || grantedUses.has(basis.metadata.use ?? '')) && indexes[index]!.every(index=>publicMedia[index])
        && (!basis.target || publicTargets.has(`${basis.context}\0${basis.target}`));
      return {...basis,disclosure: grantedUses.has(basis.metadata.use ?? '') ? 'public' : basis.disclosure,publicTarget,metadata:{...basis.metadata,
        controls:{nsfw,ageRating,conceal},
        canEdit:nsfw.canEdit||ageRating.canEdit||!!conceal?.canEdit,canProtect:canProtectLabels||canProtectConceal}};
    }));
    // A bare representation can be independently public through a current Use.
    // Resolve that exact witness through the same gates; a bare Asset still
    // keeps its conservative all-attachments policy.
    for (const [index, reference] of refs.entries()) {
      if (results[index] || !('representation' in reference) || reference.use) continue;
      const uses = await work.media.store.presentation.representationUses(reference.representation);
      if (!uses?.length) continue;
      const witnesses = await metadataFor(request, uses.map(use => ({ representation: reference.representation, use })), actingSubject);
      results[index] = witnesses.find(witness => witness?.publicTarget && witness.disclosure === 'public') ?? null;
    }
    return results;
  };
  const fieldResult=t.Object({revision:t.Nullable(nativeId),position,replayed:t.Boolean(),admission:t.String()});
  const fieldResponses={200:fieldResult,201:fieldResult,...writeProblems,404:problemResult(404)};
  return new Elysia()
    .post('/v1/zones/:id/campaign-art', { params: t.Object({ id: uuid }), body: campaignArtCommand,
      response: transportResponses(openApiOperations["/v1/zones/{id}/campaign-art"].post, { 200: commandResult, 201: commandResult, ...writeProblems, 404: problemResult(404), 422: problemResult(422) }, 'POST') },
    async ({ request, params, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const { realm, profile: _profile, ...art } = body;
        const result = await createAdmittedCampaignArt(work.environment, work.media, work.account, work.access,
          request, { ...art, zone: `https://rezics.com/id/${params.id}`, target: realm,
            context: DEFAULT_MEDIA_CONTEXT, crop: body.crop ?? null, focalArea: body.focalArea ?? null, idempotencyKey: key });
        return Response.json(result, { status: result.replayed ? 200 : 201, headers: { 'cache-control': 'no-store' } });
      } catch (error) { return mediaError(error); }
    })
    .post('/v1/media/metadata',{body:metadataRead,detail:{security:[{}, {bearerAuth:[]}]},response:transportResponses(openApiOperations["/v1/media/metadata"].post, {200:metadataResult,...authorizedReadProblems}, 'POST')},
      async ({request,body})=>{
        try {
          const items=await metadataFor(request,body.items,body.actingSubject);
          return Response.json({items:items.map((basis,index)=>basis ? {status:'available',...basis.metadata}
            : {status:'unavailable',reference:body.items[index]})},{headers:{'cache-control':'private, no-store'}});
        } catch(error) {return mediaError(error);}
      })
    .get('/v1/media/representations/:representation',{params:t.Object({representation:uuid}),
      query:t.Object({actingSubject:t.Optional(nativeId),use:t.Optional(uuid)},{additionalProperties:false}),
      response:transportResponses(openApiOperations["/v1/media/representations/{representation}"].get, {200:mediaDescriptor,...authorizedReadProblems}, 'GET')},async ({request,params,query})=>{
      try {
        const basis=(await metadataFor(request,[{representation:params.representation,...(query.use?{use:query.use}:{})}],query.actingSubject))[0];
        return basis ? Response.json(basis.metadata,{headers:{'cache-control':'private, no-store'}}) : unavailable();
      } catch(error) {return mediaError(error);}
    })
    .get('/v1/media/representations/:representation/bytes',{params:t.Object({representation:uuid}),
      query:t.Object({actingSubject:t.Optional(nativeId),use:t.Optional(uuid),
        zoneVariant:t.Optional(t.String({maxLength:80})),zone:t.Optional(t.String({maxLength:80}))},{additionalProperties:false}),
      // The handler returns a raw buffered/streamed Response, not a File object. Its wire formats are declared below.
      response:transportResponses(openApiOperations["/v1/media/representations/{representation}/bytes"].get, {200:t.Any(),...authorizedReadProblems}, 'GET'),
      detail:{responses:{200:{description:'Exact retained representation bytes',content:Object.fromEntries(MEDIA_TYPES.map(type=>[
        type,{schema:{type:'string',format:'binary'}}]))}}}},async ({request,params,query}: {request:Request;
        params:{representation:string};query:{actingSubject?:string;use?:string;zoneVariant?:string;zone?:string}})=>publicFirst(request,query.actingSubject,async request=>{
      let lease: DownloadReadLease|undefined;
      try {
        const basis=(await metadataFor(request,[{representation:params.representation,...(query.use?{use:query.use}:{})}],query.actingSubject))[0];
        if (!basis || !work.media) return unavailable();
        // Keep the exact Use selected for a bare representation. Re-running
        // the bare fallback could let a different Use authorize this delivery.
        const reference = { representation: basis.metadata.representation,
          ...(basis.metadata.use ? { use: basis.metadata.use } : {}) };
        const finalDisclosure = async () => {
          const current = (await metadataFor(request, [reference], query.actingSubject))[0];
          return current ? current.publicTarget : null;
        };
        if ((basis.campaign || query.zoneVariant !== undefined) && (!basis.metadata.use || !basis.target || !(await currentZoneCampaignUses(
          work.environment, basis.campaign ? basis.campaignZone : query.zone,
          await readerFor(request, query.actingSubject), basis.target
        )).has(basis.metadata.use))) return unavailable();
        if (basis.disclosure==='public') return await deliver(request,work.media,{objectNamespace:basis.objectNamespace,
          sha256:basis.metadata.sha256,mediaType:basis.metadata.mediaType},finalDisclosure);
        if (query.actingSubject && basis.owner === query.actingSubject) {
          // An uploader's exact private representation uses the same Asset
          // authority as original bytes, including after attaching it to a Post.
          const principal = await work.account.verify(request, ['work:read']);
          const viewer = disclosureViewer(principal, query.actingSubject);
          bindNativeAssetAudience(viewer, basis.metadata.asset);
          const result = await readClosedRealmMediaSelection(work.environment, async () => {
            const current = (await metadataFor(request, [reference], query.actingSubject))[0];
            return current?.owner === query.actingSubject ? current : null;
          }, selected => ({ asset: selected.metadata.asset }), async selected => {
            const bytes = await work.media!.objects(selected.objectNamespace).get(selected.metadata.sha256);
            if (bytes.byteLength !== selected.byteLength) throw new ObjectIntegrityError('media byte length differs');
            return { bytes, selected };
          }, viewer);
          if (!result) return unavailable();
          return new Response(result.bytes.slice(), { headers: {
            'content-type': result.selected.metadata.mediaType,
            'content-length': String(result.selected.byteLength),
            'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
          } });
        }
        // The shared metadata gate has established the uploader's own private
        // audience even before this image is attached to a Work.
        if (!basis.target) return await deliver(request,work.media,{objectNamespace:basis.objectNamespace,
          sha256:basis.metadata.sha256,mediaType:basis.metadata.mediaType},finalDisclosure);
        if (!work.downloadLeases || !basis.target || !query.actingSubject) return unavailable();
        const principal=await work.account.verify(request,['work:read']);
        lease=await work.downloadLeases.admit(principal,query.actingSubject,basis.target,basis.metadata.asset);
        await work.downloadLeases.begin(lease,principal);
        const bytes=await work.media.objects(basis.objectNamespace).get(basis.metadata.sha256);
        if (bytes.byteLength!==basis.byteLength) throw new ObjectIntegrityError('media byte length differs');
        if (await finalDisclosure() === null) {
          await work.downloadLeases.finish(lease.id,'aborted');
          lease=undefined;
          return unavailable();
        }
        return new Response(downloadBody(bytes,lease,work.downloadLeases),{headers:{'content-type':basis.metadata.mediaType,
          'content-length':String(basis.byteLength),'x-content-type-options':'nosniff','cache-control':'private, no-store'}});
      } catch(error) {
        if (lease) await work.downloadLeases?.finish(lease.id,'aborted').catch(()=>undefined);
        return mediaError(error);
      }
    }))
    .post('/v1/media/representations/:representation/labels',{params:t.Object({representation:uuid}),body:imageLabelCommand,response:transportResponses(openApiOperations["/v1/media/representations/{representation}/labels"].post, fieldResponses, 'POST')},
      async ({request,params,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await changeAdmittedMediaField(work.environment,work.media,work.account,work.access,request,
            {...body,representation:params.representation,authority:body.authority??'author',idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uses/:use/conceal',{params:t.Object({use:uuid}),body:concealCommand,response:transportResponses(openApiOperations["/v1/media/uses/{use}/conceal"].post, fieldResponses, 'POST')},
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
      response:transportResponses(openApiOperations["/v1/media/representations/{representation}/inferences"].post, {200:t.Object({},{additionalProperties:true}),201:t.Object({},{additionalProperties:true}),...writeProblems,404:problemResult(404)}, 'POST')},
      async ({request,params,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result=await recordAdmittedImageInference(work.environment,work.media,work.account,work.access,request,
            {...body,representation:params.representation,idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uses',{body:t.Union([documentUseCommand, importedArtUseCommand]),response:transportResponses(openApiOperations["/v1/media/uses"].post, {200:t.Object({},{additionalProperties:true}),201:t.Object({},{additionalProperties:true}),...writeProblems,404:problemResult(404)}, 'POST')},
      async ({request,body})=>{
        if (!work.media) return problem(503,'media_unavailable','Media owner is unavailable');
        const key=idempotencyKey(request);if (!key) return problem(400,'invalid_idempotency_key','A valid Idempotency-Key header is required');
        try {
          const result = 'profile' in body
            ? await createAdmittedImportedArtUse(work.environment,work.media,work.account,work.access,request,
              { ...body,context:body.context??DEFAULT_MEDIA_CONTEXT,idempotencyKey:key })
            : await createAdmittedDocumentImageUse(work.environment,work.media,work.account,work.access,request,
              {...body,context:body.context??DEFAULT_MEDIA_CONTEXT,conceal:body.conceal??false,idempotencyKey:key});
          return Response.json(result,{status:result.replayed?200:201,headers:{'cache-control':'no-store'}});
        } catch(error){return mediaError(error);}
      })
    .post('/v1/media/uploads', {
      body: t.Union([t.Object({ profile: t.Literal('media-image-upload-v1'), asset: t.Nullable(uuid),
        mediaType: t.Union([t.Literal('image/png'), t.Literal('image/jpeg'), t.Literal('image/webp'),
          t.Literal('image/gif')]),
        byteLength: t.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }),
        sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        actingSubject: nativeId, importedCover: t.Optional(importedCoverIntent) }, { additionalProperties: false }),
      t.Object({ profile: t.Literal('media-recording-upload-v1'), asset: t.Nullable(uuid),
        mediaType: t.Union([t.Literal('audio/wav'), t.Literal('video/mp4')]),
        byteLength: t.Integer({ minimum: 1, maximum: MAX_UPLOAD_BYTES }), sha256: t.String({ pattern: '^[0-9a-f]{64}$' }),
        disclosure: t.Literal('private'), actingSubject: nativeId }, { additionalProperties: false })]),
      response: transportResponses(openApiOperations["/v1/media/uploads"].post, { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/media/uploads/{upload}"].get, { 200: uploadStatus, ...authorizedReadProblems }, 'GET'),
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
      response: transportResponses(openApiOperations["/v1/media/uploads/{upload}/bytes"].put, { 200: uploadResult, 201: uploadResult, ...writeProblems, 404: problemResult(404),
        408: problemResult(408), 413: problemResult(413), 422: uploadResult }, 'PUT'),
    }, async ({ request, params }) => {
      try {
        if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
        const result = await activateUploadedBytes(work.environment, work.media, work.account, work.access,
          request, params.upload, maximum => readMediaUploadBytes(request, maximum));
        if (result.status === 'rejected' && result.representation === null) {
          return Response.json({ ...result }, { status: 422, headers: { 'cache-control': 'no-store' } });
        }
        return Response.json(result, { status: result.replayed ? 200 : 201,
          headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof UploadTooLarge) return problem(413, 'media_too_large', 'Upload exceeds the admitted size');
        if (error instanceof UploadTimedOut) return problem(408, 'media_upload_timeout', 'Upload transfer timed out');
        return mediaError(error);
      } finally { cancelUploadBody(request); }
    })
    .post('/v1/media/assets/:asset/state', {
      params: t.Object({ asset: uuid }),
      body: t.Object({ profile: t.Literal('media-asset-state-v1'), expectedState: uuid,
        disclosure: t.Union([t.Literal('private'), t.Literal('public')]),
        lifecycle: t.Union([t.Literal('active'), t.Literal('deleted'), t.Literal('erased')]),
        actingSubject: nativeId }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/media/assets/{asset}/state"].post, { 200: commandResult, 201: commandResult, ...writeProblems, 409: selectionConflictProblem, 404: problemResult(404) }, 'POST'),
    }, async ({ request, params, body }) => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      const key = idempotencyKey(request);
      if (!key) return problem(400, 'invalid_idempotency_key', 'A valid Idempotency-Key header is required');
      try {
        const result = await changeAdmittedAssetState(work.environment, work.media, work.account, work.access,
          request, { asset: params.asset, expectedState: body.expectedState, disclosure: body.disclosure,
            lifecycle: body.lifecycle, actingSubject: body.actingSubject, idempotencyKey: key });
        if (result.outcome === 'stale_head') {
          return problem(409, 'stale_head', 'Asset state changed', undefined,
            { current: result.predecessor, replayed: result.replayed });
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
      response: transportResponses(openApiOperations["/v1/media/publications"].post, { 200: t.Object({}, { additionalProperties: true }), 201: t.Object({}, { additionalProperties: true }), ...writeProblems, 404: problemResult(404) }, 'POST'),
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
      response: transportResponses(openApiOperations["/v1/media/avatars/{selection}"].get, { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => publicFirst(request, query.actingSubject, async request => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const reader = await readerFor(request, query.actingSubject);
        const basis = await withDisclosureViewer(reader.viewer ?? ANONYMOUS_VIEWER,
          () => work.media!.store.avatarDelivery(params.selection));
        if (!basis || !avatarImageEligible(basis)) return unavailable();
        // Agent avatars return before summary hydration. A retained profile
        // must pass the live name owner both before and after graph hydration.
        const names: DisclosureTarget[] = [{ owner: 'graph', resource: basis.target, component: 'name',
          context: basis.context === DEFAULT_MEDIA_CONTEXT ? undefined : basis.context! }];
        const discloseName = async () => reader.viewer?.signedIn
          ? await discloseInventoryWithAnonymousNames(work.environment, names, reader.viewer, 'media')
          : { decisions: await discloseInventory(work.environment, names,
            reader.viewer ?? ANONYMOUS_VIEWER, 'media'), anonymousNames: [] };
        if ((await discloseName()).decisions[0] !== 'visible') return unavailable();
        const finalAvatarDisclosure = async () => {
          const current = (await metadataFor(request,
            [{ representation: basis.representation!, use: basis.use! }], query.actingSubject))[0];
          return current ? current.publicTarget : null;
        };
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
          return await deliver(request, work.media, { objectNamespace: basis.objectNamespace,
            sha256: basis.sha256!, mediaType: basis.mediaType! }, async () => {
            // Graph hydration and object retrieval may outlive the opening
            // name decision. Settle both visibility and cache scope at delivery.
            const current = await discloseName();
            if (current.decisions[0] !== 'visible') return null;
            const publicMedia = await finalAvatarDisclosure();
            return publicMedia === null ? null : publicMedia
              && (!reader.viewer?.signedIn || current.anonymousNames[0] === 'visible');
          });
        }
        const target = (await readResourceSummaries(work.environment, undefined,
          reader, { resources: [basis.target], context: basis.context!, language: null, channel: 'media' })).summaries[0]!;
        if (target.status !== 'available') return unavailable();
        return await deliver(request, work.media, { objectNamespace: basis.objectNamespace,
          sha256: basis.sha256!, mediaType: basis.mediaType! }, finalAvatarDisclosure);
      } catch (error) { return mediaError(error); }
    }))
    .get('/v1/media/uses/:use', {
      params: t.Object({ use: uuid }),
      query: t.Object({ actingSubject: t.Optional(nativeId),
        zoneVariant: t.Optional(t.String({ maxLength: 80 })), zone: t.Optional(t.String({ maxLength: 80 })) }, { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/media/uses/{use}"].get, { 200: t.Object({}, { additionalProperties: true }), ...authorizedReadProblems }, 'GET'),
    }, async ({ request, params, query }) => publicFirst(request, query.actingSubject, async request => {
      if (!work.media) return problem(503, 'media_unavailable', 'Media owner is unavailable');
      try {
        await assertGraphAdmissionOpen(fuseki, work.environment.lineage);
        const reader = await readerFor(request, query.actingSubject);
        const item = await withDisclosureViewer(reader.viewer ?? ANONYMOUS_VIEWER,
          () => work.media!.store.itemDelivery(params.use));
        if (!item || item.availability !== 'available' || item.disclosure !== 'public'
          || item.moderation !== 'none' || item.lifecycle !== 'active' || item.clearance !== 'cleared') return unavailable();
        if ((item.role.startsWith('campaign-') || query.zoneVariant !== undefined) && !(await currentZoneCampaignUses(
          work.environment, item.role.startsWith('campaign-') ? item.campaignZone : query.zone,
          reader, item.target)).has(params.use)) return unavailable();
        const reference = { representation: item.representation, use: params.use };
        const basis = (await metadataFor(request, [reference], query.actingSubject))[0];
        if (!basis) return unavailable();
        return await deliver(request, work.media, item, async () => {
          const current = (await metadataFor(request, [reference], query.actingSubject))[0];
          return current ? current.publicTarget : null;
        });
      } catch (error) { return mediaError(error); }
    }))
    .get('/v1/media/assets/:asset/bytes', {
      params: t.Object({ asset: uuid }),
      query: t.Object({ target: nativeId, actingSubject: nativeId,
        context: t.Optional(mediaContextInput) },
      { additionalProperties: false }),
      response: transportResponses(openApiOperations["/v1/media/assets/{asset}/bytes"].get, { 200: t.Any(), ...authorizedReadProblems }, 'GET'),
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
        const owner = await work.access.canManageMedia?.(principal, query.actingSubject)
          || await work.access.canReadAsBaselineMember?.(principal, query.actingSubject)
          ? query.actingSubject : undefined;
        const viewer = reader.viewer ?? ANONYMOUS_VIEWER;
        if (owner) bindNativeAssetAudience(viewer, params.asset);
        const readBasis = async () => {
          const basis = await withDisclosureViewer(viewer,
            () => work.media!.store.assetDelivery(params.asset, query.target,
              query.context ?? DEFAULT_MEDIA_CONTEXT, owner));
          if (!basis || basis.availability !== 'available' || (basis.disclosure !== 'private' && basis.owner !== query.actingSubject)
            || basis.moderation !== 'none' || basis.lifecycle !== 'active'
            || !(basis.clearance === 'cleared' || (basis.clearance === 'screening' && basis.owner === query.actingSubject
              && basis.uploader === await work.access.activePrincipalId(principal)))
            || !Number.isSafeInteger(basis.byteLength) || basis.byteLength < 1
            || basis.byteLength > MAX_UPLOAD_BYTES) return null;
          return basis;
        };
        const basis = await readBasis();
        if (!basis) return unavailable();
        if (owner === basis.owner) {
          // An owner's own bytes depend on the Asset, not a Work grant or a Use.
          // Reuse the disclosure fence so erasure or lost owner authority while
          // buffering cannot return either bytes or their validator.
          const result = await readClosedRealmMediaSelection(work.environment, readBasis,
            () => ({ asset: params.asset }), async selected => {
              const bytes = await work.media!.objects(selected.objectNamespace).get(selected.sha256);
              if (bytes.byteLength !== selected.byteLength) throw new ObjectIntegrityError('media byte length differs');
              return { bytes, selected };
            }, viewer);
          if (!result) return unavailable();
          return new Response(result.bytes.slice(), { headers: {
            'content-type': result.selected.mediaType,
            etag: `"${result.selected.sha256}"`,
            'content-length': String(result.selected.byteLength),
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store',
          } });
        }
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
        const result = await readClosedRealmMediaSelection(work.environment, readBasis,
          () => ({ asset: params.asset }), async selected => {
            const bytes = await work.media!.objects(selected.objectNamespace).get(selected.sha256);
            if (bytes.byteLength !== selected.byteLength) throw new ObjectIntegrityError('media byte length differs');
            return { bytes, selected };
          }, viewer);
        if (!result) {
          await work.downloadLeases.finish(lease.id, 'aborted');
          lease = undefined;
          return unavailable();
        }
        return new Response(downloadBody(result.bytes, lease, work.downloadLeases), { headers: {
          'content-type': result.selected.mediaType,
          etag: `"${result.selected.sha256}"`,
          'content-length': String(result.selected.byteLength),
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        } });
      } catch (error) {
        if (lease) await work.downloadLeases.finish(lease.id, 'aborted').catch(() => undefined);
        return mediaError(error);
      }
    });
}
