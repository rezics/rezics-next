import { createHash } from 'node:crypto';
import { contentDraftIntentDigest, type ContentCore, type SaveDraftCommand }
  from '../../../../content/src/core.ts';
import type { ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { contentDraftReceiptIri } from '../content-publication/draft.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import { ImageFormatRejected, verifyImage } from './image.ts';
import { assetIri, MediaConflict, MediaInvalid, MediaMissing,
  MediaStale, type MediaStore, type AssetStateChangeInput, type AvatarSelectionInput,
  type CommandOutcome, type MediaAdmission, type ReserveUploadInput } from './store.ts';

export class MediaDenied extends Error {}

/** Wiring for the media routes: the owner store and one immutable-object namespace factory. */
export interface MediaDependencies {
  store: MediaStore;
  content: ContentCore;
  /** Returns the conditional-create adapter for one retention/disclosure namespace. */
  objects: (namespace: string) => ImmutableObjects;
}

type Account = Pick<AccountAssertionVerifier, 'verify'>;
type Access = Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome' | 'activePrincipalId'>;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Access scopes: an owner manages its own assets; a target's avatar has its own grant. */
export const mediaOwnerScope = (subject: string) => `media:owner:${subject}`;
export const avatarScope = (target: string) => `media:avatar:${target}`;

export function uploadDigest(input: ReserveUploadInput): string {
  return sha256(stable({ family: 'media-upload-v1', ...input }));
}
export function stateDigest(input: AssetStateChangeInput): string {
  return sha256(stable({ family: 'media-asset-state-v1', ...input }));
}
export function avatarDigest(input: AvatarSelectionInput): string {
  return sha256(stable({ family: 'media-avatar-v1', ...input }));
}

/** Account, Access claim and the owner's operation lock admit one media command.
 * A replay after Access closes dispatch returns the durable owner outcome. */
async function admitted<T extends { position: CommandOutcome['position']; replayed: boolean }>(
  env: WorkActivationEnvironment, account: Account, access: Access, request: Request,
  args: { scope: string; action: string; actingSubject: string; idempotencyKey: string; digest: string;
    operation: (id: string) => string; accountScope: string },
  store: MediaStore, run: (admission: MediaAdmission) => Promise<T>,
): Promise<T & { admission: string }> {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, [args.accountScope]);
  let registered: RegisteredAdmission;
  try {
    registered = await access.register({ principal, actingSubject: args.actingSubject,
      scope: args.scope, action: args.action, idempotencyKey: args.idempotencyKey,
      requestDigest: args.digest });
  } catch (error) {
    if (error instanceof AdmissionDenied) throw new MediaDenied('media authority is not admitted');
    throw error;
  }
  if (registered.requestDigest !== args.digest) throw new MediaConflict('media operation key binds another intent');
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, args.digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await store.readOutcome(args.operation(registered.id))) {
        throw new MediaDenied('media dispatch is not admitted');
      }
    }
  }
  const result = await run({ admissionId: registered.id, principalId: registered.principalId,
    actingSubject: registered.actingSubject, authorityEpoch: registered.authorityEpoch,
    requestDigest: args.digest });
  if ((result as { outcome?: string }).outcome === 'rejected') throw new MediaDenied('media admission was fenced');
  return Object.assign(result, { replayed: registered.replayed || result.replayed, admission: registered.id });
}

export function reserveAdmittedUpload(env: WorkActivationEnvironment, media: MediaDependencies,
  account: Account, access: Access, request: Request,
  input: ReserveUploadInput & { actingSubject: string; idempotencyKey: string }) {
  const { actingSubject, idempotencyKey, ...reservation } = input;
  return admitted(env, account, access, request, { scope: mediaOwnerScope(actingSubject),
    action: 'media.upload', actingSubject, idempotencyKey, digest: uploadDigest(reservation),
    operation: id => `media-upload:${id}`, accountScope: 'work:edit' },
  media.store, admission => media.store.reserveUpload(admission, reservation));
}

/** Verify quarantined bytes, copy them into the asset namespace, activate the original
 * and record the asset revision. Every stage is idempotent for one upload. */
