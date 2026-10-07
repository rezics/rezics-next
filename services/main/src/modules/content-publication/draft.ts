import { createHash } from 'node:crypto';
import { ContentConflict, contentDraftIntentDigest, type ContentCore,
  validPublicDomainSource, type PublicDomainTextSource, type SaveDraftCommand,
  type SaveDraftResult, type VariantIdentity } from '../../../../content/src/core.ts';
import { directContentEmbeds } from '../../../../content/src/embed.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry,
  type GraphTerminalProof, type RegisteredAdmission } from '../access/admission.ts';
import { DATASET, GRAPHS, iri, lit, type WorkActivationEnvironment } from '../work/activate.ts';
import type { RightsStore } from '../rights/store.ts';
import { authoredDocumentBody, authoredPostNotes, POST_CONTENT_MODEL, CONTENT_TEXT_COST, checkedContentText,
  type PostNotesInput, type AuthoredBodyInput } from '../../../../content/src/document-body.ts';
import { admittedTypes } from '../types/registry.ts';
import { nativePostType, workContentTypes } from '../work/work-kinds.ts';
import { withZonePageContentTarget, zonePageContentAllowed } from '../access/zone-content-authority.ts';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { typeIri } from '../types/contract.ts';
import { Value } from 'typebox/value';

export class ContentDraftDenied extends Error {}
export class ContentDraftRightsDenied extends ContentDraftDenied {}
export class ContentDraftStale extends Error {
  constructor(message: string, readonly currentHead: string | null = null) { super(message); }
}
export class ContentDraftUnavailable extends Error {}

export interface AuthoredContentDraftInput extends AuthoredBodyInput {
  resourceId: string;
  targetProfile?: 'work' | 'catalog-description';
  variant: VariantIdentity;
  expectedHead: string | null;
  embeds?: string[];
  notes?: PostNotesInput;
  actingSubject: string;
  idempotencyKey: string;
  publicDomain?: { assessmentId: string; source: PublicDomainTextSource };
}

export function contentDraftReceiptIri(admissionId: string): string {
  return `urn:rezics:receipt:${createHash('sha256')
    .update(`${admissionId}\0content-draft-save`).digest('hex')}`;
}

function terminalProof(admission: RegisteredAdmission, result: SaveDraftResult): GraphTerminalProof {
  return { outcome: result.outcome === 'succeeded' ? 'succeeded' : 'cancelled',
    receipt: contentDraftReceiptIri(admission.id), admissionId: admission.id,
    requestDigest: admission.requestDigest, authorityEpoch: admission.authorityEpoch,
    scope: admission.scope, dataEpoch: result.position.dataEpoch,
    sequence: result.position.sequence };
}

/** Called only after an Access scope/principal fence. The Content operation lock
 * converts a missing receipt to a durable cancellation or returns the winning save. */
export async function sealContentDraftAdmission(content: ContentCore,
  admission: RegisteredAdmission): Promise<GraphTerminalProof> {
  if (admission.action !== 'content.draft') throw new ContentDraftDenied('wrong admission action');
  const result = await content.cancelDraft(admission.id, admission.requestDigest);
  return terminalProof(admission, result);
}

export interface ContentTarget { type: string; zone: string | null }
export const CONTENT_TARGET_COST = { graphReads: 1, types: 64, graphBytes: 262_144 } as const;

function contentTypeTerm(type: string): string {
  if (!Value.Check(typeIri, type)) throw new ContentDraftUnavailable('Admitted Content type is invalid');
  return `<${type}>`;
}

// Native custody and catalogue descriptions are existing Content capabilities,
// independent of the descriptive type catalogue's creation choices.
const admittedContentTypes = () => [...new Set([
  ...admittedTypes.map(entry => entry.type), nativePostType, 'https://schema.org/Organization',
])];

function contentTargetStateGuard(resourceId: string): string {
  return `FILTER(!EXISTS { ${iri(resourceId)} a ?contentWorkType .
      VALUES ?contentWorkType { ${workContentTypes().map(contentTypeTerm).join(' ')} } }
      || EXISTS { ${iri(resourceId)} <https://rezics.com/vocab/head> ?targetHead })
    FILTER(!EXISTS { ${iri(resourceId)} a <https://rezics.com/vocab/Zone> }
      || EXISTS { ${iri(resourceId)} <https://rezics.com/vocab/zoneState> <https://rezics.com/vocab/Active> ;
        <https://rezics.com/vocab/space> ?zoneSpace ; <https://rezics.com/vocab/zoneHead> ?zoneHead })`;
}

