import { SubjectArtworkSession } from '../catalogue/subject-artwork/session';
import { supportsReleasedWorkNames } from '../catalogue/work-names/model';
import { WorkNamesEntry } from '../catalogue/work-names/entry';
import { GameProfileEntry } from '../catalogue/game-profile-entry';
import { GameOverview } from '../catalogue/game-reader/entry';
import { gameReaderEntry } from '../catalogue/game-reader/model';
import { EditorialEntry } from '../catalogue/editorial-entry';
import { AddonProfileEntry } from '../catalogue/addon-profile-entry';
import { SubjectFactsEntry } from '../catalogue/subject-facts-entry';
import { SubjectChangesLink } from '../catalogue/subject-changes-link';
import type { PublicFigure } from './subject-ratings';
import { CreateSubjectEntry } from '../catalogue/create-subject-entry';
import { AuthoredFieldEntry } from '../catalogue/authored-field-entry';
import { RecipeEditorEntry } from '../catalogue/recipe-editor-entry';
import { CharacterProfileEntry } from '../catalogue/character-profile-entry';
import { CharacterRelationshipsEntry } from '../catalogue/character-relationships/entry';
import { ScreenProfileEntry } from '../catalogue/screen-profile-entry';
import { ScreenProfileOverview } from '../catalogue/screen-profile-reader';
import { CatalogueFileReaderOverview, CatalogueFileReturnLink } from '../catalogue/catalogue-file-reader/reader';
import { catalogueFileSourceId } from '../catalogue/catalogue-file-reader/navigation';
import { isScreenType } from '../catalogue/screen-profile';
import { composedSubjectRead } from '../catalogue/music-reader';
import { MusicAlbumOverview } from '../catalogue/music-reader-view';
import { MusicReleaseOverview } from '../catalogue/music-release-reader/entry';
import { musicReleaseEntry } from '../catalogue/music-release-reader/model';
import { MusicLocationOverview } from '../catalogue/music-location-reader/entry';
import { musicLocationEntry } from '../catalogue/music-location-reader/model';
import { AlbumTrackOverview } from '../catalogue/album-track-reader/entry';
import { StoryArcOverview } from '../catalogue/story-arc-reader/entry';
import { RecordingOverview } from '../catalogue/recording-reader/overview';
import { recordingType } from '../catalogue/recording-reader/model';
import { StoryArcProfileEntry } from '../catalogue/story-arc-profile-entry';
import { MangaProfileEntry } from '../catalogue/manga-profile-entry';
import { LiteraryProfileEntry } from '../catalogue/literary-profile-entry';
import { LiteraryReaderEntry } from '../catalogue/literary-reader/entry';
import { literaryGrain, literaryReaderType } from '../catalogue/literary-reader/model';
import { literaryAddress } from '../catalogue/literary-reader/navigation';
import { PeopleProfileEntry } from '../catalogue/people-profile-entry';
import { PersonOverview } from '../catalogue/person-reader/reader';
import { CharacterOverview } from './showcase-people/character';
import { OrganizationOverview } from '../catalogue/organization-reader/overview';
import { ProducerHistoryEntry } from '../catalogue/producer-history/entry';
import { AlbumProfileEntry } from '../catalogue/album-profile-entry';
import { SubjectTermsEntry } from '../catalogue/subject-terms-entry';
import { PublicationEditorEntry } from '../catalogue/publication-editor-entry';
import type { SubjectRead, KernelClient } from '@rezics/client';
import type { Release, ReleasedRelationDirectionResult } from '@rezics/definitions';
import {
  planReads,
  documentRead,
  platformRegistry,
  type CompositionDocument,
  type View,
  type SelectedContext,
  type PageContinuation,
} from '@rezics/composition';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { requestLanguages } from '../../kernel/languages.ts';
import { originalLanguage } from '../../subject/language';
import { accountOf } from './account-read';
import { defaultReader, type Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject, Summary } from '../../subject/types';
import { accountHref, canonicalRedirect, subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import { dataComponents, PageData, pageText, SubjectSources, SubjectSourcesLink, type PageMessages } from './data';
import { publicSubjectReference, serializeJsonLd, subjectJsonLd } from './jsonld';
import { holderItems } from './overview';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender, type PageDocument } from './render';
import { linkClass, linkColor, PlainLink, type PageLink } from './shared';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import { boundedProfileRelations, profileRelationWindows, type ViewTab } from './views';
import type { SubjectCommunity } from './subject-community';
import {
  SubjectCommunityContext,
  SubjectCommunityRefreshContext,
  SubjectCommunityVerificationContext,
} from './subject-community-view';
import type { VerificationConfig } from '../../report/turnstile';
import { subjectUrlForView } from '../../subject/subject-href';
import { ContextNavigation, contextHref } from './context-navigation';
import { candidateContext } from '../../subject/candidates';
import { subjectVisitReturn, withSubjectVisitReturn } from './subject-visit-navigation';
import { MangaReaderEntry } from '../catalogue/manga-reader/entry';
import { isMangaReaderType } from '../catalogue/manga-reader/model';
import { mangaReaderAddress } from '../catalogue/manga-reader/navigation';
import { WorkFranchiseOverview } from './showcase-work/overview';
import { showcaseWorkKind } from './showcase-work/model';
import { SubjectConceptTags } from './subject-slots';

const subjectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function FramedIdentity() {
  return null;
}
function createPageComponents() {
  // Candidate value readers can enter through data -> overview -> community -> subject.
  // Resolve the registries on first render, after that import cycle has initialized.
  const page = { ...layoutComponents, ...dataComponents };
  return { page, framed: { ...page, SubjectHeader: FramedIdentity, AccountIdentity: FramedIdentity } };
}
let componentSets: ReturnType<typeof createPageComponents> | undefined;
const EMPTY_RELATION_DEFINITIONS: Record<string, RelationDefinition> = {};
function pageComponents(framed: boolean) {
  componentSets ??= createPageComponents();
  return framed ? componentSets.framed : componentSets.page;
}

export type SubjectPageData = {
  /** The subject the page is for; an agent page always has one, a route page none. */
  subject: string | null;
  /** The account an agent page is for, as the page read named it. */
  account?: { id: string; handle: string };
  context?: SelectedContext | undefined;
  /** The requested selector survives a native Global fallback without inventing Realm metadata. */
  requestedRealm?: string | undefined;
  /** BFF cache identity of this reading; never native read authority. */
  requestedReader?: string | null | undefined;
  continuation?: PageContinuation | undefined;
  community?: SubjectCommunity;
  profile: string;
  template: { scope: 'base' | 'generic' | 'route' | 'type'; key: string | null };
  document: PageDocument;
  /** The views the subject's templates define; absent when the kernel did not say. */
  views?: string[];
  /** Bounded active file/group vocabulary carried by the native page response. */
  catalogue?: {
    state: 'released' | 'unsupported' | 'unavailable';
    type: string;
    digest?: string;
    definitions?: Pick<Release, 'types' | 'properties'>;
    directions?: ReleasedRelationDirectionResult[];
  };
  /** Caller-bound native action state; page responses containing it are private and no-store. */
  viewer?: {
    state: 'anonymous' | 'account';
    account?: string;
    context: string;
    actions: { statementPropose: 'allowed' | 'denied' | 'unavailable' };
  };
  /** Native Access envelope for the selected subject; private and no-store with viewer. */
  actions?:
    | { status: 'ready'; viewerActions: { action: string; operations: string[] }[] }
    | { status: 'withheld' }
    | { status: 'unavailable' }
    | { status: 'denied' };
  /** Optional current Terms operation advice, independent of public names and subject-level actions. */
  termsAuthority?: import('../catalogue/subject-terms').TermsPageAuthority;
  reads: Record<string, { status: number; body: unknown; retryAt?: number; headers?: Record<string, string> }>;
};

export type SubjectPageLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData };

export type SubjectActionsInput = { id: string; type: string; locale: string };

/** The canonical document redirect for a verified agent's subject address. */
export function subjectAccountRedirect(locale: string, handle: string, view?: View, search = '') {
  // Retain the native redirect adapter's exported shape; website routes use canonicalRedirect's 301.
  const { href, statusCode } = canonicalRedirect(accountHref(locale, handle, view), search, '', 308);
  return { href, statusCode };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether the template places a node of this type anywhere, including inside slots. */
function placesType(content: readonly unknown[], type: string): boolean {
  return content.some(
    (node) =>
      isRecord(node) &&
      (node.type === type ||
        (isRecord(node.props) &&
          Object.values(node.props).some((value) => Array.isArray(value) && placesType(value, type)))),
  );
}

export class PageReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: string,
  ) {
    super(message);
  }
}

function retryAfterHeader(headers: unknown): string | undefined {
  if (headers == null) return;
  try {
    const value = new Headers(headers as HeadersInit).get('retry-after');
    return value?.trim() ? value : undefined;
  } catch {
    return;
  }
}

function problemError(value: unknown, status: number, headers?: unknown): Error {
  const code = isRecord(value) && typeof value.code === 'string' && value.code ? value.code : 'internal_error';
  const retryAfter = retryAfterHeader(headers);
  return retryAfter ? new PageReadError(code, status, retryAfter) : new PageReadError(code, status);
}

/** The context the page's reads are planned in. */
export function pageContext(page: Pick<SubjectPageData, 'subject' | 'account' | 'context' | 'continuation'>) {
  return {
    subject: page.subject,
    account: page.account ?? null,
    ...(page.context ? { context: page.context } : {}),
    ...(page.continuation ? { continuation: page.continuation } : {}),
  };
}

/** A successful planned projection must name the page's already admitted Subject. */
export function subjectRead(page: SubjectPageData): { subject: Subject; body: Record<string, unknown> } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (
    result?.status !== 200 ||
    !isRecord(result.body) ||
    !isRecord(result.body.subject) ||
    result.body.subject.id !== page.subject
  )
    return;
  // Merge survivors are admitted by the outer page response and its redirect contract.
  return { subject: result.body.subject as Subject, body: result.body };
}