export async function activateUploadedBytes(env: WorkActivationEnvironment, media: MediaDependencies,
  account: Account, access: Access, request: Request, uploadId: string, bytes: Uint8Array) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  const principalId = await access.activePrincipalId(principal);
  const upload = await media.store.readUpload(uploadId);
  if (!upload || !principalId || upload.principal !== principalId) {
    throw new MediaMissing('media upload is unavailable');
  }
  // A retried transfer after settlement replays the durable outcome.
  if (upload.status === 'activated' || upload.status === 'rejected') return finish(media, uploadId, null);
  if (upload.status !== 'reserved' || upload.expired) throw new MediaStale('media upload reservation has lapsed');
  const digest = sha256(bytes);
  let verdict: Parameters<MediaStore['settleUpload']>[1];
  if (bytes.length !== upload.byteLength) verdict = { status: 'rejected', reason: 'size-mismatch' };
  else if (upload.sha256 && digest !== upload.sha256) verdict = { status: 'rejected', reason: 'digest-mismatch' };
  else {
    try {
      const image = verifyImage(bytes, upload.mediaType);
      // Stage in quarantine, read back through the adapter, then create the active object.
      const quarantine = media.objects(`${upload.quarantineKey}/`);
      const staged = await quarantine.get(await quarantine.put(bytes));
      await media.objects(upload.objectNamespace).put(staged);
      verdict = { status: 'activated', sha256: digest, byteLength: bytes.length,
        mediaType: image.mediaType, width: image.width, height: image.height };
    } catch (error) {
      if (!(error instanceof ImageFormatRejected)) throw error;
      verdict = { status: 'rejected', reason: 'format-rejected' };
    }
  }
  return finish(media, uploadId, await media.store.settleUpload(uploadId, verdict));
}

async function finish(media: MediaDependencies, uploadId: string,
  settled: Awaited<ReturnType<MediaStore['settleUpload']>> | null) {
  const upload = await media.store.readUpload(uploadId);
  if (!upload) throw new MediaMissing('media upload is unavailable');
  if (upload.status !== 'activated') {
    return { asset: upload.asset, upload: uploadId, status: 'rejected' as const,
      reason: settled?.reason ?? upload.reason, representation: null, revision: null,
      replayed: settled?.replayed ?? true };
  }
  const recorded = await media.store.recordAssetRevision(uploadId);
  return { asset: upload.asset, upload: uploadId, status: 'activated' as const, reason: null,
    representation: upload.representation, revision: recorded.revision,
    replayed: (settled?.replayed ?? true) && recorded.replayed };
}

export function changeAdmittedAssetState(env: WorkActivationEnvironment, media: MediaDependencies,
  account: Account, access: Access, request: Request,
  input: AssetStateChangeInput & { actingSubject: string; idempotencyKey: string }) {
  const { actingSubject, idempotencyKey, ...change } = input;
  return admitted(env, account, access, request, { scope: mediaOwnerScope(actingSubject),
    action: 'media.manage', actingSubject, idempotencyKey, digest: stateDigest(change),
    operation: id => `media-state:${id}`, accountScope: 'work:edit' },
  media.store, admission => media.store.changeState(admission, change));
}

export function selectAdmittedAvatar(env: WorkActivationEnvironment, media: MediaDependencies,
  account: Account, access: Access, request: Request,
  input: AvatarSelectionInput & { actingSubject: string; idempotencyKey: string }) {
  const { actingSubject, idempotencyKey, ...selection } = input;
  return admitted(env, account, access, request, { scope: avatarScope(selection.target),
    action: 'media.avatar', actingSubject, idempotencyKey, digest: avatarDigest(selection),
    operation: id => `media-avatar:${id}`, accountScope: 'work:edit' },
  media.store, admission => media.store.selectAvatar(admission, selection));
}

/** Access dispatch fence for an unsealed media admission (see README: Access registration). */
export async function sealMediaAdmission(store: MediaStore, admission: RegisteredAdmission) {
  const family = admission.action === 'media.upload' ? ['media-upload', 'media.upload.reserve']
    : admission.action === 'media.manage' ? ['media-state', 'media.asset.state']
      : admission.action === 'media.avatar' ? ['media-avatar', 'media.selection.change'] : null;
  if (!family) throw new MediaInvalid('not a media admission');
  const result = await store.cancel(`${family[0]}:${admission.id}`, family[1]!, admission.requestDigest);
  return { outcome: result.outcome, receipt: `urn:rezics:receipt:${sha256(`${admission.id}\0${family[0]}`)}`,
    admissionId: admission.id, requestDigest: admission.requestDigest,
    authorityEpoch: admission.authorityEpoch, scope: admission.scope,
    dataEpoch: result.position.dataEpoch, sequence: result.position.sequence };
}