/** Target state and owner identity must still hold in the dispatch snapshot. */
export function contentTargetGuard(resourceId: string, target?: ContentTarget): string {
  if (target && (!admittedContentTypes().includes(target.type)
    || (target.type === 'https://rezics.com/vocab/Zone' ? target.zone !== resourceId : target.zone !== null))) {
    throw new ContentDraftUnavailable('Content target identity differs from its owner');
  }
  return `${iri(resourceId)} a ${target ? contentTypeTerm(target.type) : '?contentTargetType'} .
    ${target ? '' : `VALUES ?contentTargetType { ${admittedContentTypes().map(contentTypeTerm).join(' ')} }`}
    ${contentTargetStateGuard(resourceId)}
    ${target?.zone ? `FILTER NOT EXISTS { ${iri(resourceId)} a ?otherOwner .
      VALUES ?otherOwner { ${workContentTypes().map(contentTypeTerm).join(' ')}
        <https://schema.org/Organization> } }` : target ? `FILTER NOT EXISTS {
      ${iri(resourceId)} a <https://rezics.com/vocab/Zone> }
      ${workContentTypes().includes(target.type) ? '' : `FILTER NOT EXISTS {
        ${iri(resourceId)} a ?otherWorkOwner .
        VALUES ?otherWorkOwner { ${workContentTypes().map(contentTypeTerm).join(' ')} } }`}` : ''}`;
}

/** Resolve identity from admitted current types, before choosing owner authority.
 * A Zone can carry its own page variants; unadmitted page IDs have no owner. */
export async function resolveContentTarget(env: WorkActivationEnvironment,
  resourceId: string): Promise<ContentTarget> {
  const rows = (await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    SELECT DISTINCT ?type WHERE {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true } }
      GRAPH ${iri(GRAPHS.current)} { ${iri(resourceId)} a ?type .
        VALUES ?type { ${admittedContentTypes().map(contentTypeTerm).join(' ')} }
        ${contentTargetStateGuard(resourceId)} }
    } LIMIT ${CONTENT_TARGET_COST.types + 1}`, CONTENT_TARGET_COST.graphBytes)).results?.bindings ?? [];
  const types = [...new Set(rows.flatMap(row => row.type ? [row.type.value] : []))];
  if (!types.length || rows.length > CONTENT_TARGET_COST.types
    || types.some(type => !admittedContentTypes().includes(type))) {
    throw new ContentDraftUnavailable('Content target is unavailable');
  }
  const zone = types.includes('https://rezics.com/vocab/Zone');
  if (zone && types.some(type => workContentTypes().includes(type)
    || type === 'https://schema.org/Organization')) {
    throw new ContentDraftUnavailable('Content target owner is ambiguous');
  }
  const workBase = admittedTypes.find(entry => entry.base === 'work' && entry.default)?.type;
  const workType = types.filter(type => workContentTypes().includes(type)).sort()[0];
  const type = zone ? 'https://rezics.com/vocab/Zone'
    : types.includes(nativePostType) ? nativePostType
      : workBase && types.includes(workBase) ? workBase
        : workType ?? (types.includes('https://schema.org/Organization')
          ? 'https://schema.org/Organization' : types.sort()[0]!);
  return { type, zone: zone ? resourceId : null };
}

export type ContentReadAuthority = Pick<AccessAdmissionRegistry, 'canReadWork'>
  & Partial<Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'withOwnerAuthority'>>;

type ZoneContentAuthority = Partial<Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'withOwnerAuthority'>>;

/** Explicit Content policies cannot substitute for the Zone owner's authority.
 * The bridge's selected SQL proofs stay held through the Content effect. */
export async function withZoneContentAuthority<T>(env: WorkActivationEnvironment,
  access: ZoneContentAuthority, principal: VerifiedPrincipal, actingSubject: string,
  zone: string, action: 'content.draft' | 'content.publish', operation: () => Promise<T>): Promise<T> {
  if (!access.withOwnerAuthority || !access.activePrincipalId) {
    throw new ContentDraftUnavailable('Content owner authority is unavailable');
  }
  const principalId = await access.activePrincipalId(principal);
  if (!principalId) throw new ContentDraftDenied('Zone edit authority is unavailable');
  return access.withOwnerAuthority(withZonePageContentTarget({ principal, actingSubject,
    action, scope: `${action.replace('.', ':')}:${zone}` }, zone), async client => {
    if (!await zonePageContentAllowed(client, env.fuseki, principalId, actingSubject,
      zone, principal.emailVerified === true)) throw new ContentDraftDenied('Zone edit authority is unavailable');
    return operation();
  });
}

/** Private Zone bytes use the same live zone.edit bridge as dispatch. */
export async function canReadContentTarget(env: WorkActivationEnvironment,
  access: ContentReadAuthority, principal: VerifiedPrincipal, actingSubject: string,
  resourceId: string, target: ContentTarget): Promise<boolean> {
  if (workContentTypes().includes(target.type)) {
    return access.canReadWork(principal, actingSubject, resourceId);
  }
  if (!access.withOwnerAuthority) {
    throw new ContentDraftUnavailable('Content owner authority is unavailable');
  }
  try {
    if (target.zone) return await withZoneContentAuthority(env, access, principal, actingSubject,
      target.zone, 'content.draft', () => Promise.resolve(true));
    const authority = { principal, actingSubject, action: 'content.draft', scope: `content:draft:${resourceId}` };
    return await access.withOwnerAuthority(authority, () => Promise.resolve(true));
  } catch (error) {
    if (error instanceof AdmissionDenied || error instanceof AdmissionExpired || error instanceof ContentDraftDenied) return false;
    throw error;
  }
}

async function assertCurrentTarget(env: WorkActivationEnvironment,
  resourceId: string, variantId: string, targetProfile: AuthoredContentDraftInput['targetProfile'],
  hasNotes: boolean, target: ContentTarget): Promise<void> {
  const result = await env.fuseki.query(`PREFIX rv: <https://rezics.com/vocab/>
    PREFIX schema: <https://schema.org/> ASK {
      GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
        rv:routingEpoch ${lit(env.lineage.routingEpoch)} .
        FILTER NOT EXISTS { ${iri(DATASET)} rv:restoreHold true }
      }
      GRAPH ${iri(GRAPHS.current)} { ${contentTargetGuard(resourceId, target)} }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} {
        ${iri(variantId)} rv:resource ?other .
        FILTER(?other != ${iri(resourceId)}) } }
    }`);
  if (result.boolean !== true) {
    if (hasNotes) throw new ContentConflict('notes require a current Post target');
    throw new ContentDraftUnavailable('Content target is unavailable');
  }
  if (hasNotes && target.type !== nativePostType
    || targetProfile === 'catalog-description' && target.type !== 'https://schema.org/Organization') {
    throw new ContentConflict('Content profile differs from its target');
  }
}

/** Account, Access and the resolved target admit a draft before Content's local CAS. */
export async function saveAdmittedContentDraft(env: WorkActivationEnvironment,
  content: ContentCore, account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'> & ZoneContentAuthority,
  request: Request, input: AuthoredContentDraftInput,
  rights?: Pick<RightsStore, 'currentPublicDomainAssessment'>): Promise<SaveDraftResult & { byteDigest: string }> {
  let body;
  let notes;
  // Content's text API retains its 65,536 UTF-16-unit budget. UTF-8 custody
  // permits up to three bytes per unit; Contribution and reply limits differ.
  try {
    body = authoredDocumentBody(input, CONTENT_TEXT_COST.textBytes);
    checkedContentText(body.body);
    notes = authoredPostNotes(input.notes);
    if (notes !== undefined && input.targetProfile === 'catalog-description') {
      throw new Error('notes require a Post');
    }
  }
  catch { throw new ContentConflict('invalid authored Content body'); }
  if (input.variant.resourceId !== input.resourceId
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.resourceId)
    || !/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/i.test(input.actingSubject)
    || !/^urn:rezics:variant:[0-9a-f-]{36}$/i.test(input.variant.id)
    || (input.expectedHead !== null
      && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.expectedHead))
    || (input.publicDomain !== undefined && (input.targetProfile === 'catalog-description'
      || !/^[0-9a-f-]{36}$/i.test(input.publicDomain.assessmentId)
      || !validPublicDomainSource(input.publicDomain.source)))) {
    throw new ContentConflict('invalid authored Content draft');
  }
  const embeds = directContentEmbeds(input.embeds);
  const serializedJson = JSON.stringify({ ...body,
    ...(notes !== undefined ? { notes } : {}),
    ...(embeds.length ? { embeds } : {}) });
  const command: SaveDraftCommand = { operationId: '', variant: input.variant,
    expectedHead: input.expectedHead,
    model: input.targetProfile === 'catalog-description' ? 'catalog-description-v1'
      : notes !== undefined ? POST_CONTENT_MODEL : 'content-shape-v1',
    sourceRevision: null,
    provenance: {}, serializedJson };
  const publicDomain = input.publicDomain;
  const digest = contentDraftIntentDigest(command, input.actingSubject,
    publicDomain ? { rightsAssessmentId: publicDomain.assessmentId, source: publicDomain.source } : undefined);
  const target = await resolveContentTarget(env, input.resourceId);
  const principal = await account.verify(request, [target.zone ? 'zone:edit' : 'work:edit']);
  if (target.zone && input.publicDomain) throw new ContentConflict('public-domain assessment requires a Work');
  await assertCurrentTarget(env, input.resourceId, input.variant.id, input.targetProfile, notes !== undefined, target);
  if (target.zone) await withZoneContentAuthority(env, access, principal, input.actingSubject,
    target.zone, 'content.draft', () => Promise.resolve());
  const scope = `content:draft:${input.resourceId}`;
  const registration = { principal, actingSubject: input.actingSubject,
    scope, action: 'content.draft', idempotencyKey: input.idempotencyKey,
    requestDigest: digest };
  const registered = await access.register(target.zone
    ? withZonePageContentTarget(registration, target.zone) : registration);
  command.operationId = `content-draft:${registered.id}`;
  command.provenance = publicDomain ? { kind: 'admitted-public-domain-v1',
    transcriber: input.actingSubject, rightsBasis: 'public-domain',
    rightsAssessmentId: publicDomain.assessmentId, source: publicDomain.source,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead } : {
    kind: 'admitted-original-contribution-v1', author: input.actingSubject,
    admissionId: registered.id, authorityEpoch: registered.authorityEpoch,
    scope, requestDigest: digest, expectedHead: input.expectedHead,
    rightsBasis: 'original-contribution' };
  if (publicDomain && !registered.replayed) {
    if (!rights) throw new ContentDraftUnavailable('rights owner is unavailable');
    let current: boolean;
    try { current = await rights.currentPublicDomainAssessment(input.resourceId, publicDomain.assessmentId); }
    catch { throw new ContentDraftUnavailable('rights owner is unavailable'); }
    if (!current) throw new ContentDraftRightsDenied('current public-domain Work assessment is required');
  }
  if (registered.state !== 'sealed') {
    try { await access.claim(registered.id, digest, principal); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
      if (!await content.readDraftReceipt(command.operationId)) {
        throw new ContentDraftDenied('draft dispatch is not admitted');
      }
    }
  }
  const save = async () => {
    await assertCurrentTarget(env, input.resourceId, input.variant.id, input.targetProfile, notes !== undefined, target);
    return content.saveDraft(command);
  };
  const saved = target.zone ? await withZoneContentAuthority(env, access, principal,
    input.actingSubject, target.zone, 'content.draft', save) : await save();
  await access.recordGraphOutcome(registered.id, terminalProof(registered, saved));
  if (saved.outcome === 'cancelled') throw new ContentDraftDenied('draft admission was fenced');
  if (saved.outcome === 'stale_head') {
    const current = await content.readDraftHead(input.resourceId, input.variant.id);
    throw new ContentDraftStale('Content draft head changed', current?.revisionId ?? null);
  }
  return { ...saved, byteDigest: createHash('sha256').update(serializedJson).digest('hex'),
    replayed: registered.replayed || saved.replayed };
}