/** The subject read planned for this page, with the related data its body consumers require. */
export function subjectBody(page: SubjectPageData):
  | {
      subject: Subject;
      account?: SubjectRead['account'];
      related: Related;
      documents?: unknown;
      summary?: Summary | null;
    }
  | undefined {
  const read = subjectRead(page);
  if (!read || !isRecord(read.body.related)) return;
  return {
    subject: read.subject,
    related: read.body.related as Related,
    documents: read.body.documents,
    ...(Object.hasOwn(read.body, 'account') ? { account: read.body.account as SubjectRead['account'] } : {}),
    ...(Object.hasOwn(read.body, 'summary')
      ? { summary: (read.body.summary as Summary | null | undefined) ?? null }
      : {}),
  };
}

/** One `pages.read` of the overview, or of the named view. A merged subject names its survivor; an unknown one is missing. */
export async function loadSubjectPage(
  client: KernelClient,
  id: string,
  view?: View,
  locale = 'en',
  options: {
    realm?: string | undefined;
    continuation?: PageContinuation | undefined;
    authorization?: string | undefined;
  } = {},
): Promise<SubjectPageLoad> {
  if (!subjectIdPattern.test(id)) return { kind: 'missing' };
  const result = await client.pages.$read.post(
    {
      target: { subject: id, ...(view ? { view } : {}), ...(options.realm ? { realm: options.realm } : {}) },
      ...(options.continuation ? { continuation: options.continuation } : {}),
      languages: requestLanguages(locale),
    },
    {
      fetch: { redirect: 'manual' },
      ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
    },
  );
  if (result.status === 404) return { kind: 'missing' };
  if (result.status === 308) {
    const body = result.data ?? result.error?.value;
    if (isRecord(body) && 'redirect' in body && isRecord(body.redirect) && typeof body.redirect.to === 'string')
      return { kind: 'redirect', id: body.redirect.to, target: 'account' };
  }
  if (result.status === 200 && result.data) {
    if (typeof result.data.account === 'string') {
      const raw = {
        ...result.data,
        account: { id: result.data.account, handle: '' },
      } as SubjectPageData;
      const reads = planReads(platformRegistry, raw.document as CompositionDocument, pageContext(raw)).reads;
      for (const [key, read] of Object.entries(reads)) {
        if (read.kind !== 'account' || raw.reads[key]?.status !== 200) continue;
        // Account descriptors select by handle, which this envelope does not carry.
        // The native profile's immutable ID binds the planned slot to the admitted account.
        const profile = accountOf(raw.reads[key]?.body);
        if (profile?.id === result.data.account && subjectIdPattern.test(profile.id) && profile.handle)
          return { kind: 'redirect', id: profile.handle, target: 'account' };
      }
      // An absent, handleless or foreign profile supplies no admitted public @ address.
      const { account: _account, ...catalogue } = result.data;
      if (catalogue.subject !== id || (options.realm && !catalogue.context))
        throw new PageReadError('dependency_unavailable', 503);
      return { kind: 'page', page: { ...catalogue, subject: id, requestedRealm: options.realm } };
    }
    const survivor = result.data.subject;
    if (typeof survivor === 'string' && survivor !== id) return { kind: 'redirect', id: survivor };
    if (options.realm && !result.data.context) throw new PageReadError('dependency_unavailable', 503);
    const { account: _account, ...page } = result.data;
    // Read the existing mounted Terms authority resource once, alongside this page reading.
    // An advice outage must never fail or conceal the admitted public page.
    const reading = subjectBody(page as SubjectPageData);
    const eligible = reading && page.catalogue?.state === 'released' && supportsReleasedWorkNames(reading.subject.type, page.catalogue.definitions);
    const termsAuthority = eligible
      ? await (await import('../catalogue/subject-terms-request')).readTermsPageAuthority(client, options.authorization ? 'signed-in' : 'signed-out', options.authorization)
      : undefined;
    return { kind: 'page', page: { ...page, subject: page.subject ?? null, requestedRealm: options.realm, ...(termsAuthority ? { termsAuthority } : {}) } };
  }
  throw problemError(result.error?.value, result.status, result.headers);
}

/** The properties the page's inverse reads follow, for the definitions that label them. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  return [
    ...new Set(
      Object.values(reads).flatMap((read) =>
        read.kind === 'links' || read.kind === 'relations' ? [read.property] : [],
      ),
    ),
  ];
}

/** The subject's label, chosen with the same fallback the page heading uses. */
export function subjectPageTitle(page: SubjectPageData, locale: string): string {
  const read = subjectBody(page);
  return read ? subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject)) : '';
}

/** The same localized display label used by a rendered subject page, from its labels and original language. */
export function subjectDisplayLabel(labels: Record<string, string>, locale: string, original?: string): string {
  return pageText(labels, locale, original).text || m.subject_value_unlabelled({}, { locale: locale as never });
}

/** The subject's type CURIE, when its read succeeded. */
export function subjectPageType(page: SubjectPageData): string | undefined {
  return subjectBody(page)?.subject.type;
}

function subjectPageRealm(page: SubjectPageData): string | undefined {
  return page.requestedRealm ?? (page.context?.population.kind === 'realm' ? page.context.population.id : undefined);
}