// ---- Image-only publication body (BOOK09) ----

export interface MediaSetInput {
  resourceId: string;
  variantId: string;
  expectedHead: string | null;
  assets: string[];
  actingSubject: string;
  idempotencyKey: string;
}

export const MAX_MEDIA_SET_ITEMS = 16;

/** Stable Use identity for one item, known before the Access digest binds the body. */
function itemUse(input: MediaSetInput, index: number): string {
  const hex = sha256(`${input.actingSubject}\0${input.idempotencyKey}\0${input.variantId}\0${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function assertCurrentWork(env: WorkActivationEnvironment, resourceId: string, variantId: string) {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} a schema:CreativeWork ; rv:head ?head . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(variantId)} rv:resource ?other . FILTER(?other != ${iri(resourceId)}) } }
    }`);
  if (result.boolean !== true) throw new MediaMissing('current Work is unavailable');
}

/** Save an image-only Content revision (model media-set-v1) under the ordinary
 * `content.draft` admission. Items are exact Uses; no text document is created. */
export async function saveAdmittedMediaSet(env: WorkActivationEnvironment, media: MediaDependencies,
  account: Account, access: Access, request: Request, input: MediaSetInput) {
  if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(input.resourceId)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/.test(input.variantId)
    || !input.assets.length || input.assets.length > MAX_MEDIA_SET_ITEMS
    || new Set(input.assets).size !== input.assets.length) {
    throw new MediaInvalid('image-only publication body is invalid');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const principal = await account.verify(request, ['work:edit']);
  await assertCurrentWork(env, input.resourceId, input.variantId);
  const items = await media.store.publicationBasis(input.assets, input.actingSubject);
  const body = { profile: 'media-set-v1', items: items.map((item, index) => ({
    use: itemUse(input, index), asset: assetIri(item.asset), assetRevision: item.revision,
    representation: item.representation, sha256: item.sha256, mediaType: item.mediaType,
    width: item.width, height: item.height })) };
  const serializedJson = JSON.stringify(body);
  const command: SaveDraftCommand = { operationId: '', variant: { id: input.variantId,
    resourceId: input.resourceId, language: { kind: 'zxx' }, direction: 'none' },
  expectedHead: input.expectedHead, model: 'media-set-v1', sourceRevision: null, provenance: {},
  serializedJson };
  const digest = contentDraftIntentDigest(command, input.actingSubject);
  const scope = `content:draft:${input.resourceId}`;
  let registered: RegisteredAdmission;
  try {
    registered = await access.register({ principal, actingSubject: input.actingSubject, scope,
      action: 'content.draft', idempotencyKey: input.idempotencyKey, requestDigest: digest });
  } catch (error) {
    if (error instanceof AdmissionDenied) throw new MediaDenied('draft authority is not admitted');
    throw error;
  }
  command.operationId = `content-draft:${registered.id}`;
  command.provenance = { kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch, scope,
    requestDigest: digest, expectedHead: input.expectedHead, rightsBasis: 'original-contribution' };
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, digest); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await media.content.readDraftReceipt(command.operationId)) {
        throw new MediaDenied('draft dispatch is not admitted');
      }
    }
  }
  await media.store.createPublicationUses(registered.id, input.actingSubject, input.resourceId,
    body.items.map((item, index) => ({ use: item.use, ...items[index]! })));
  const saved = await media.content.saveDraft(command);
  const proof: GraphTerminalProof = { outcome: saved.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: contentDraftReceiptIri(registered.id), admissionId: registered.id,
    requestDigest: digest, authorityEpoch: registered.authorityEpoch, scope,
    dataEpoch: saved.position.dataEpoch, sequence: saved.position.sequence };
  await access.recordGraphOutcome(registered.id, proof);
  if (saved.outcome === 'cancelled') throw new MediaDenied('draft admission was fenced');
  if (saved.outcome === 'stale_head') throw new MediaStale('Content draft head changed');
  return { resourceId: input.resourceId, variantId: input.variantId, revisionId: saved.revisionId!,
    predecessor: saved.predecessor, byteDigest: sha256(serializedJson), body,
    sourcePosition: saved.position, replayed: registered.replayed || saved.replayed };
}

