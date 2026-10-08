import { profileValidations } from '../../infrastructure/profile.ts';
import { validatedCommand } from '../../infrastructure/invalid-receipt.ts';
import { AdmissionDenied, AdmissionExpired, type AccessAdmissionRegistry }
  from '../access/admission.ts';
import type { AccountAssertionVerifier } from '../account/verify-assertion.ts';
import { compositionReceiptIri, readCompositionReceipt,
  sealStructureAdmissionCancellation, terminalResult, type CompositionTerminal } from '../structure/change.ts';
import { assertGraphAdmissionOpen } from '../work/restore-lineage.ts';
import { readWorkComponentState } from '../work/history.ts';
import { DATASET, GRAPHS, RV, hash, iri, lit, prepareComponent,
  IdempotencyConflict, PendingActivation, type WorkActivationEnvironment } from '../work/activate.ts';
import { checkZoneConfiguration, checkStoredZoneConfiguration, InvalidZoneConfiguration, ZONE_CONFIG_FORMAT,
  ZONE_LIMITS, ZONE_PROFILE, ZONE_SITE_PUBLICATION_COST, checkZoneSitePublication,
  zonePublishedPageBinding, type ZoneSitePublicationSelection,
  type ZoneConfiguration, type ZoneQueryBlock } from './config-format.ts';
import { activeDefinitionDependenciesGuard } from '../context/definition-state.ts';
import { ZONE_PRESENTATION_PROFILE, ZONE_PRESENTATION_V1_PROFILE, zoneCampaignUses, type ZonePresentation } from './presentation-format.ts';
import { requestNewZoneCampaignRenditions } from './campaign-art.ts';
import type { MediaDependencies } from '../media/commands.ts';
import { readZoneName } from './read-name.ts';
import type { ResourceListing } from '../space/policy.ts';
import type { ContentCore } from '../../../../content/src/core.ts';
import { parseDocument } from '@rezics/document';
import { pinAdmittedZonePageContent } from '../content-publication/publish-admitted.ts';
import { ContentPublicationConflict, settleZonePageContentPublication,
  rejectZonePageContentPublication } from '../content-publication/publish.ts';
import { RevisionNotFound } from '../work/history.ts';
import { checkZoneSitePublishSelection, type ZoneSitePublishSelection } from './config-format.ts';
import { readZoneThemeExecution, type ZoneThemeSelection } from '../presentation/zone-theme.ts';
import { zoneDocumentShowcase, zonePagePresentation, resolveZonePageDocument } from '../presentation/zone-document.ts';
import { WorkReadLimit } from '../work/read-session.ts';
import { realmAttachHeld, realmAttachRequest, ZoneRealmAttachmentDenied } from './realm-attachment.ts';

export class ZoneUnavailable extends Error {}
export class ZoneStale extends Error {}
export class ZoneOfficialDenied extends Error {}
export class ZonePublicationUnavailable extends Error {}

interface ZoneHead {
  zone: string; space: string; navigation: string; revision: string; manifest: string;
  state: 'active' | 'retired'; disclosure: 'public' | 'private';
  spaceVisibility: 'public' | 'private'; listing: ResourceListing;
  defaultRealm?: string; presentation?: string; official?: Record<string, never>;
  /** The steward behind a live cross-Space attachment; absent for a same-Space Realm. */
  attachment?: { by: string; realm: string };
  defaultContext?: { context: string; semanticRevision: string };
  publicationRevision: string | null;
  documentSite: boolean;
}