export function subjectPageJsonLd(
  page: SubjectPageData,
  locale: string,
  options: {
    origin?: string;
    typeLabel?: string;
    schemaOrgType?: string;
    ratings?: { figure: PublicFigure };
  } = {},
): string | undefined {
  const read = subjectBody(page);
  if (!read) return;
  const documents = documentRead(
    page.document as CompositionDocument,
    read.subject.id,
    Object.keys(read.subject.statements),
    page.context?.id,
  );
  const origin = (options.origin ?? 'https://rezics.com').replace(/\/+$/, '');
  const subjectLabel = subjectDisplayLabel(read.subject.labels, locale, originalLanguage(read.subject));
  const href = contextHref(
    subjectHref({ id: read.subject.id, label: subjectLabel }, locale).href,
    subjectPageRealm(page),
  );
  const json = subjectJsonLd({
    subject: {
      ...read.subject,
      statements: Object.fromEntries(
        Object.entries(read.subject.statements).filter(
          ([property, statements]) =>
            !statements.some((statement) => statement.property.data_type === 'document') ||
            documents?.properties.includes(property),
        ),
      ),
    },
    documents: read.documents,
    related: read.related,
    ...(read.summary === undefined ? {} : { summary: read.summary }),
    locale,
    ...(options.origin ? { origin: options.origin } : {}),
    ...(options.typeLabel ? { typeLabel: options.typeLabel } : {}),
    subjectLabel,
    ...(options.schemaOrgType ? { schemaOrgType: options.schemaOrgType } : {}),
    ...(options.ratings && page.context?.population.kind !== 'realm' ? { ratings: options.ratings } : {}),
    url: `${origin}${href}`,
  });
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  // These are inverse properties of visible SubjectLists, never a second lookup or a complete edition inventory.
  const inverse = new Map([
    ['schema:exampleOfWork', 'workExample'],
    ['schema:isPartOf', 'hasPart'],
  ]);
  const inverseItems = new Map<string, Map<string, ReturnType<typeof publicSubjectReference>>>();
  const components = new Map(platformRegistry.components.map((component) => [component.type, component]));
  const visit = (content: readonly unknown[]): void => {
    for (const node of content) {
      if (!isRecord(node) || !isRecord(node.props)) continue;
      const key = typeof node.props.id === 'string' ? plan.nodes[node.props.id] : undefined;
      const planned = key ? plan.reads[key] : undefined;
      const result = key ? page.reads[key] : undefined;
      if (node.type === 'SubjectList' && planned?.kind === 'links' && planned.id === read.subject.id) {
        const property = inverse.get(planned.property);
        if (property && result?.status === 200 && isRecord(result.body)) {
          const limit =
            node.props.paged === true
              ? Number.POSITIVE_INFINITY
              : typeof node.props.limit === 'number' && node.props.limit >= 1
                ? Math.min(node.props.limit, 12)
                : 12;
          const found = holderItems(result.body, limit, locale, 0);
          let items = found?.items ?? [];
          if (node.props.paged === true) {
            const pageItems = new Map<string, (typeof items)[number]>();
            for (const item of items) pageItems.set(item.statement ?? item.id, item);
            items = [...pageItems.values()];
          }
          const propertyItems = inverseItems.get(property) ?? new Map();
          for (const item of items) {
            if (item.gated || propertyItems.has(item.id)) continue;
            propertyItems.set(
              item.id,
              publicSubjectReference(item.id, item.label.text || undefined, item.type, locale, origin),
            );
          }
          if (propertyItems.size) inverseItems.set(property, propertyItems);
        }
      }
      for (const slot of components.get(String(node.type))?.slots ?? []) {
        const children = node.props[slot];
        if (Array.isArray(children)) visit(children);
      }
    }
  };
  visit(page.document.content);
  for (const [property, references] of inverseItems) {
    const existing = Object.hasOwn(json, property)
      ? Array.isArray(json[property])
        ? json[property]
        : [json[property]!]
      : [];
    const seen = new Set(
      existing.flatMap((entry) => (isRecord(entry) && typeof entry['@id'] === 'string' ? [entry['@id']] : [])),
    );
    const values = [...existing];
    let added = false;
    for (const reference of references.values()) {
      const identity = reference['@id'];
      if (typeof identity === 'string' && seen.has(identity)) continue;
      if (typeof identity === 'string') seen.add(identity);
      values.push(reference);
      added = true;
    }
    if (added) json[property] = values;
  }
  return serializeJsonLd(json);
}

/** Whether the template places a slot of this name anywhere in the document. */
function placesSlot(content: readonly unknown[], name: string): boolean {
  return content.some(
    (node) =>
      isRecord(node) &&
      isRecord(node.props) &&
      ((node.type === 'Slot' && node.props.name === name) ||
        Object.values(node.props).some((value) => Array.isArray(value) && placesSlot(value, name))),
  );
}

/** Invite first facts only when the admitted subject and its planned relation reads confirm emptiness. */
function hasOnlyTitle(page: SubjectPageData): boolean {
  const read = subjectBody(page);
  if (
    !read ||
    Object.values(read.subject.statements).some((statements) => statements?.length) ||
    Object.values(read.subject.relationCounts ?? {}).some((count) => count > 0) ||
    Object.values(read.subject.descriptions).some((description) => description.trim())
  )
    return false;
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  return Object.entries(plan.reads).every(([key, planned]) => {
    if ((planned.kind !== 'links' && planned.kind !== 'relations') || planned.id !== page.subject) return true;
    const result = page.reads[key];
    if (result?.status !== 200 || !isRecord(result.body)) return false;
    const body = result.body;
    const rows = planned.kind === 'links' ? body.links : body.relations;
    // Missing/withheld rows, unknown counts and an unfinished page cannot certify a title-only subject.
    return (
      Array.isArray(rows) &&
      rows.length === 0 &&
      body.next === null &&
      isRecord(body.count) &&
      body.count.value === 0 &&
      body.count.exact === true
    );
  });
}

/** The view's name and a way back to the subject, above the tabs of every view but the overview. */
export type ViewHeading = { title: string; label: string; href: string };

/**
 * The template document for one view of a subject, then schema.org JSON-LD for the overview. The host places the
 * view tabs right after the overview's header, or under the view's own heading, and invites the first facts when the
 * subject has only a title.
 */
export function SubjectPage({
  page,
  locale,
  messages,
  link,
  actions,
  nonce,
  renderJsonLd = true,
  reader,
  typeLabel,
  ratio,
  relations,
  view = 'overview',
  returnTo,
  tabs,
  tabLabels,
  heading,
  invitation,
  base,
  operator,
  curation,
  connections,
  subjectLabel,
  framed = false,
  verification,
  fileSource,
  refreshCommunityAdvice,
}: {
  page: SubjectPageData;
  verification?: VerificationConfig;
  refreshCommunityAdvice?: () => Promise<void>;
  /** Mounted native connection readers share this visit’s labels, disclosure and selected Context. */
  connections?: ReactNode;
  /** The current frame's label for list-only documents that do not repeat the subject read. */
  subjectLabel?: string;
  /** The containing view already renders the subject's identity. */
  framed?: boolean;
  /** One validated file identity carried by a disclosed same-locale return link. */
  fileSource?: string | undefined;
  locale: string;
  messages: PageMessages;
  link?: ComponentProps<typeof PageData>['link'];
  actions?: (subject: SubjectActionsInput) => ReactNode;
  nonce?: string;
  renderJsonLd?: boolean;
  /** The reader's spoiler and suitability settings; anonymous readers get the defaults. */
  reader?: Reader;
  /** The subject type's name in the reader's language, from the definitions release. */
  typeLabel?: string;
  /** The cover frame the definitions release declares for the subject's type. */
  ratio?: ComponentProps<typeof PageData>['ratio'];
  /** How each relation property reads on this page, from the definitions release. */
  relations?: Record<string, RelationDefinition>;
  /** The view this document is. */
  view?: View;
  /** The validated single-hop subject visit return address, when supplied by a Recording journey. */
  returnTo?: string;
  /** The views to offer, from `subjectTabs` of the subject's overview. */
  tabs?: readonly ViewTab[];
  tabLabels?: ViewTabLabels;
  /** Required for a view other than the overview. */
  heading?: ViewHeading;
  /** The sentence that invites the first facts of a subject with only a title. */
  invitation?: string;
  /** The address of the overview when it is not the subject's own: an agent's `/@handle`. */
  base?: string;
  operator?: { id: string; handle: string | null; displayName: string | null };
  curation?: ReactNode;
}) {
  const overview = view === 'overview';
  const read = subjectBody(page);
  const visitReturn = subjectVisitReturn(returnTo, locale);
  const mangaSubject = read && !page.account && isMangaReaderType(read.subject.type) ? read.subject : undefined;
  const literarySubject =
    read &&
    !page.account &&
    (literaryReaderType(read.subject.type, read.summary?.types) ||
      literaryGrain(read.subject.type, page.catalogue?.definitions))
      ? read.subject
      : undefined;
  const literaryReturn = literarySubject
    ? literaryAddress({
        id: literarySubject.id,
        label: subjectPageTitle(page, locale),
        locale,
        view,
        realm: subjectPageRealm(page),
        continuation: page.continuation,
      })
    : undefined;
  const mangaReturn = mangaSubject
    ? mangaReaderAddress({
        id: mangaSubject.id,
        label: subjectPageTitle(page, locale),
        locale,
        view,
        realm: subjectPageRealm(page),
        continuation: page.continuation,
      })
    : undefined;
  const returnSource = catalogueFileSourceId(fileSource);
  const existingActions = read && actions ? actions({ id: read.subject.id, type: read.subject.type, locale }) : null;
  const realm = subjectPageRealm(page);
  const showcaseWork = read && !page.account ? showcaseWorkKind(read.subject.type, read.summary?.types) : undefined;
  const workAddress =
    read && !page.account
      ? subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale)
      : undefined;
  const workReturn = workAddress ? contextHref(workAddress.href, realm) : undefined;
  const workRelationsHref =
    workAddress && page.views?.includes('relations') ? subjectUrlForView(workAddress, 'relations') : undefined;
  const ContextLink = useMemo(() => {
    const Link = link ?? PlainLink;
    return function SelectedLink(props: ComponentProps<PageLink>) {
      const existingReturn = new URL(props.href, 'https://rezics.invalid').searchParams.get('via');
      const href = subjectVisitReturn(existingReturn, locale)
        ? props.href
        : withSubjectVisitReturn(props.href, literaryReturn ?? mangaReturn ?? visitReturn ?? '', locale);
      return <Link {...props} href={contextHref(href, realm)} />;
    };
  }, [link, locale, literaryReturn, mangaReturn, realm, visitReturn]);
  const renderedActions =
    read && !page.account && !realm ? (
      <>
        {existingActions}
        <EditorialEntry
          id={read.subject.id}
          label={subjectPageTitle(page, locale)}
          locale={locale}
          context={page.context?.id ?? read.subject.context}
          realm={page.context?.population.kind === 'realm' ? page.context.population.id : undefined}
        >
          {page.views?.includes('editions') && <PublicationEditorEntry work={read.subject.id} locale={locale} />}
          {(read.subject.type === 'schema:Person' || read.subject.type === 'schema:Organization') && (
            <PeopleProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          )}
          {read.subject.type === 'schema:Organization' && (
            <ProducerHistoryEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          )}
          {page.views?.includes('credits') && <PeopleProfileEntry work={read.subject.id} locale={locale} />}
          <GameProfileEntry
            id={read.subject.id}
            type={read.subject.type}
            label={subjectPageTitle(page, locale)}
            locale={locale}
          />
          <CreateSubjectEntry locale={locale} />
          {read.subject.type === 'wd:Q209163' ? (
            <AddonProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          ) : (
            <AddonProfileEntry
              locale={locale}
              {...(read.subject.type === 'schema:VideoGame' ? { work: read.subject.id } : {})}
            />
          )}
          {read.subject.type === 'wd:Q2620972' && (
            <StoryArcProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              realm={page.context?.population.kind === 'realm' ? page.context.population.id : undefined}
            />
          )}
          {read.subject.type === 'wd:Q95074' && (
            <>
              <CharacterProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
              <CharacterRelationshipsEntry
                id={read.subject.id}
                label={subjectPageTitle(page, locale)}
                locale={locale}
              />
            </>
          )}
          {page.views?.includes('characters') && read.subject.type !== 'wd:Q95074' && (
            <CharacterProfileEntry work={read.subject.id} locale={locale} />
          )}
          <AuthoredFieldEntry id={read.subject.id} title={subjectPageTitle(page, locale)} locale={locale} />
          <SubjectFactsEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          {(read.subject.type === 'schema:Book' || read.subject.type === 'schema:BookSeries') && (
            <LiteraryProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              type={read.subject.type}
              locale={locale}
            />
          )}
          {read.subject.type === 'schema:MusicAlbum' &&
            (page.context?.id ?? read.subject.context) === candidateContext && (
              <AlbumProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
            )}
          {read.subject.type === 'schema:Recipe' && (
            <RecipeEditorEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          )}
          {isScreenType(read.subject.type) && (
            <ScreenProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          )}
          {(read.subject.type === 'schema:ComicSeries' || read.subject.type === 'schema:PublicationVolume') && (
            <MangaProfileEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          )}
          <SubjectTermsEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          <SubjectChangesLink id={read.subject.id} title={subjectPageTitle(page, locale)} locale={locale} />
        </EditorialEntry>
      </>
    ) : (
      existingActions
    );
  const jsonLd = overview ? subjectPageJsonLd(page, locale) : undefined;
  const bar =
    tabs && tabLabels && tabs.length > 0 ? (
      <ViewTabs
        tabs={tabs}
        active={view}
        locale={locale}
        base={
          base ??
          heading?.href ??
          subjectHref(
            { id: read?.subject.id ?? page.subject ?? '', label: read ? subjectPageTitle(page, locale) : '' },
            locale,
          ).href
        }
        realm={realm}
        {...(visitReturn ? { returnTo: visitReturn } : {})}
        labels={tabLabels}
      />
    ) : null;
  const invite =
    overview && invitation && hasOnlyTitle(page) ? (
      <Empty data-slot="invitation" className="border p-6">
        <EmptyHeader>
          <EmptyTitle className="sr-only">{invitation}</EmptyTitle>
          <EmptyDescription>{invitation}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : null;
  const header = placesSlot(page.document.content, 'header');
  const afterHeader = overview ? (
    <>
      {bar}
      {read && page.catalogue?.state === 'released' && page.catalogue.definitions && (
        <SubjectConceptTags
          subject={read.subject}
          related={read.related}
          definitions={page.catalogue.definitions}
          locale={locale}
          spoilerThreshold={(reader ?? defaultReader).spoilerLevel}
        />
      )}
      {invite}
    </>
  ) : null;
  return (
    <SubjectArtworkSession locale={locale}>
      <PageHost actions={page.account ? renderedActions : null} afterHeader={header ? afterHeader : null}>
        <PageData
          artworkSource={page}
          locale={locale}
          readingView={view}
          subject={page.subject}
          listTarget={
            page.account
              ? { account: page.account.handle, ...(view ? { view } : {}) }
              : page.subject
                ? {
                    subject: page.subject,
                    ...(view ? { view } : {}),
                    ...(page.context?.population.kind === 'realm' ? { realm: page.context.population.id } : {}),
                  }
                : undefined
          }
          pageTarget={
            page.account
              ? { account: page.account.handle, ...(view ? { view } : {}) }
              : page.subject
                ? {
                    subject: page.subject,
                    ...(view ? { view } : {}),
                    ...(realm ? { realm } : {}),
                  }
                : undefined
          }
          {...(subjectLabel !== undefined ? { subjectLabel } : {})}
          {...(read ? { subjectLabel: subjectPageTitle(page, locale) } : {})}
          {...(page.account ? { account: page.account } : {})}
          {...(operator ? { operator } : {})}
          {...(base ? { base } : {})}
          document={page.document}
          reads={page.reads}
          context={page.context}
          realm={realm}
          {...(page.viewer ? { viewer: page.viewer } : {})}
          {...(page.catalogue?.digest ? { releaseDigest: page.catalogue.digest } : {})}
          cacheReader={page.requestedReader}
          continuation={page.continuation}
          messages={messages}
          link={ContextLink}
          {...(reader ? { reader } : {})}
          {...(typeLabel ? { typeLabel } : {})}
          {...(ratio ? { ratio } : {})}
          {...(relations ? { relations } : {})}
          {...(page.catalogue?.directions !== undefined ? { directions: page.catalogue.directions } : {})}
          {...(!page.account && renderedActions ? { headerActions: renderedActions } : {})}
        >
          <div className="flex w-full flex-col gap-8">
            {literarySubject && (overview || view === 'contents' || view === 'editions') ? (
              <LiteraryReaderEntry
                work={literarySubject}
                related={read!.related}
                source={page}
                locale={locale}
                context={page.context}
                definitions={page.catalogue?.definitions}
                descriptorState={page.catalogue?.state}
                digest={page.catalogue?.digest}
                directions={page.catalogue?.directions}
                windows={profileRelationWindows(page)}
                reader={reader ?? defaultReader}
                view={view}
                realm={realm}
                continuation={page.continuation}
                viewer={page.requestedReader ?? null}
              />
            ) : null}
            {!overview && heading && (
              <header className="min-w-0 space-y-1" data-slot="view-heading">
                <p className="text-sm break-words">
                  <a className={`${linkClass} ${linkColor}`} href={contextHref(heading.href, realm)}>
                    {heading.title}
                  </a>
                </p>
                <h1 className="font-sans text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
                  {heading.label}
                </h1>
              </header>
            )}
            {!page.account && (
              <ContextNavigation
                context={page.context}
                realm={realm}
                href={subjectUrlForView(
                  subjectHref(
                    { id: page.subject ?? '', label: subjectLabel ?? subjectPageTitle(page, locale) },
                    locale,
                  ),
                  view,
                )}
                locale={locale}
              />
            )}
            {overview && read && !page.account && workAddress ? (
              <WorkNamesEntry
                subject={read.subject}
                ancestors={read.summary?.types}
                source={page}
                locale={locale}
                context={page.context?.id ?? null}
                release={page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined}
                releaseDigest={page.catalogue?.digest}
                termsAuthority={page.termsAuthority}
                expectedReader={page.requestedReader}
                link={ContextLink}
                sourcesHref={contextHref(`${workAddress.href}/sources`, realm)}
              />
            ) : null}
            {overview && read && !page.account && showcaseWork && workReturn ? (
              <WorkFranchiseOverview
                subject={read.subject}
                windows={profileRelationWindows(page)}
                related={read.related}
                definitions={relations ?? EMPTY_RELATION_DEFINITIONS}
                locale={locale}
                returnTo={workReturn}
                {...(workRelationsHref ? { relationsHref: workRelationsHref } : {})}
                readerSpoiler={reader?.spoilerLevel ?? 0}
                link={ContextLink}
              />
            ) : null}
            {mangaSubject && (view === 'overview' || view === 'contents' || view === 'editions') ? (
              <MangaReaderEntry
                source={page}
                subject={mangaSubject}
                label={subjectPageTitle(page, locale)}
                locale={locale}
                view={view}
                context={page.context?.id ?? mangaSubject.context ?? null}
                realm={realm}
                continuation={page.continuation}
                viewer={page.requestedReader ?? null}
                definitions={relations ?? EMPTY_RELATION_DEFINITIONS}
                windows={profileRelationWindows(page)}
                reader={reader ?? defaultReader}
                link={ContextLink}
              />
            ) : null}
            {visitReturn && !framed ? (
              <p>
                <a
                  className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center underline underline-offset-4`}
                  href={visitReturn}
                >
                  {m.recording_reader_return({}, { locale: locale as never })}
                </a>
              </p>
            ) : null}
            {overview && read && !page.account && returnSource && returnSource !== read.subject.id ? (
              <CatalogueFileReturnLink id={returnSource} locale={locale} link={ContextLink} />
            ) : null}
            {overview && read && !page.account ? (
              <CatalogueFileReaderOverview
                page={page}
                public={composedSubjectRead(read)}
                locale={locale}
                link={ContextLink}
                returning={returnSource === read.subject.id}
              />
            ) : null}
            {!overview && bar}
            {overview && !header && afterHeader}
            {overview &&
            read &&
            !page.account &&
            (read.subject.type === 'wd:Q2620972' ||
              (read.subject.relationCounts?.['rezics:storyArc'] ?? 0) > 0 ||
              (read.subject.statements['rezics:storyArc']?.length ?? 0) > 0) ? (
              <StoryArcOverview
                source={page}
                reader={page.requestedReader ?? null}
                settings={reader}
                id={read.subject.id}
                context={page.context?.id ?? read.subject.context}
                locale={locale}
                realm={realm}
              />
            ) : null}
            {overview && read && !page.account && gameReaderEntry(read.subject.type, read.summary?.types) ? (
              <GameOverview
                source={page}
                reader={page.requestedReader ?? null}
                id={read.subject.id}
                type={read.subject.type}
                context={page.context?.id ?? read.subject.context}
                locale={locale}
                realm={realm}
                spoiler={reader?.spoilerLevel}
              />
            ) : null}
            {overview && read && !page.account && read.subject.type === 'schema:MusicAlbum' ? (
              <>
                <MusicAlbumOverview
                  source={page}
                  reader={page.requestedReader ?? null}
                  locale={locale}
                  public={composedSubjectRead(read)}
                  bounds={boundedProfileRelations(page)}
                  link={ContextLink}
                />
                <AlbumTrackOverview
                  source={page}
                  reader={page.requestedReader ?? null}
                  id={read.subject.id}
                  context={page.context?.id ?? read.subject.context}
                  locale={locale}
                  realm={realm}
                />
              </>
            ) : null}
            {overview && read && !page.account && musicReleaseEntry(read.subject.type, read.summary?.types) ? (
              <MusicReleaseOverview
                source={page}
                reader={page.requestedReader ?? null}
                id={read.subject.id}
                context={page.context?.id ?? read.subject.context}
                locale={locale}
                realm={realm}
              />
            ) : null}
            {overview && read && !page.account && read.subject.type === recordingType ? (
              <RecordingOverview
                locale={locale}
                public={composedSubjectRead(read)}
                bounds={boundedProfileRelations(page)}
                {...(page.context ? { context: page.context } : {})}
                {...(visitReturn ? { returnTo: visitReturn } : {})}
                link={ContextLink}
              />
            ) : null}
            {overview && read && !page.account && musicLocationEntry(read.subject.type, read.summary?.types) ? (
              <MusicLocationOverview
                source={page}
                reader={page.requestedReader ?? null}
                subject={composedSubjectRead(read)}
                context={page.context?.id ?? read.subject.context}
                locale={locale}
                realm={realm}
              />
            ) : null}
            {overview && read && !page.account && isScreenType(read.subject.type) ? (
              <ScreenProfileOverview
                locale={locale}
                public={composedSubjectRead(read)}
                bounds={boundedProfileRelations(page)}
                link={ContextLink}
                {...(page.context?.id ? { context: page.context.id } : {})}
                viewerKey={page.requestedReader ?? null}
                readerSpoilerLevel={reader?.spoilerLevel ?? 0}
              />
            ) : null}
            {overview && read && !page.account && read.subject.type === 'schema:Organization' ? (
              <OrganizationOverview
                id={read.subject.id}
                context={read.subject.context}
                source={page}
                locale={locale}
                reader={page.requestedReader ?? null}
                realm={realm}
                link={ContextLink}
              />
            ) : null}
            <SubjectCommunityRefreshContext.Provider value={refreshCommunityAdvice}>
              <SubjectCommunityContext.Provider value={page.community}>
                <SubjectCommunityVerificationContext.Provider value={verification}>
                  <CompositionRender
                    document={page.document}
                    definitions={pageDefinitions}
                    components={pageComponents(framed)}
                    root={PageRoot}
                  />
                </SubjectCommunityVerificationContext.Provider>
              </SubjectCommunityContext.Provider>
            </SubjectCommunityRefreshContext.Provider>
            {overview && read && !page.account && read.subject.type === 'wd:Q95074' ? (
              <CharacterOverview
                source={page}
                viewer={page.requestedReader ?? null}
                locale={locale}
                public={composedSubjectRead(read)}
                documents={read.documents}
                release={page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined}
                link={ContextLink}
                {...(reader ? { reader } : {})}
              />
            ) : null}
            {overview && read && !page.account && read.subject.type === 'schema:Person' ? (
              <PersonOverview
                source={page}
                viewer={page.requestedReader ?? null}
                locale={locale}
                public={composedSubjectRead(read)}
                documents={read.documents}
                release={page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined}
                link={ContextLink}
                {...(reader ? { reader } : {})}
              />
            ) : null}
            {overview && connections}
            {overview && !placesType(page.document.content, 'Sources') && <SubjectSources />}
            {overview && <SubjectSourcesLink />}
            {curation}
            {overview && read && !page.account && (
              <a
                className={`${linkClass} ${linkColor}`}
                href={`${subjectUrlForView(subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale), 'context-review')}?${new URLSearchParams({ context: page.context?.id ?? read.subject.context, ...(realm ? { realm } : {}) })}`}
              >
                {m.context_title({}, { locale: locale as never })}
              </a>
            )}
            {overview && read && !page.account && read.subject.context === candidateContext && !realm && (
              <a
                className={`${linkClass} ${linkColor}`}
                href={subjectUrlForView(
                  subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale),
                  'relation-edit',
                )}
              >
                {m.relation_title({}, { locale: locale as never })}
              </a>
            )}
          </div>
        </PageData>
      </PageHost>
      {renderJsonLd && jsonLd !== undefined && (
        <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      )}
    </SubjectArtworkSession>
  );
}