async function zoneHead(env: WorkActivationEnvironment, zone: string): Promise<ZoneHead> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space ?navigation ?head
    ?manifest ?state ?disclosure ?realm ?presentation ?context ?contextRevision ?official ?spaceDisclosure ?listing ?publication ?spaceProfile ?attachedBy WHERE {
      GRAPH ${iri(GRAPHS.current)} { ${iri(zone)} a rv:Zone ; rv:space ?space ;
        rv:navigation ?navigation ; rv:zoneHead ?head ; rv:zoneState ?state ;
        rv:disclosure ?disclosure .
        ?space a rv:Space ; rv:disclosure ?spaceDisclosure .
        OPTIONAL { ?space rv:listing ?listing }
        OPTIONAL { ?space rv:definitionProfile ?spaceProfile }
        OPTIONAL { ${iri(zone)} rv:defaultRealm ?realm }
        OPTIONAL { ${iri(zone)} rv:realmAttachedBy ?attachedBy }
        OPTIONAL { ${iri(zone)} rv:presentation ?presentation }
        OPTIONAL { ${iri(zone)} rv:official ?official }
        OPTIONAL { ${iri(zone)} rv:sitePublicationHead ?publication }
        OPTIONAL { ${iri(zone)} rv:defaultContext ?context }
        OPTIONAL { ${iri(zone)} rv:defaultContextRevision ?contextRevision } }
      GRAPH ${iri(GRAPHS.revisions)} { ?head a rv:ZoneRevision ;
        rv:component ${iri(zone)} ; rv:manifest ?manifest . }
    } LIMIT 2`);
  const rows = result.results?.bindings ?? [];
  if (rows.length !== 1) throw new ZoneUnavailable('Zone is unavailable');
  const row = rows[0]!;
  if (!row.space?.value || !row.navigation?.value || !row.head?.value
    || !row.manifest?.value || !row.state?.value || !row.disclosure?.value || !row.spaceDisclosure?.value) {
    throw new ZoneUnavailable('Zone head is incomplete');
  }
  if (!!row.context?.value !== !!row.contextRevision?.value) {
    throw new ZoneUnavailable('Zone Context selection is incomplete');
  }
  if (row.official?.value && row.official.value !== 'true') {
    throw new ZoneUnavailable('Official Zone marker differs');
  }
  if (![`${RV}Public`,`${RV}Private`].includes(row.spaceDisclosure.value)
    || !['listed','unlisted'].includes(row.listing?.value ?? 'listed')) throw new ZoneUnavailable('Zone Space visibility is invalid');
  return { zone, space: row.space.value, navigation: row.navigation.value,
    publicationRevision: row.publication?.value ?? null,
    documentSite: row.spaceProfile?.value === 'https://rezics.com/definition/space-zone-v1',
    revision: row.head.value, manifest: row.manifest.value,
    state: row.state.value === `${RV}Retired` ? 'retired' : 'active',
    disclosure: row.disclosure.value === `${RV}Public` ? 'public' : 'private',
    spaceVisibility: row.spaceDisclosure.value === `${RV}Public` ? 'public' : 'private',
    listing: (row.listing?.value ?? 'listed') as ResourceListing,
    ...(row.realm?.value ? { defaultRealm: row.realm.value } : {}),
    ...(row.realm?.value && row.attachedBy?.value
      ? { attachment: { by: row.attachedBy.value, realm: row.realm.value } } : {}),
    ...(row.context?.value && row.contextRevision?.value ? { defaultContext: {
      context: row.context.value, semanticRevision: row.contextRevision.value } } : {}),
    ...(row.presentation?.value ? { presentation: row.presentation.value } : {}),
    ...(row.official?.value === 'true' ? { official: {} } : {}) };
}

export async function readZoneConfiguration(env: WorkActivationEnvironment, zone: string) {
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  const head = await zoneHead(env, zone);
  const stored = await readWorkComponentState(env, head.manifest, zone, ZONE_PROFILE);
  const name = readZoneName(stored.name, stored.language);
  const configuration = stored.configuration;
  const storedPresentation = (configuration as { presentation?: { profile?: string } | string } | undefined)?.presentation;
  const config = configuration && typeof configuration === 'object' && !Array.isArray(configuration)
    ? checkStoredZoneConfiguration(Buffer.from(JSON.stringify(configuration)))
    : checkZoneConfiguration(Buffer.from(JSON.stringify({ format: ZONE_CONFIG_FORMAT,
      zone, space: head.space, navigation: head.navigation, state: head.state,
      disclosure: head.disclosure, budget: { timeMs: ZONE_LIMITS.queryBudgetMs,
        rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [], model: ZONE_PROFILE })));
  if (config.zone !== zone || config.space !== head.space || config.navigation !== head.navigation
    || config.state !== head.state || config.disclosure !== head.disclosure
    || JSON.stringify(config.defaultContext ?? null) !== JSON.stringify(head.defaultContext ?? null)
    || JSON.stringify(config.official ?? null) !== JSON.stringify(head.official ?? null)
    || (typeof config.presentation === 'string' ? config.presentation
      : config.presentation ? (typeof storedPresentation === 'object'
        && storedPresentation?.profile === 'zone-presentation-v1'
        ? ZONE_PRESENTATION_V1_PROFILE : ZONE_PRESENTATION_PROFILE) : undefined) !== head.presentation) {
    throw new ZoneUnavailable('Zone configuration differs from graph head');
  }
  const advancedBase64 = typeof stored.advancedBase64 === 'string' ? stored.advancedBase64 : undefined;
  if (advancedBase64 && config.advanced !== `sha256:${hash(Buffer.from(advancedBase64, 'base64'))}`) {
    throw new ZoneUnavailable('Zone advanced configuration digest differs');
  }
  return { ...head, ...name, configuration: withoutWithdrawnRealm(config, head),
    ...(advancedBase64 ? { advancedBase64 } : {}), cost: { graphReads: 1, objectReads: 2 } };
}

/** Stored configuration is immutable, but the graph head owns the live link: a
 * steward's withdrawal removes it, and every reader then drops the Realm the
 * configuration still names. */
function withoutWithdrawnRealm<T extends { defaultRealm?: string }>(config: T,
  head: Pick<ZoneHead, 'defaultRealm'>): T {
  if (!config.defaultRealm || head.defaultRealm) return config;
  const { defaultRealm: _withdrawn, ...rest } = config;
  return rest as T;
}

/** Read an immutable presentation cut; current heads supply identity and live
 * visibility only. Creation manifests predate the authored configuration shape. */
export async function readZoneRevisionConfiguration(env: WorkActivationEnvironment,
  current: Awaited<ReturnType<typeof readZoneConfiguration>>, revision: string) {
  const rows = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?manifest WHERE {
    GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ZoneRevision ;
      rv:component ${iri(current.zone)} ; rv:manifest ?manifest . }
  } LIMIT 2`, 4096)).results?.bindings ?? [];
  if (rows.length !== 1 || !rows[0]?.manifest?.value) throw new ZoneUnavailable('Published Zone configuration is unavailable');
  const stored = await readWorkComponentState(env, rows[0].manifest.value, current.zone, ZONE_PROFILE);
  const configuration = stored.configuration ? checkStoredZoneConfiguration(Buffer.from(JSON.stringify(stored.configuration)))
    : checkZoneConfiguration(Buffer.from(JSON.stringify({ format: ZONE_CONFIG_FORMAT,
      zone: current.zone, space: current.space, navigation: current.navigation, state: 'active',
      disclosure: stored.disclosure ?? current.disclosure,
      budget: { timeMs: ZONE_LIMITS.queryBudgetMs, rows: ZONE_LIMITS.queryBudgetRows }, queryBlocks: [], model: ZONE_PROFILE })));
  if (configuration.zone !== current.zone || configuration.space !== current.space
    || configuration.navigation !== current.navigation || configuration.state !== 'active') {
    throw new ZoneUnavailable('Published Zone configuration differs from its owner');
  }
  return { configuration: await publishedRealmConfiguration(env, current, configuration),
    ...readZoneName(stored.name, stored.language) };
}

/** A published cut keeps its Realm only while that Realm is still linked: the
 * live default, or one in the Zone's own Space. A cross-Space Realm attached
 * earlier and since withdrawn or replaced never reappears through a publish.
 * Cost: at most one extra exact graph ASK. */
async function publishedRealmConfiguration(env: WorkActivationEnvironment,
  current: Pick<ZoneHead, 'zone' | 'space' | 'defaultRealm'>,
  configuration: ZoneConfiguration): Promise<ZoneConfiguration> {
  const realm = configuration.defaultRealm;
  if (!realm || realm === current.defaultRealm) return configuration;
  if ((await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
    GRAPH ${iri(GRAPHS.current)} { ${iri(realm)} rv:space ${iri(current.space)} } }`, 1024)).boolean === true) {
    return configuration;
  }
  const { defaultRealm: _unlinked, ...rest } = configuration;
  return rest;
}

export interface ZoneRevisionInput {
  zone: string; expectedHead: string; actingSubject: string; idempotencyKey: string;
  operation: 'configure' | 'retire' | 'recover' | 'publish';
  publication?: ZoneSitePublishSelection;
  patch?: { name?: string; language?: string;
    defaultRealm?: string | null; official?: Record<string, never> | null;
    presentation?: ZonePresentation | null;
    defaultContext?: ZoneConfiguration['defaultContext'] | null;
    budget?: ZoneConfiguration['budget']; queryBlocks?: ZoneQueryBlock[];
    advancedBase64?: string | null };
}

export interface ZoneSitePublicationInput extends ZoneSitePublishSelection {
  zone: string; expectedHead: string; actingSubject: string; idempotencyKey: string;
}

export interface ZoneSitePublicationReceipt extends ZoneSitePublicationSelection,
  Pick<CompositionTerminal, 'receipt' | 'admissionId' | 'requestDigest' | 'authorityEpoch'
    | 'scope' | 'dataEpoch' | 'sequence'> {
  outcome: 'succeeded'; zone: string; revision: string; themeRevision: string;
  publishedThemeRevision?: string; publishedThemeActivation?: string;
}

/** Exact historical proof for Content settlement, independent of later republishing
 * or retirement. O(pages), one bounded receipt lookup, no Content body reads. */
export async function readZoneSitePublicationReceipt(env: WorkActivationEnvironment,
  receipt: string): Promise<ZoneSitePublicationReceipt | null> {
  const result = await env.fuseki.query(`PREFIX rv: <${RV}>
    SELECT ?zone ?revision ?routesRevision ?navigationRevision ?themeRevision ?count
      ?admissionId ?digest ?authorityEpoch ?scope ?dataEpoch ?sequence ?binding ?page ?variant ?contentRevision ?language
      ?publishedThemeRevision ?publishedThemeActivation WHERE {
      GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
        rv:outcome rv:Succeeded ; rv:structureOwner ?zone ; rv:structureRevision ?revision ;
        rv:sitePublicationRevision ?revision ; rv:routesRevision ?routesRevision ;
        rv:navigationRevision ?navigationRevision ; rv:themeRevision ?themeRevision ;
        rv:publishedPageCount ?count ; rv:publishedPage ?binding ;
        rv:admissionId ?admissionId ; rv:requestDigest ?digest ; rv:authorityEpoch ?authorityEpoch ;
        rv:admittedScope ?scope ; rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
        OPTIONAL { ${iri(receipt)} rv:publishedThemeRevision ?publishedThemeRevision }
        OPTIONAL { ${iri(receipt)} rv:publishedThemeActivation ?publishedThemeActivation } }
      GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ZoneRevision ; rv:component ?zone ;
        rv:predecessor ?themeRevision ; rv:sitePublicationReceipt ${iri(receipt)} ;
        rv:dataEpoch ?dataEpoch ; rv:sequence ?sequence .
        ?binding rv:sitePublicationRevision ?revision ; rv:page ?page ;
          rv:variant ?variant ; rv:contentRevision ?contentRevision .
        OPTIONAL { ?binding rv:contentLanguage ?language } }
    } ORDER BY STR(?binding) LIMIT ${ZONE_SITE_PUBLICATION_COST.receiptRows}`, ZONE_SITE_PUBLICATION_COST.receiptResponseBytes);
  const rows = result.results?.bindings ?? [];
  if (!rows.length) return null;
  const first = rows[0]!;
  const get = (key: string) => first[key]?.value;
  const metadata = ['zone', 'revision', 'routesRevision', 'navigationRevision', 'themeRevision',
    'count', 'admissionId', 'digest', 'authorityEpoch', 'scope', 'dataEpoch', 'sequence'];
  if (rows.length > ZONE_SITE_PUBLICATION_COST.maxPages
    || metadata.some(key => !get(key) || rows.some(row => row[key]?.value !== get(key)))
    || get('count') !== String(rows.length)
    || get('scope') !== `zone:edit:${get('zone')}`
    || !!get('publishedThemeRevision') !== !!get('publishedThemeActivation')
    || ['publishedThemeRevision', 'publishedThemeActivation'].some(key => rows.some(row => row[key]?.value !== get(key)))
    || get('dataEpoch') !== env.lineage.dataEpoch
    || !/^[1-9][0-9]*$/.test(get('sequence') ?? '')
    || !/^[0-9a-f]{64}$/.test(get('digest') ?? '')
    || receipt !== compositionReceiptIri(get('admissionId')!, 'zone.edit')) {
    throw new ZoneUnavailable('Site publication receipt is incomplete or ambiguous');
  }
  let selection: ZoneSitePublicationSelection;
  try {
    selection = checkZoneSitePublication({ routesRevision: get('routesRevision'),
      navigationRevision: get('navigationRevision'), pages: rows.map(row => ({
        page: row.page?.value, variantId: row.variant?.value,
        revisionId: row.contentRevision?.value.startsWith('urn:rezics:content:revision:')
          ? row.contentRevision.value.slice('urn:rezics:content:revision:'.length) : undefined,
        ...(row.language?.value ? { language: row.language.value } : {}),
      })) });
    if (rows.some((row, index) => row.binding?.value !== zonePublishedPageBinding(
      get('revision')!, selection.pages[index]!.page, selection.pages[index]!.revisionId))) {
      throw new Error('Page binding differs');
    }
  } catch { throw new ZoneUnavailable('Site publication page bindings differ'); }
  return { ...selection, outcome: 'succeeded', receipt, zone: get('zone')!, revision: get('revision')!,
    themeRevision: get('themeRevision')!, admissionId: get('admissionId')!, requestDigest: get('digest')!,
    authorityEpoch: get('authorityEpoch')!, scope: get('scope')!, dataEpoch: get('dataEpoch')!, sequence: get('sequence')!,
    ...(get('publishedThemeRevision') ? { publishedThemeRevision: get('publishedThemeRevision')!,
      publishedThemeActivation: get('publishedThemeActivation')! } : {}) };
}

/** Zone's admitted bundle switch. Content owns admission and custody of its page
 * revisions; this proof records the exact selections, never follows a draft head. */
export async function publishZoneSite(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'activePrincipalId' | 'withOwnerAuthority'>>,
  request: Request, input: ZoneSitePublicationInput, content?: ContentCore,
): Promise<ZoneSitePublicationReceipt & { replayed: boolean }> {
  const { zone, expectedHead, actingSubject, idempotencyKey, ...publication } = input;
  checkZoneSitePublishSelection(publication);
  const result = await changeZoneConfiguration(env, account, access, request, {
    zone, expectedHead, actingSubject, idempotencyKey, operation: 'publish', publication }, undefined, content);
  const terminal = await readZoneSitePublicationReceipt(env, result.receipt);
  if (!terminal || terminal.zone !== zone || terminal.revision !== result.revision) {
    throw new ZoneUnavailable('Site publication receipt is unavailable');
  }
  try {
    for (const page of terminal.pages) {
      await settleZonePageContentPublication(env, content!, zonePagePreparationId(terminal.admissionId, page.revisionId), terminal.receipt);
    }
  } catch { throw new ZonePublicationUnavailable('Site published; Content settlement is unavailable, retry the same request'); }
  return { ...terminal, replayed: result.replayed };
}

function zonePagePreparationId(admissionId: string, revisionId: string) {
  return `content-site-pin:${admissionId}:${revisionId}`;
}

async function rejectCancelledSitePins(env: WorkActivationEnvironment, content: ContentCore,
  input: ZoneRevisionInput, terminal: CompositionTerminal) {
  if (!input.publication || terminal.outcome !== 'cancelled') return;
  try {
    for (const page of input.publication.pages) {
      await rejectZonePageContentPublication(env, content,
        zonePagePreparationId(terminal.admissionId, page.revisionId), {
          receipt: terminal.receipt, admissionId: terminal.admissionId,
          requestDigest: terminal.requestDigest, zone: input.zone, variantId: page.variantId,
          revisionId: page.revisionId, byteDigest: page.byteDigest, contentEpoch: page.contentEpoch,
        });
    }
  } catch { throw new ZonePublicationUnavailable('Site cancelled; Content rejection is unavailable, retry the same request'); }
}

export async function changeZoneConfiguration(env: WorkActivationEnvironment,
  account: Pick<AccountAssertionVerifier, 'verify'>,
  access: Pick<AccessAdmissionRegistry, 'register' | 'claim' | 'recordGraphOutcome'>
    & Partial<Pick<AccessAdmissionRegistry, 'canMarkOfficialZone' | 'activePrincipalId' | 'withOwnerAuthority'
      | 'assertAuthority'>>,
  request: Request, input: ZoneRevisionInput, media?: Pick<MediaDependencies, 'store' | 'objects'>,
  content?: ContentCore) {
  if (input.operation === 'publish') {
    checkZoneSitePublishSelection(input.publication);
    if (input.patch !== undefined) throw new InvalidZoneConfiguration('Site publication cannot patch configuration');
    if (!content) throw new ZonePublicationUnavailable('Content owner is unavailable');
    if (input.publication!.pages.some(page => page.page !== input.zone)) {
      throw new InvalidZoneConfiguration('Every home page variant must belong to this Zone');
    }
  } else if (input.publication !== undefined) {
    throw new InvalidZoneConfiguration('Only site publication may select page revisions');
  }
  await assertGraphAdmissionOpen(env.fuseki, env.lineage);
  if (input.patch?.official !== undefined || input.patch?.defaultRealm !== undefined
    || input.patch?.presentation !== undefined) {
    const before = await readZoneConfiguration(env, input.zone);
    const priorTheme = typeof before.configuration.presentation === 'object'
      ? before.configuration.presentation.official?.theme : undefined;
    const nextTheme = typeof input.patch?.presentation === 'object' && input.patch.presentation
      ? input.patch.presentation.official?.theme : undefined;
    if (input.patch?.official !== undefined
      || (input.patch?.defaultRealm !== undefined && before.configuration.official)
      || (input.patch?.presentation !== undefined && priorTheme !== nextTheme)) {
      const official = await account.verify(request, ['owner:operate']);
      if (!await access.canMarkOfficialZone?.(official, input.actingSubject, input.zone)) {
        throw new ZoneOfficialDenied('Official Zone authority is unavailable');
      }
    }
  }
  const digest = hash(JSON.stringify({ family: 'zone-revision-v1', ...input,
    idempotencyKey: undefined }));
  const principal = await account.verify(request, ['zone:edit']);
  const scope = `zone:edit:${input.zone}`;
  const registered = await access.register({ principal, actingSubject: input.actingSubject,
    scope, action: 'zone.edit', idempotencyKey: input.idempotencyKey, requestDigest: digest });
  const run = async () => {
  let renditionRequest: { configuration: ZoneConfiguration; uses: string[] } | undefined;
  let admission = registered;
  if (registered.state !== 'sealed' && registered.dispatchEligible) {
    try { admission = await access.claim(registered.id, digest, principal); }
    catch (error) {
      if (!(error instanceof AdmissionDenied || error instanceof AdmissionExpired)) throw error;
    }
  }
  if (admission.state !== 'sealed' && (!admission.dispatchEligible || admission.state === 'registered')) {
    await sealStructureAdmissionCancellation(env, admission);
  } else if (admission.state !== 'sealed'
    && !await readCompositionReceipt(env, admission.id, admission.action)) {
    const invalid = async (error: InvalidZoneConfiguration): Promise<never> => {
      const cancelled = await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id, cancelled);
      throw error;
    };
    const head = await readZoneConfiguration(env, input.zone);
    if (head.revision !== input.expectedHead) {
      await sealStructureAdmissionCancellation(env, admission);
      await access.recordGraphOutcome(admission.id,
        (await readCompositionReceipt(env, admission.id, admission.action))!);
      throw new ZoneStale('Zone head changed');
    }
    if (input.operation === 'retire' && head.state !== 'active'
      || input.operation === 'recover' && head.state !== 'retired'
      || (input.operation === 'configure' || input.operation === 'publish') && head.state !== 'active') {
      return invalid(new InvalidZoneConfiguration('Zone state transition is invalid'));
    }
    if (input.publication) {
      // Routes are mount qualifiers in the navigation Structure. Both cuts name
      // its current immutable revision; a separate route store would lose that cut.
      if (input.publication.routesRevision !== input.publication.navigationRevision) {
        return invalid(new InvalidZoneConfiguration('Routes and navigation must select the same Structure revision'));
      }
      const available = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(head.navigation)} a rv:Structure ;
          rv:structureOf ${iri(input.zone)} ; rv:structureHead ${iri(input.publication.navigationRevision)} . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(input.publication.navigationRevision)}
          a rv:StructureRevision ; rv:component ${iri(head.navigation)} . }
      }`, 1024);
      if (available.boolean !== true) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw new ZoneStale('Zone routes or navigation head changed');
      }
    }
    const contentGuards: string[] = [];
    const contentLanguages = new Map<string, string>();
    const contentPositions = new Map<string, { dataEpoch: string; sequence: string }>();
    if (input.publication && content) {
      const owner = await content.ownerPosition();
      // Preflight the whole selection before creating any pin. Read permission
      // comes from the claimed Zone admission; foreign bytes never enter this path.
      for (const page of input.publication.pages) {
        if (page.contentEpoch !== owner.dataEpoch) throw new ContentPublicationConflict('Content owner epoch changed');
        if (await content.owningResourceForRevision(page.revisionId) !== input.zone) {
          throw new RevisionNotFound('Content revision is unavailable');
        }
        const exact = (await content.readExactBatch([page.revisionId], async ids => new Set(ids)))[0];
        if (exact?.status !== 'available') throw new RevisionNotFound('Content revision is unavailable');
        if (exact.reference.variantId !== page.variantId || exact.reference.byteDigest !== page.byteDigest) {
          throw new ContentPublicationConflict('Content revision differs from site selection');
        }
        if (exact.body.document === undefined || parseDocument(exact.body.document).profile !== 'blocks') {
          throw new InvalidZoneConfiguration('A site home requires a Blocks document');
        }
        // Refuse an unsupported producer count or layout before creating a pin.
        // Unknown/invalid Blocks remain valid opaque Content and render fallbacks.
        const document = parseDocument(exact.body.document);
        try {
          if (zoneDocumentShowcase(document)) {
            const presentation = typeof head.configuration.presentation === 'object'
              ? head.configuration.presentation : undefined;
            if (presentation) zonePagePresentation(resolveZonePageDocument(document, presentation, [], []), presentation);
          }
        } catch (error) {
          if (error instanceof WorkReadLimit) throw new InvalidZoneConfiguration(error.message);
          throw error;
        }
      }
      for (const page of input.publication.pages) {
        const prepared = await pinAdmittedZonePageContent(env, content, account, access, request, {
          resourceId: page.page, variantId: page.variantId, revisionId: page.revisionId,
          expectedDigest: page.byteDigest, expectedContentEpoch: page.contentEpoch,
          preparationId: zonePagePreparationId(admission.id, page.revisionId), expectedPublicationHead: null,
          actingSubject: input.actingSubject,
        });
        contentGuards.push(prepared.publicationGuard);
        contentPositions.set(page.revisionId, prepared.position);
        contentLanguages.set(page.revisionId, prepared.reference.language.kind === 'tag'
          ? prepared.reference.language.tag : prepared.reference.language.kind === 'missing' ? 'und' : prepared.reference.language.kind);
      }
    }
    if (input.operation === 'retire') {
      const dependents = await env.fuseki.query(`PREFIX rv: <${RV}> ASK { GRAPH ${iri(GRAPHS.current)} {
        ${iri(head.navigation)} rv:selectedGeneration ?generation .
        ?generation rv:placementCount ?count . FILTER(?count > 0) } }`);
      if (dependents.boolean === true) return invalid(new InvalidZoneConfiguration('Zone still has mounts'));
    }
    const prior = head.configuration;
    const patch = input.patch;
    let name;
    try {
      // An unrelated edit retains metadata. A new name without a writer language is und.
      if (patch?.language !== undefined && patch.name === undefined) {
        throw new InvalidZoneConfiguration('Zone language requires a name');
      }
      name = patch?.name !== undefined ? readZoneName(patch.name, patch.language)
        : readZoneName(head.name ?? undefined, head.name === null ? undefined : head.language);
    } catch (error) {
      if (error instanceof InvalidZoneConfiguration) return invalid(error);
      throw error;
    }
    let advancedBase64 = head.advancedBase64;
    if (patch?.advancedBase64 === null) advancedBase64 = undefined;
    else if (patch?.advancedBase64 !== undefined) {
      const encoded = patch.advancedBase64;
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        || Buffer.from(encoded, 'base64').length > ZONE_LIMITS.advancedBytes) {
        return invalid(new InvalidZoneConfiguration('Zone advanced configuration is invalid'));
      }
      advancedBase64 = encoded;
    }
    let config: ZoneConfiguration;
    try { config = checkZoneConfiguration(Buffer.from(JSON.stringify({ ...prior,
      state: input.operation === 'retire' ? 'retired'
        : input.operation === 'recover' ? 'active' : prior.state,
      ...(patch?.defaultRealm !== undefined
        ? patch.defaultRealm === null ? { defaultRealm: undefined } : { defaultRealm: patch.defaultRealm } : {}),
      ...(patch?.official !== undefined ? { official: patch.official ?? undefined } : {}),
      ...(patch?.presentation !== undefined
        ? patch.presentation === null ? { presentation: undefined } : { presentation: patch.presentation } : {}),
      ...(patch?.defaultContext !== undefined
        ? { defaultContext: patch.defaultContext ?? undefined } : {}),
      ...(patch?.budget ? { budget: patch.budget } : {}),
      ...(patch?.queryBlocks ? { queryBlocks: patch.queryBlocks } : {}),
      advanced: advancedBase64 ? `sha256:${hash(Buffer.from(advancedBase64, 'base64'))}` : undefined,
    }))); }
    catch (error) {
      if (error instanceof InvalidZoneConfiguration) return invalid(error);
      throw error;
    }
    // A Realm in another Space is linked only by an attachment this edit makes,
    // under the Realm steward's own authority. Every refusal reads alike, so a
    // missing, invisible or someone else's Realm cannot be told apart.
    let attach: { realm: string } | undefined;
    // Naming the Realm already attached changes nothing: the record stands as granted.
    const realmPatched = input.operation !== 'publish' && patch?.defaultRealm !== undefined
      && patch.defaultRealm !== head.attachment?.realm;
    if (config.defaultRealm && input.operation !== 'publish') {
      const unavailable = () => invalid(new InvalidZoneConfiguration('default Realm is unavailable'));
      const realm = (await env.fuseki.query(`PREFIX rv: <${RV}> SELECT ?space WHERE { GRAPH ${iri(GRAPHS.current)} {
        ${iri(config.defaultRealm)} a rv:Realm ; rv:space ?space ; rv:realmState rv:Active . } } LIMIT 2`,
      4096)).results?.bindings ?? [];
      if (realm.length !== 1 || !realm[0]?.space?.value) return unavailable();
      if (realm[0].space.value !== head.space) {
        // An official Zone needs a default Realm to stay valid, and a steward may
        // withdraw an attachment at any time: it takes only a Realm of its own Space.
        if (config.official) return unavailable();
        if (head.attachment?.realm !== config.defaultRealm) {
          if (!realmPatched || !await realmAttachHeld(access, realmAttachRequest(principal, input.actingSubject,
            config.defaultRealm))) return unavailable();
          attach = { realm: config.defaultRealm };
        }
      }
    }
    if (config.defaultContext && input.operation !== 'publish') {
      const selected = config.defaultContext;
      const available = await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(selected.context)} a rv:SemanticContext ;
          rv:contextState rv:Active ; rv:disclosure rv:Public . }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(selected.semanticRevision)}
          a rv:ContextSemanticRevision ; rv:component ${iri(selected.context)} . }
        ${activeDefinitionDependenciesGuard(selected.semanticRevision)} }`);
      if (available.boolean !== true) return invalid(new InvalidZoneConfiguration('selected Context is unavailable'));
    }
    if (typeof config.presentation === 'object' && media) {
      const previous = new Set(typeof prior.presentation === 'object'
        ? zoneCampaignUses(prior.presentation.slides) : []);
      renditionRequest = { configuration: config,
        uses: zoneCampaignUses(config.presentation.slides).filter(use => !previous.has(use)) };
    }
    const revision = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const operation = `https://rezics.com/id/${Bun.randomUUIDv7()}`;
    const manifest = prepareComponent(env.objectDirectory, input.zone, { configuration: config,
      ...(name.name !== null ? { name: name.name, language: name.language } : {}),
      ...(advancedBase64 ? { advancedBase64 } : {}) }, ZONE_PROFILE);
    const receipt = compositionReceiptIri(admission.id, admission.action);
    const batch = `urn:rezics:outbox:${hash(receipt)}`;
    const event = `urn:rezics:event:${hash(operation)}`;
    const publication = input.publication;
    // The manifest holds the draft name. Public readers derive both the name
    // and address suffix from this label, so only a bundle switch promotes it
    // after the first publication. Unpublished Zones retain their live label.
    const promotePublicName = !!publication || head.publicationRevision === null;
    const selectedTheme = typeof config.presentation === 'object' ? config.presentation.official?.theme : undefined;
    let themeSelection: ZoneThemeSelection | null = null;
    if (publication && selectedTheme) themeSelection = (await readZoneThemeExecution(env, selectedTheme, input.zone)).selection;
    const publicationFields = publication ? `
      ${iri(receipt)} rv:sitePublicationRevision ${iri(revision)} ;
        rv:routesRevision ${iri(publication.routesRevision)} ;
        rv:navigationRevision ${iri(publication.navigationRevision)} ;
        rv:themeRevision ${iri(input.expectedHead)} ; rv:publishedPageCount ${publication.pages.length} .
      ${themeSelection ? `${iri(receipt)} rv:publishedThemeRevision ${iri(themeSelection.revision)} ;
        rv:publishedThemeActivation ${iri(themeSelection.activation)} .` : ''}
      ${publication.pages.map(page => `${iri(receipt)} rv:publishedPage
        ${iri(zonePublishedPageBinding(revision, page.page, page.revisionId))} .`).join('\n')}` : '';
    // The command endpoint permits only the root receipt subject in its receipt
    // graph. Immutable page bindings live with the publication revision instead.
    const publicationPageTriples = publication ? publication.pages.map(page => {
        const binding = iri(zonePublishedPageBinding(revision, page.page, page.revisionId));
        return `${binding} rv:sitePublicationRevision ${iri(revision)} ;
            rv:page ${iri(page.page)} ; rv:variant ${iri(page.variantId)} ;
            rv:contentRevision ${iri(`urn:rezics:content:revision:${page.revisionId}`)} ;
            rv:byteDigest ${lit(page.byteDigest)} ;
            rv:contentPreparation ${lit(zonePagePreparationId(admission.id, page.revisionId))} ;
            rv:ownerDataEpoch ${lit(contentPositions.get(page.revisionId)!.dataEpoch)} ;
            rv:ownerSequence ${contentPositions.get(page.revisionId)!.sequence} ;
            rv:contentLanguage ${lit(contentLanguages.get(page.revisionId)!)} .`;
      }).join('\n') : '';
    // A steward's withdrawal removes the link without moving the Zone head, so an
    // edit that writes the foreign Realm back must still find the exact record it
    // read. Otherwise it would resurrect a withdrawn Realm with no record to
    // withdraw. Any edit or publish that keeps the Realm carries this guard.
    const linkGuard = head.attachment && config.defaultRealm === head.attachment.realm
      ? `GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:defaultRealm ${iri(head.attachment.realm)} ;
          rv:realmAttachedBy ${iri(head.attachment.by)} ; rv:realmAttachment ?linkedAttachment . }` : '';
    const kind = input.operation === 'retire' ? 'ZoneRetire'
      : input.operation === 'recover' ? 'ZoneRecover' : 'ZoneConfigure';
    // The receipt keeps when this edit attached the Realm. A withdrawal does not
    // need the triple: older attachments predate it and still withdraw.
    const attachedAt = attach ? new Date().toISOString() : null;
    const update = `PREFIX rv: <${RV}>
      DELETE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?n }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(input.expectedHead)} ;
          rv:zoneState ?oldState ; rv:defaultRealm ?oldRealm ; rv:official ?oldOfficial ;
          ${realmPatched ? 'rv:realmAttachedBy ?oldAttachedBy ; rv:realmAttachment ?oldAttachment ;' : ''}
          rv:presentation ?oldPresentation ;
          rv:defaultContext ?oldContext ; rv:defaultContextRevision ?oldContextRevision .
          ${publication ? `${iri(input.zone)} rv:sitePublicationHead ?oldPublication .` : ''}
          ${promotePublicName ? `${iri(input.zone)} <http://www.w3.org/2000/01/rdf-schema#label> ?oldName .` : ''} } }
      INSERT {
        GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:sequence ?next }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(revision)} ;
          rv:zoneState rv:${config.state === 'active' ? 'Active' : 'Retired'} .
          ${publication ? `${iri(input.zone)} rv:sitePublicationHead ${iri(revision)} .` : ''}
          ${promotePublicName && name.name !== null ? `${iri(input.zone)} <http://www.w3.org/2000/01/rdf-schema#label> ${lit(name.name)}@${name.language} .` : ''}
          ${config.defaultRealm ? `${iri(input.zone)} rv:defaultRealm ${iri(config.defaultRealm)} .` : ''}
          ${attach ? `${iri(input.zone)} rv:realmAttachedBy ${iri(input.actingSubject)} ;
            rv:realmAttachment ${iri(receipt)} .` : ''}
          ${config.official ? `${iri(input.zone)} rv:official true .` : ''}
          ${config.defaultContext ? `${iri(input.zone)} rv:defaultContext ${iri(config.defaultContext.context)} ;
            rv:defaultContextRevision ${iri(config.defaultContext.semanticRevision)} .` : ''}
          ${config.presentation ? `${iri(input.zone)} rv:presentation ${iri(typeof config.presentation === 'string'
            ? config.presentation : ZONE_PRESENTATION_PROFILE)} .` : ''} }
        GRAPH ${iri(GRAPHS.revisions)} { ${iri(revision)} a rv:ZoneRevision, rv:RevisionAnchor ;
          rv:component ${iri(input.zone)} ; rv:predecessor ${iri(input.expectedHead)} ;
          rv:operation ${iri(operation)} ; rv:zoneOperation rv:${kind} ;
          rv:manifest ${iri(`urn:rezics:sha256:${manifest}`)} ;
          rv:modelRevision ${iri(ZONE_PROFILE)} ; rv:shapeRevision ${iri(ZONE_PROFILE)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${publication ? `${iri(revision)} rv:sitePublicationReceipt ${iri(receipt)} .` : ''}
          ${publicationPageTriples} }
        GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} a rv:OperationReceipt ;
          rv:operation ${iri(operation)} ; rv:requestDigest ${lit(digest)} ;
          rv:admissionId ${lit(admission.id)} ; rv:authorityEpoch ${lit(admission.authorityEpoch)} ;
          rv:admittedScope ${lit(scope)} ; rv:outcome rv:Succeeded ;
          rv:structureOwner ${iri(input.zone)} ; rv:structureRevision ${iri(revision)} ;
          rv:datasetId ${iri(DATASET)} ; rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next .
          ${attachedAt ? `${iri(receipt)} rv:realmAttachedAt ${lit(attachedAt)}^^<http://www.w3.org/2001/XMLSchema#dateTime> .` : ''}
          ${publicationFields} }
        GRAPH ${iri(GRAPHS.outbox)} { ${iri(batch)} a rv:OutboxBatch ;
          rv:dataEpoch ${lit(env.lineage.dataEpoch)} ; rv:sequence ?next ;
          rv:eventCount 1 ; rv:event ${iri(event)} .
          ${iri(event)} a rv:${kind}Event ; rv:ordinal 0 ; rv:action "zone.edit" ;
            rv:receipt ${iri(receipt)} ; rv:operation ${iri(operation)} . }
      }
      WHERE { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:dataEpoch ${lit(env.lineage.dataEpoch)} ;
          rv:routingEpoch ${lit(env.lineage.routingEpoch)} ; rv:sequence ?n . }
        GRAPH ${iri(GRAPHS.current)} { ${iri(input.zone)} rv:zoneHead ${iri(input.expectedHead)} ;
          rv:zoneState ?oldState .
          OPTIONAL { ${iri(input.zone)} rv:defaultRealm ?oldRealm }
          ${realmPatched ? `OPTIONAL { ${iri(input.zone)} rv:realmAttachedBy ?oldAttachedBy }
            OPTIONAL { ${iri(input.zone)} rv:realmAttachment ?oldAttachment }` : ''}
          OPTIONAL { ${iri(input.zone)} rv:official ?oldOfficial }
          OPTIONAL { ${iri(input.zone)} rv:presentation ?oldPresentation }
          OPTIONAL { ${iri(input.zone)} rv:defaultContext ?oldContext }
          OPTIONAL { ${iri(input.zone)} rv:defaultContextRevision ?oldContextRevision }
          ${publication ? `OPTIONAL { ${iri(input.zone)} rv:sitePublicationHead ?oldPublication }
            ${iri(head.navigation)} a rv:Structure ; rv:structureOf ${iri(input.zone)} ;
              rv:structureHead ${iri(publication.navigationRevision)} .` : ''}
          ${promotePublicName ? `OPTIONAL { ${iri(input.zone)} <http://www.w3.org/2000/01/rdf-schema#label> ?oldName }` : ''} }
        ${input.operation === 'retire' ? `GRAPH ${iri(GRAPHS.current)} {
          ${iri(head.navigation)} rv:selectedGeneration ?generation .
          ?generation rv:placementCount 0 . }` : ''}
        ${contentGuards.join('\n')}
        ${linkGuard}
        ${publication ? 'FILTER(?oldState = rv:Active)' : ''}
        ${themeSelection ? `GRAPH ${iri(GRAPHS.current)} { ${iri(selectedTheme!)}
          rv:hostZone ${iri(input.zone)} ; rv:themeActivationHead ${iri(themeSelection.activation)} . }
          GRAPH ${iri(GRAPHS.revisions)} { ${iri(themeSelection.activation)} rv:revision ${iri(themeSelection.revision)} . }
          FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.current)} { ${iri(themeSelection.activation)} rv:revocation ?themeRevocation } }` : ''}
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.control)} { ${iri(DATASET)} rv:restoreHold true } }
        FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.receipts)} { ${iri(receipt)} ?p ?o } }
        BIND(?n + 1 AS ?next) }`;
    const validations = await profileValidations(env.fuseki, 'zone-capability-v1', [
      { shape: `${ZONE_PROFILE}/zone-shape`, focus: [input.zone],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
      { shape: `${ZONE_PROFILE}/revision-shape`, focus: [revision],
        graphs: [GRAPHS.current, GRAPHS.revisions] },
    ]);
    try {
      const commit = () => validatedCommand(env, { receipt, digest, update, validations,
        deadlineMs: 10_000 }, admission);
      // The Realm steward's grant is held through the graph switch, so a
      // withdrawal between the check and the commit cannot slip an attachment in.
      let attachJudged = false;
      const dispatch = !attach ? commit : async () => {
        if (!access.withOwnerAuthority) throw new ZoneRealmAttachmentDenied('Realm attachment authority is unavailable');
        try {
          return await access.withOwnerAuthority(realmAttachRequest(principal, input.actingSubject, attach!.realm),
            () => { attachJudged = true; return commit(); });
        } catch (error) {
          if (error instanceof AdmissionDenied && !attachJudged) throw new ZoneRealmAttachmentDenied('default Realm is unavailable');
          throw error;
        }
      };
      if (publication) {
        if (!access.withOwnerAuthority) throw new ZonePublicationUnavailable('Zone authority is unavailable');
        // Pinning and the graph switch are separate owner effects. Recheck and
        // hold the Zone edit proof during the switch so revocation in between
        // cannot publish a page from a now-denied editor.
        await access.withOwnerAuthority({ principal, actingSubject: input.actingSubject,
          action: 'zone.edit', scope }, dispatch);
      } else await dispatch();
    } catch (error) {
      if (error instanceof AdmissionDenied || error instanceof AdmissionExpired) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw error;
      }
      if (error instanceof ZonePublicationUnavailable) throw error;
      if (error instanceof ZoneRealmAttachmentDenied) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw new InvalidZoneConfiguration('default Realm is unavailable');
      }
      // The receipt resolves an ambiguous graph response.
    }
    if (!await readCompositionReceipt(env, admission.id, admission.action)) {
      const current = await readZoneConfiguration(env, input.zone);
      const navigationChanged = publication && (await env.fuseki.query(`PREFIX rv: <${RV}> ASK {
        GRAPH ${iri(GRAPHS.current)} { ${iri(head.navigation)}
          rv:structureHead ${iri(publication.navigationRevision)} . }
      }`, 1024)).boolean !== true;
      // The head is not the only concurrency token: a withdrawal moves the link alone.
      const linkChanged = head.attachment && config.defaultRealm === head.attachment.realm
        && (current.attachment?.realm !== head.attachment.realm || current.attachment.by !== head.attachment.by);
      if (current.revision !== input.expectedHead || navigationChanged || linkChanged) {
        const cancelled = await sealStructureAdmissionCancellation(env, admission);
        await access.recordGraphOutcome(admission.id, cancelled);
        throw new ZoneStale('Zone head changed');
      }
    }
  }
  const terminal = await readCompositionReceipt(env, registered.id, registered.action);
  if (!terminal) throw new PendingActivation('Zone revision outcome is unknown');
  await access.recordGraphOutcome(registered.id, terminal);
  if (input.publication && content && terminal.outcome === 'cancelled') {
    await rejectCancelledSitePins(env, content, input, terminal);
    throw new AdmissionDenied('Site publication was cancelled');
  }
  terminalResult(terminal, registered);
  if (terminal.owner !== input.zone || terminal.requestDigest !== digest || !terminal.revision) {
    throw new IdempotencyConflict('Zone revision receipt differs from intent');
  }
  // The graph receipt and Access seal are durable before optional media IO.
  // Campaign Uses already request renditions at creation; only legacy publication
  // items newly referenced by this commit need a request here.
  if (media && renditionRequest && typeof renditionRequest.configuration.presentation === 'object') {
    await requestNewZoneCampaignRenditions(media, renditionRequest.configuration.defaultRealm ?? null,
      renditionRequest.configuration.presentation.slides, renditionRequest.uses);
  }
  return { zone: input.zone, revision: terminal.revision, receipt: terminal.receipt,
    replayed: registered.replayed, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
  };
  try { return await run(); }
  catch (error) {
    if (!input.publication || !content) throw error;
    // An uncertain graph switch retains its pins until a terminal receipt is
    // known. All earlier failures can be fenced by the cancellation writer.
    let terminal = await readCompositionReceipt(env, registered.id, registered.action);
    if (!terminal && !(error instanceof PendingActivation)) {
      terminal = await sealStructureAdmissionCancellation(env, registered);
    }
    if (!terminal) throw error;
    await access.recordGraphOutcome(registered.id, terminal);
    if (terminal.outcome === 'cancelled') {
      await rejectCancelledSitePins(env, content, input, terminal);
      throw error;
    }
    terminalResult(terminal, registered);
    if (terminal.owner !== input.zone || terminal.requestDigest !== digest || !terminal.revision) {
      throw new IdempotencyConflict('Zone revision receipt differs from intent');
    }
    return { zone: input.zone, revision: terminal.revision, receipt: terminal.receipt,
      replayed: true, dataEpoch: terminal.dataEpoch, sequence: terminal.sequence };
  }
}
