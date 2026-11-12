export { PageReadError, pageReadError } from './page-read-failure';
import { selectedStreamDocument } from './subject-streams';
import { SubjectArtworkSession } from '../catalogue/subject-artwork/session';
import { subjectCatalogueTagDefinitions } from './subject-catalogue-metadata/index';
import { WorkNamesEntry } from '../catalogue/work-names/entry';
import { GameProfileEntry, gameProfileEntry } from '../catalogue/game-profile-entry';
import { GameOverview } from './work-reading-binding';
import type { GameReaderRead, GameStatement } from '../catalogue/game-reader/model';
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
import { catalogueFileSourceId, fileEvidenceAt } from '../catalogue/catalogue-file-reader/navigation';
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
import { recipePublicationReading } from './recipe-publication/model';
import { releasePublicationReading } from './release-publication/model';
import { agentPublicationReading } from './agent-publication/model';
import { gamePublicationReading } from './game-publication/model';
import { publicationOverlayKind, publicPublicationStatements, type PublicationDefinitions } from './subject-metadata';
import { PeopleProfileEntry } from '../catalogue/people-profile-entry';
import { PersonOverview } from '../catalogue/person-reader/reader';
import { CharacterOverview } from './showcase-people/character';
import { OrganizationOverview } from '../catalogue/organization-reader/overview';
import { ProducerHistoryEntry } from '../catalogue/producer-history/entry';
import { AlbumProfileEntry } from '../catalogue/album-profile-entry';
import { SubjectTermsEntry } from '../catalogue/subject-terms-entry';
import { PublicationEditorEntry } from '../catalogue/publication-editor-entry';
import type { SubjectRead } from '@rezics/client';
import {
  planReads,
  documentRead,
  platformRegistry,
  pickText,
  type CompositionDocument,
  type View,
  type PageContinuation,
} from '@rezics/composition';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { DefaultReaderProvider } from '../../shell/current-reading';
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from 'react';
import { originalLanguage } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import type { RelationDefinition } from '../../subject/relations';
import type { Related, Subject, Summary } from '../../subject/types';
import { accountHref, canonicalRedirect, subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';
import {
  dataComponents,
  PageData,
  pageText,
  PublicationOverlayView,
  StatementReadingBinding,
  SubjectSources,
  SubjectSourcesLink,
  type PageMessages,
} from './data';
import { statementDocument } from './documents';
import { publicSubjectReference, serializeJsonLd, subjectJsonLd } from './jsonld';
import { holderItems } from './overview';
import { layoutComponents, PageHost, PageRoot, pageDefinitions } from './layout';
import { CompositionRender, type PageDocument } from './render';
import { linkClass, linkColor, PlainLink, spoilerLevel, type PageLink } from './shared';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import { boundedProfileRelations, profileRelationWindows, type ViewTab } from './views';
import {
  SubjectCommunityContext,
  SubjectCommunityRefreshContext,
  SubjectCommunityVerificationContext,
} from './subject-community-view';
import type { VerificationConfig } from '../../report/turnstile';
import { subjectUrlForView } from '../../subject/subject-href';
import { ContextNavigation, contextHref } from './context-navigation';
import { candidateContext } from '../../subject/candidates';
import { subjectVisitReturn, withSubjectVisitReturn, zoneVisitReturn } from './subject-visit-navigation';
import { MangaReaderEntry } from './work-reading-binding';
import { isMangaReaderType } from '../catalogue/manga-reader/model';
import { mangaReaderAddress } from '../catalogue/manga-reader/navigation';
import type { WorkFranchiseReadingProps, WorkFranchiseSelection } from './showcase-work';
import { WorkFranchiseOverview } from './showcase-work/overview';
import {
  BookOverviewContext,
  BookOverviewRoot,
  BookOverviewSections,
  bookOverviewDocument,
  isBookOverview,
} from './book-overview';
import { showcaseWorkKind } from './showcase-work/model';
import { WorkConceptTagsRoute } from './showcase-work/tags-view';
import {
  AlbumCurrentVisitReturn,
  CharacterAssociationBridge,
  RecipeCurrentVisitReturn,
  albumCurrentVisitSourceAddress,
  consumeGameClassificationReceipt,
  createAlbumCurrentVisitLink,
  gameClassificationDescriptor,
  mangaObservedOrigin,
  parseRecipeCurrentReturn,
  recipeCorrectionHref,
  recipeCurrentReturnState,
  recipePublicSubjectHref,
  selectSubjectPageProfiles,
  storyArcPublicOrigin,
} from './subject-page-application';
import type {
  AlbumCurrentReading,
  AlbumCurrentVisitOrigin,
  GameClassificationReturn,
  GameGroup,
} from './semantic-render-port';

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

import type { SubjectPageData } from './page-model';
export type { SubjectPageData } from './page-model';
import { pageContext } from './page-model';
export { pageContext } from './page-model';
export type { SubjectPageLoad } from './subject-page-load';

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

export { subjectRead, subjectBody } from './subject-read';
import { subjectBody } from './subject-read';

export { loadSubjectPage } from './subject-page-load';

/** Composition relation reads plus admitted item statements, so outgoing publisher, counterpart, cast and staff keep labels. */
export function pageRelationProperties(page: SubjectPageData): string[] {
  const reads = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads;
  const planned = Object.values(reads).flatMap((read) =>
    read.kind === 'links' || read.kind === 'relations' ? [read.property] : [],
  );
  const statements = subjectBody(page)?.subject.statements ?? {};
  const disclosed = Object.entries(statements).flatMap(([property, rows]) =>
    (rows ?? []).some(
      (statement) =>
        isRecord(statement) && isRecord(statement.property) && statement.property.data_type === 'wikibase-item',
    )
      ? [property]
      : [],
  );
  return [...new Set([...planned, ...disclosed])];
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

function validateAlbumReturnAddress(value: unknown, locale: string) {
  return subjectVisitReturn(value, locale);
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
        Object.entries(read.subject.statements).filter(([property, statements]) => {
          if (!statements.some((statement) => statement.property.data_type === 'document')) return true;
          if (documents?.properties.includes(property)) return true;
          return statements.some((statement) => statementDocument(read.subject.id, statement, read.documents));
        }),
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

/** Keep the existing composition-owned identity and its actions, but render it before specialist readers. */
function splitHeaderDocument(document: PageDocument): { header?: PageDocument; remaining: PageDocument } {
  const index = document.content.findIndex((node) => node.type === 'Slot' && node.props.name === 'header');
  if (index < 0) return { remaining: document };
  return {
    header: { ...document, content: [document.content[index]!] },
    remaining: {
      ...document,
      content: [...document.content.slice(0, index), ...document.content.slice(index + 1)],
    },
  };
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

type GameReturnStatus =
  | 'lost'
  | 'changed'
  | 'removed'
  | 'concealed'
  | 'unavailable'
  | 'unknown'
  | 'no-value'
  | 'unsupported';
type GameReturnCheck = { selection?: GameClassificationReturn; status?: GameReturnStatus };

/** Re-admit a return locator against the current public Subject before mounting the reader intent. */
function currentGameReturn(
  page: SubjectPageData,
  descriptor: GameClassificationReturn,
  locale: string,
  realm: string | undefined,
  reader: Reader | undefined,
): GameReturnCheck {
  const read = subjectBody(page);
  if (!read || read.subject.id !== descriptor.holder) return { status: 'changed' };
  if (page.catalogue?.state === 'unavailable') return { status: 'unavailable' };
  const release = page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined;
  if (!release || !page.catalogue?.digest) return { status: 'unsupported' };
  if (
    descriptor.locale !== locale ||
    descriptor.source !==
      `${new URL(descriptor.source, 'https://rezics.invalid').pathname}${new URL(descriptor.source, 'https://rezics.invalid').search}` ||
    descriptor.context !== (page.context?.id ?? read.subject.context) ||
    descriptor.realm !== realm ||
    descriptor.type !== read.subject.type ||
    descriptor.release !== page.catalogue.digest ||
    descriptor.reader !== (page.requestedReader ?? null) ||
    !selectSubjectPageProfiles({
      type: read.subject.type,
      summaryTypes: read.summary?.types,
      definitions: release,
    }).gameReader
  )
    return { status: 'changed' };
  if (!release.properties[descriptor.property]) return { status: 'unknown' };
  if (
    !selectSubjectPageProfiles({
      type: read.subject.type,
      summaryTypes: read.summary?.types,
      definitions: release,
    }).gameGroups.classification.includes(descriptor.property)
  )
    return { status: 'unsupported' };
  const statements = read.subject.statements[descriptor.property] ?? [];
  if (!statements.length) return { status: 'no-value' };
  const statement = statements.find((row) => row.id === descriptor.statement);
  if (!statement) return { status: 'removed' };
  if (spoilerLevel(statement as never) > (reader ?? defaultReader).spoilerLevel) return { status: 'concealed' };
  return { selection: descriptor };
}

function gameReturnMessage(status: GameReturnStatus, locale: string) {
  const o = { locale: locale as never };
  return status === 'lost'
    ? m.game_visit_return_lost({}, o)
    : status === 'changed'
      ? m.game_visit_selection_changed({}, o)
      : status === 'removed'
        ? m.game_visit_selection_removed({}, o)
        : status === 'concealed'
          ? m.game_visit_selection_concealed({}, o)
          : status === 'unavailable'
            ? m.game_visit_selection_unavailable({}, o)
            : status === 'unknown'
              ? m.game_visit_selection_unknown({}, o)
              : status === 'no-value'
                ? m.game_visit_selection_no_value({}, o)
                : m.game_visit_selection_unsupported({}, o);
}

function catalogueTypeIsA(
  definitions: PublicationDefinitions,
  type: string,
  base: string,
  seen = new Set<string>(),
): boolean {
  if (type === base) return true;
  if (!definitions.types[type] || seen.has(type)) return false;
  seen.add(type);
  return (definitions.types[type]?.bases ?? []).some((parent) => catalogueTypeIsA(definitions, parent, base, seen));
}

const expectedGameKinds = {
  platform: ['schema:gamePlatform'],
  engine: ['wdt:P408'],
  language: ['schema:inLanguage'],
  status: ['schema:creativeWorkStatus', 'wdt:P5804', 'rezics:releaseStatus'],
} as const;

/** Feed GameReader from the current anonymous page; editions stay a later continuation. */
export function gamePageInitial(
  subject: Subject,
  related: Related,
  summary: Summary | null | undefined,
  definitions: PublicationDefinitions,
  digest: string,
  locale: string,
  reader: Reader = defaultReader,
): GameReaderRead | undefined {
  const profiles = selectSubjectPageProfiles({
    type: subject.type,
    summaryTypes: summary?.types,
    definitions,
  });
  if (!profiles.gameReader && publicationOverlayKind(subject.type, definitions) !== 'game') return;
  const admitted =
    profiles.gameType &&
    !catalogueTypeIsA(definitions, subject.type, 'wd:Q20631656') &&
    !catalogueTypeIsA(definitions, subject.type, 'wd:Q209163');
  const groups = admitted
    ? (Object.entries(profiles.gameGroups) as [GameGroup, string[]][]).map(([id, properties]) => ({
        id,
        fields: properties.flatMap((property) => {
          const statements = publicPublicationStatements(subject, property, reader, locale);
          if (!statements.length && definitions.properties[property]?.datatype !== 'time') return [];
          return [
            {
              property,
              label: pickText(definitions.properties[property]?.labels ?? {}, locale),
              date: definitions.properties[property]?.datatype === 'time',
              statements: statements as GameStatement[],
            },
          ];
        }),
      }))
    : [];
  const grouped: Extract<GameReaderRead, { ok: true }>['groups'] = [];
  for (const id of ['facts', 'classification', 'credits', 'relations'] as const) {
    const group = groups.find((entry) => entry.id === id);
    if (group?.fields.length) grouped.push({ id, fields: group.fields });
  }
  const unsupported: Extract<GameReaderRead, { ok: true }>['unsupported'] = [];
  for (const kind of ['platform', 'engine', 'language', 'status'] as const)
    if (
      admitted &&
      !expectedGameKinds[kind].some(
        (property) =>
          definitions.types[subject.type]?.properties.includes(property) && definitions.properties[property],
      )
    )
      unsupported.push(kind);
  const publicRead: SubjectRead = composedSubjectRead({
    subject,
    related,
    summary: summary ?? null,
  });
  return {
    ok: true,
    public: publicRead,
    digest,
    admitted,
    grain: pickText(definitions.types[subject.type]?.labels ?? {}, locale),
    groups: grouped,
    unsupported,
    editions: [],
    editionTypes: Object.keys(definitions.types).filter(
      (type) => type === 'wd:Q20631656' || (definitions.types[type]?.bases ?? []).includes('wd:Q20631656'),
    ),
    editionsAdmitted: false,
    next: null,
    caughtUp: true,
    labels: Object.fromEntries(
      Object.entries(definitions.properties).map(([id, property]) => [id, pickText(property.labels, locale)]),
    ),
  };
}

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
  selectedNode,
  selectedStreamProperty,
  selectedStreamDirection,
  selectedCursor,
  onWorkContinue,
  finiteWorkRegionReader: FiniteWorkRegionReader,
  currentHref,
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
  recoverCatalogueFileReader,
  recoverMusicReleaseReader,
  readingAdmission,
  communityQueryKey,
}: {
  page: SubjectPageData;
  communityQueryKey?: readonly unknown[] | undefined;
  verification?: VerificationConfig;
  refreshCommunityAdvice?: () => Promise<void>;
  /** Re-enter the current Subject route loader for catalogue-file recovery. */
  recoverCatalogueFileReader?: () => Promise<void>;
  /** Obtain a newly admitted ordinary Subject source before recovering an edition window. */
  recoverMusicReleaseReader?: () => Promise<void>;
  /** Existing route session identity retires public selections without starting another session read. */
  readingAdmission?: string | undefined;
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
  /** The validated Subject visit return address, when supplied by a Recording journey. */
  returnTo?: string;
  /** Native stream selection carried by the validated Subject view route. */
  selectedNode?: string | undefined;
  selectedStreamProperty?: string | undefined;
  selectedStreamDirection?: 'forward' | 'inverse' | undefined;
  /** Current opaque cursor of that same native stream, when the route continues it. */
  selectedCursor?: string | undefined;
  /** Re-enter the production pages.read route with this node's native continuation. */
  onWorkContinue?: (continuation: PageContinuation) => void;
  /** The route supplies the public grouped consumer without importing its producer entry back into this module. */
  finiteWorkRegionReader?: ComponentType<WorkFranchiseReadingProps>;
  /** This Subject visit's supported address, including search and fragment state. */
  currentHref?: string | undefined;
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
  const semanticProfiles = read
    ? selectSubjectPageProfiles({
        type: read.subject.type,
        summaryTypes: read.summary?.types,
        definitions: page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined,
      })
    : undefined;
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
        context: page.context,
        ...(view !== 'overview' && page.continuation ? { continuation: page.continuation } : {}),
        ...(selectedNode && selectedStreamProperty && selectedStreamDirection
          ? { stream: { node: selectedNode, property: selectedStreamProperty, direction: selectedStreamDirection } }
          : {}),
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
  const currentAddress = currentHref
    ? (() => {
        const url = new URL(currentHref, 'https://rezics.invalid');
        return `${url.pathname}${url.search}${url.hash}`;
      })()
    : '';
  const recipeReturnInput = useMemo(() => parseRecipeCurrentReturn(currentAddress, locale), [currentAddress, locale]);
  const recipeReturn = recipeReturnInput.kind === 'valid' ? recipeReturnInput.value : undefined;
  const recipeReturnState = recipeReturn
    ? recipeCurrentReturnState(
        recipeReturn,
        read && !page.account
          ? {
              subject: { id: read.subject.id, type: read.subject.type },
              context: page.context?.id ?? read.subject.context,
              ...(realm ? { realm } : {}),
              occurrences: Object.entries(read.subject.statements).flatMap(([property, statements]) =>
                statements
                  .filter((statement) => spoilerLevel(statement) <= (reader ?? defaultReader).spoilerLevel)
                  .map((statement) => ({ property, statement: statement.id, holder: read.subject.id })),
              ),
            }
          : undefined,
      )
    : undefined;
  const recipeRestartHref =
    read && !page.account && read.subject.type === 'schema:Recipe'
      ? (() => {
          const identity = { id: read.subject.id, label: subjectPageTitle(page, locale) };
          const context = page.context?.id ?? read.subject.context;
          const returnHref = recipePublicSubjectHref(
            identity,
            locale,
            { context, ...(realm ? { realm } : {}) },
            visitReturn,
          );
          return recipeCorrectionHref(identity, locale, {
            context,
            ...(realm ? { realm } : {}),
            ...(returnHref ? { returnHref } : {}),
          });
        })()
      : undefined;
  const returnDescriptor = gameClassificationDescriptor(currentAddress);
  const descriptorKey = returnDescriptor ? JSON.stringify(returnDescriptor) : '';
  const [receivedGameReturn, setReceivedGameReturn] = useState<
    { address: string; descriptor: GameClassificationReturn; received: boolean } | undefined
  >();
  useEffect(() => {
    if (!currentAddress || !returnDescriptor) {
      consumeGameClassificationReceipt(window.sessionStorage, currentAddress, returnDescriptor);
      setReceivedGameReturn(undefined);
      return;
    }
    setReceivedGameReturn({
      address: currentAddress,
      descriptor: returnDescriptor,
      received: consumeGameClassificationReceipt(window.sessionStorage, currentAddress, returnDescriptor),
    });
  }, [currentAddress, descriptorKey]);
  const received = receivedGameReturn?.address === currentAddress ? receivedGameReturn : undefined;
  const returnCheck: GameReturnCheck | undefined = received
    ? !received.received
      ? { status: 'lost' }
      : received.descriptor.source !== currentAddress.split('#', 1)[0]
        ? { status: 'changed' }
        : currentGameReturn(page, received.descriptor, locale, realm, reader)
    : undefined;
  const gameReturnStatus = returnCheck?.status;
  const gameRestart =
    gameReturnStatus && read && !page.account
      ? gameProfileEntry({
          id: read.subject.id,
          type: read.subject.type,
          label: subjectPageTitle(page, locale),
          locale,
          context: page.context?.id ?? read.subject.context,
          realm,
          release: page.catalogue?.state === 'released' ? page.catalogue.digest : undefined,
          reader: page.requestedReader ?? null,
        })
      : undefined;
  useLayoutEffect(() => {
    if (!gameReturnStatus) return;
    const target =
      document.querySelector<HTMLElement>('[data-game-return-restart]') ??
      document.querySelector<HTMLElement>('[data-game-correction-entry]') ??
      document.querySelector<HTMLElement>('[data-slot="game-reader"] h2') ??
      document.querySelector<HTMLElement>('main h1');
    if (!target) return;
    if (!target.matches('input, select, textarea, button, a')) target.tabIndex = -1;
    target.focus();
  }, [currentAddress, gameReturnStatus]);
  const showcaseWork = read && !page.account ? showcaseWorkKind(read.subject.type, read.summary?.types) : undefined;
  const bookOverview = isBookOverview(read?.subject.type, view, !!page.account);
  const workAddress =
    read && !page.account
      ? subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale)
      : undefined;
  const albumContextId = read ? (page.context?.id ?? read.subject.context) : undefined;
  const albumPopulation = page.context?.population.kind ?? (albumContextId === candidateContext ? 'global' : undefined);
  const albumContext =
    read && albumContextId && albumPopulation
      ? {
          id: albumContextId,
          population: albumPopulation,
          ...(realm ? { realm } : {}),
          ...(page.context?.population.kind === 'realm'
            ? { label: page.context.population.title }
            : albumPopulation === 'global'
              ? { label: m.subject_context_global({}, { locale: locale as never }) }
              : {}),
        }
      : undefined;
  const albumOrigin: AlbumCurrentVisitOrigin | undefined =
    read && read.subject.type === 'schema:MusicAlbum' && albumContext
      ? {
          version: 1,
          subject: { id: read.subject.id, type: 'schema:MusicAlbum', label: subjectPageTitle(page, locale) },
          address: currentHref ? albumCurrentVisitSourceAddress(currentHref) : '',
          locale,
          context: albumContext,
          ...(page.catalogue?.digest ? { release: page.catalogue.digest } : {}),
          ...(page.requestedReader ? { reader: page.requestedReader } : {}),
        }
      : undefined;
  const albumVisit =
    read?.subject.type === 'schema:MusicAlbum'
      ? workAddress
        ? createAlbumCurrentVisitLink(`${workAddress.href}/album`, albumOrigin, locale, validateAlbumReturnAddress)
            .token
        : 'unsupported'
      : undefined;
  const albumCurrent = useMemo<AlbumCurrentReading | undefined>(
    () =>
      read && read.subject.type === 'schema:MusicAlbum' && albumContext
        ? {
            subjectId: read.subject.id,
            locale,
            context: albumContext,
            ...(page.catalogue?.digest ? { release: page.catalogue.digest } : {}),
            ...(page.requestedReader ? { reader: page.requestedReader } : {}),
            address: currentHref ? albumCurrentVisitSourceAddress(currentHref) : '',
          }
        : undefined,
    [
      read?.subject.id,
      read?.subject.type,
      locale,
      albumContext?.id,
      albumContext?.population,
      albumContext?.realm,
      page.catalogue?.digest,
      page.requestedReader,
      currentHref,
    ],
  );
  const workWindows = useMemo(() => (bookOverview ? [] : profileRelationWindows(page)), [page, bookOverview]);
  const workSelection = useMemo<WorkFranchiseSelection | undefined>(() => {
    if (!selectedNode || !selectedStreamProperty || !selectedStreamDirection) return;
    return {
      node: selectedNode,
      property: selectedStreamProperty,
      direction: selectedStreamDirection,
      ...(selectedCursor !== undefined ? { cursor: selectedCursor } : {}),
    };
  }, [selectedNode, selectedStreamProperty, selectedStreamDirection, selectedCursor]);
  const finiteWorkRegionAddress = subjectVisitReturn(currentAddress, locale);
  const finiteWorkRegionRequested = Boolean(
    workSelection &&
    finiteWorkRegionAddress &&
    new URL(finiteWorkRegionAddress, 'https://rezics.invalid').hash.startsWith('#work-franchise'),
  );
  const workReturn = workAddress ? contextHref(workAddress.href, realm) : undefined;
  const workRelationsHref =
    workAddress && page.views?.includes('relations') ? subjectUrlForView(workAddress, 'relations') : undefined;
  const peopleCurrentVisit =
    read?.subject.type === 'schema:Person'
      ? {
          context: page.context?.id ?? read.subject.context,
          ...(page.context?.population.kind === 'realm' ? { realm: page.context.population.id } : {}),
          definition: page.catalogue
            ? page.catalogue.state === 'released'
              ? `released${page.catalogue.digest ? `:${page.catalogue.digest}` : ''}`
              : page.catalogue.state
            : 'absent',
          ...(page.requestedReader ? { reader: page.requestedReader } : {}),
          ...(currentHref ? { sourceAddress: currentHref } : {}),
        }
      : undefined;
  const ContextLink = useMemo(() => {
    const Link = link ?? PlainLink;
    return function SelectedLink(props: ComponentProps<PageLink>) {
      const destination = new URL(props.href, 'https://rezics.invalid');
      // The local File receipt already contains its one source and public Context selector.
      if (fileEvidenceAt(props.href, locale)) return <Link {...props} />;
      const existingReturn = destination.searchParams.get('via');
      const href = subjectVisitReturn(existingReturn, locale)
        ? props.href
        : withSubjectVisitReturn(props.href, literaryReturn ?? mangaReturn ?? visitReturn ?? '', locale);
      return <Link {...props} href={contextHref(href, realm)} />;
    };
  }, [link, locale, literaryReturn, mangaReturn, realm, visitReturn]);
  const releasedDefinitions = page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined;
  const publicationReader = reader ?? defaultReader;
  const recipeReading = read
    ? recipePublicationReading(read.subject, releasedDefinitions, locale, publicationReader)
    : undefined;
  const releaseReading = read
    ? releasePublicationReading(read.subject, releasedDefinitions, locale, publicationReader)
    : undefined;
  const gameReading = read
    ? gamePublicationReading(read.subject, releasedDefinitions, locale, publicationReader)
    : undefined;
  const agentReading = read
    ? agentPublicationReading(read.subject, releasedDefinitions, locale, publicationReader)
    : undefined;
  const gameInitial =
    read && releasedDefinitions && page.catalogue?.digest
      ? gamePageInitial(
          read.subject,
          read.related,
          read.summary,
          releasedDefinitions,
          page.catalogue.digest,
          locale,
          publicationReader,
        )
      : undefined;
  const factsContext = read ? (page.context?.id ?? read.subject.context) : undefined;
  const factsRealm = page.context?.population.kind === 'realm' ? page.context.population.id : undefined;
  const factsOrigin =
    read && !page.account && factsContext
      ? {
          subject: read.subject.id,
          context: factsContext,
          ...(factsRealm ? { realm: factsRealm } : {}),
          returnHref: contextHref(
            subjectHref({ id: read.subject.id, label: subjectPageTitle(page, locale) }, locale).href,
            factsRealm,
          ),
        }
      : undefined;
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
            <PeopleProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              {...(peopleCurrentVisit ? { currentVisit: peopleCurrentVisit } : {})}
            />
          )}
          {read.subject.type === 'schema:Organization' && (
            <ProducerHistoryEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              context={page.context?.id ?? read.subject.context}
              {...(realm !== undefined ? { realm } : {})}
              {...(currentHref !== undefined ? { currentHref } : {})}
            />
          )}
          {page.views?.includes('credits') && <PeopleProfileEntry work={read.subject.id} locale={locale} />}
          <GameProfileEntry
            id={read.subject.id}
            type={read.subject.type}
            label={subjectPageTitle(page, locale)}
            locale={locale}
            context={page.context?.id ?? read.subject.context}
            {...(realm !== undefined ? { realm } : {})}
            release={page.catalogue?.digest}
            reader={page.requestedReader ?? null}
          />
          <CreateSubjectEntry locale={locale} />
          {read.subject.type === 'wd:Q209163' ? (
            <AddonProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              origin={{
                subject: read.subject.id,
                type: 'wd:Q209163',
                context: page.context?.id ?? read.subject.context,
                definition: page.catalogue?.digest ?? read.subject.release,
                ...(page.context?.population.kind === 'realm' ? { realm: page.context.population.id } : {}),
                returnHref: workReturn ?? '',
              }}
            />
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
              context={page.context?.id ?? read.subject.context}
              realm={page.context?.population.kind === 'realm' ? page.context.population.id : undefined}
              definition={page.catalogue?.digest}
              via={storyArcPublicOrigin({
                id: read.subject.id,
                locale,
                ...(currentHref ? { currentHref } : {}),
                ...(page.context?.population.kind === 'realm' ? { realm: page.context.population.id } : {}),
              })}
            />
          )}
          {read.subject.type === 'wd:Q95074' && (
            <>
              <CharacterProfileEntry
                id={read.subject.id}
                label={subjectPageTitle(page, locale)}
                context={page.context?.id ?? read.subject.context}
                {...(realm !== undefined ? { realm } : {})}
                locale={locale}
              />
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
          <SubjectFactsEntry
            id={read.subject.id}
            label={subjectPageTitle(page, locale)}
            locale={locale}
            origin={factsOrigin}
          />
          {(read.subject.type === 'schema:Book' || read.subject.type === 'schema:BookSeries') && (
            <LiteraryProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              type={read.subject.type}
              locale={locale}
              context={page.context?.id ?? read.subject.context}
              realm={subjectPageRealm(page)}
              source={literaryReturn}
            />
          )}
          {read.subject.type === 'schema:MusicAlbum' && (
            <AlbumProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              visit={albumVisit ?? 'unsupported'}
            />
          )}
          {read.subject.type === 'schema:Recipe' && (
            <RecipeEditorEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              context={page.context?.id ?? read.subject.context}
              {...(realm !== undefined ? { realm } : {})}
              previous={visitReturn}
            />
          )}
          {isScreenType(read.subject.type) && (
            <ScreenProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              context={page.context?.id ?? read.subject.context}
              type={read.subject.type}
              definition={read.subject.release}
              {...(realm ? { realm } : {})}
              {...(currentHref ? { source: currentHref } : {})}
            />
          )}
          {(read.subject.type === 'schema:ComicSeries' || read.subject.type === 'schema:PublicationVolume') && (
            <MangaProfileEntry
              id={read.subject.id}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              origin={mangaObservedOrigin({
                subject: read.subject.id,
                type: read.subject.type as 'schema:ComicSeries' | 'schema:PublicationVolume',
                context: page.context?.id ?? read.subject.context,
                definition: page.catalogue?.digest ?? read.subject.release,
                ...(realm ? { realm } : {}),
                returnHref: workReturn ? `${workReturn}#manga-reader` : '',
              })}
            />
          )}
          <SubjectTermsEntry id={read.subject.id} label={subjectPageTitle(page, locale)} locale={locale} />
          <SubjectChangesLink id={read.subject.id} title={subjectPageTitle(page, locale)} locale={locale} />
        </EditorialEntry>
      </>
    ) : (
      <>
        {existingActions}
        {read && !page.account && realm && (
          <>
            {read.subject.type === 'schema:Person' && peopleCurrentVisit && (
              <PeopleProfileEntry
                id={read.subject.id}
                label={subjectPageTitle(page, locale)}
                locale={locale}
                currentVisit={peopleCurrentVisit}
              />
            )}
            <GameProfileEntry
              id={read.subject.id}
              type={read.subject.type}
              label={subjectPageTitle(page, locale)}
              locale={locale}
              context={page.context?.id ?? read.subject.context}
              {...(realm !== undefined ? { realm } : {})}
              release={page.catalogue?.digest}
              reader={page.requestedReader ?? null}
            />
            {read.subject.type === 'schema:MusicAlbum' && (
              <AlbumProfileEntry
                id={read.subject.id}
                label={subjectPageTitle(page, locale)}
                locale={locale}
                visit={albumVisit ?? 'unsupported'}
              />
            )}
          </>
        )}
      </>
    );
  const jsonLd = overview ? subjectPageJsonLd(page, locale) : undefined;
  // TODO: Let readers customize the offered tabs here; retain canonical views and return addresses.
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
        {...(realm !== undefined ? { realm } : {})}
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
  const selectedDocument = selectedStreamDocument(page.document, page.streams);
  const renderedDocument = useMemo(
    () => (bookOverview ? bookOverviewDocument(selectedDocument) : selectedDocument),
    [bookOverview, selectedDocument],
  );
  const CompositionRoot = bookOverview ? BookOverviewRoot : PageRoot;
  const composition = overview && !framed ? splitHeaderDocument(renderedDocument) : { remaining: renderedDocument };
  const afterHeader = overview ? (
    <>
      {bar}
      {read && !page.account && (showcaseWork || page.catalogue?.state === 'released') && (
        <StatementReadingBinding>
          <WorkConceptTagsRoute
            subject={read.subject}
            related={read.related}
            definitions={subjectCatalogueTagDefinitions(read.subject, page.catalogue)}
            locale={locale}
            {...(realm !== undefined ? { realm } : {})}
            {...(currentHref !== undefined ? { currentHref } : {})}
            spoilerThreshold={(reader ?? defaultReader).spoilerLevel}
          />
        </StatementReadingBinding>
      )}
      {invite}
    </>
  ) : null;
  return (
    <DefaultReaderProvider>
      <SubjectArtworkSession locale={locale}>
        <BookOverviewContext.Provider value={bookOverview}>
          <PageHost actions={page.account ? renderedActions : null} afterHeader={header ? afterHeader : null}>
            <PageData
              artworkSource={page}
              propertyLabels={page.catalogue?.state === 'released' ? page.catalogue.definitions?.properties : undefined}
              locale={locale}
              readingView={view}
              subject={page.subject}
              {...(currentHref !== undefined ? { currentHref } : {})}
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
              {...(realm !== undefined ? { realm } : {})}
              {...(page.viewer && 'state' in page.viewer ? { viewer: page.viewer } : {})}
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
                {composition.header ? (
                  <CompositionRender
                    document={composition.header}
                    definitions={pageDefinitions}
                    components={pageComponents(framed)}
                    root={CompositionRoot}
                  />
                ) : null}
                {overview && recipeReturnInput.kind !== 'absent' && (
                  <RecipeCurrentVisitReturn
                    locale={locale}
                    address={currentAddress}
                    {...(recipeReturn ? { intent: recipeReturn } : {})}
                    {...(recipeReturnState ? { state: recipeReturnState } : {})}
                    {...(recipeReturnInput.kind === 'invalid' ? { invalid: true } : {})}
                    {...(recipeRestartHref ? { restartHref: recipeRestartHref } : {})}
                  />
                )}
                {read && !page.account && read.subject.type === 'schema:MusicAlbum' && (
                  <AlbumCurrentVisitReturn
                    locale={locale}
                    current={albumCurrent}
                    validateAddress={validateAlbumReturnAddress}
                  />
                )}
                {literarySubject && ((!bookOverview && overview) || view === 'contents' || view === 'editions') ? (
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
                    windows={profileRelationWindows(page, { includeAliases: true })}
                    reader={reader ?? defaultReader}
                    view={view}
                    {...(realm !== undefined ? { realm } : {})}
                    continuation={page.continuation}
                    selectedNode={selectedNode}
                    selectedStreamProperty={selectedStreamProperty}
                    selectedStreamDirection={selectedStreamDirection}
                    viewer={page.requestedReader ?? null}
                  />
                ) : null}
                {overview && read && !page.account && recipeReading ? (
                  <PublicationOverlayView
                    reading={{ kind: 'recipe', fields: recipeReading.fields }}
                    subject={read.subject}
                    related={read.related}
                    locale={locale}
                    link={ContextLink}
                    {...(read.documents !== undefined ? { documents: read.documents } : {})}
                  />
                ) : null}
                {overview && read && !page.account && releaseReading ? (
                  <PublicationOverlayView
                    reading={{ kind: 'release', fields: releaseReading.fields }}
                    subject={read.subject}
                    related={read.related}
                    locale={locale}
                    link={ContextLink}
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
                    {...(realm !== undefined ? { realm } : {})}
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
                {overview && !bookOverview && read && !page.account && showcaseWork && workReturn ? (
                  <WorkFranchiseOverview
                    subject={read.subject}
                    windows={workWindows}
                    related={read.related}
                    definitions={relations ?? EMPTY_RELATION_DEFINITIONS}
                    locale={locale}
                    returnTo={workReturn}
                    {...(currentHref !== undefined ? { currentHref } : {})}
                    {...(workRelationsHref ? { relationsHref: workRelationsHref } : {})}
                    readerSpoiler={reader?.spoilerLevel ?? 0}
                    link={ContextLink}
                  />
                ) : null}
                {!overview &&
                read &&
                !page.account &&
                finiteWorkRegionRequested &&
                workReturn &&
                workSelection &&
                FiniteWorkRegionReader ? (
                  <FiniteWorkRegionReader
                    page={page}
                    selection={workSelection}
                    reading={read}
                    definitions={relations ?? EMPTY_RELATION_DEFINITIONS}
                    locale={locale}
                    returnTo={workReturn}
                    {...(currentHref !== undefined ? { currentHref } : {})}
                    {...(workRelationsHref ? { relationsHref: workRelationsHref } : {})}
                    readerSpoiler={reader?.spoilerLevel ?? 0}
                    link={ContextLink}
                    {...(onWorkContinue ? { onContinue: onWorkContinue } : {})}
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
                    {...(realm !== undefined ? { realm } : {})}
                    continuation={page.continuation}
                    viewer={page.requestedReader ?? null}
                    admission={readingAdmission}
                    {...(currentHref !== undefined ? { currentHref } : {})}
                    release={page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined}
                    propertyLabels={
                      page.catalogue?.state === 'released' ? page.catalogue.definitions?.properties : undefined
                    }
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
                      {visitReturn.endsWith('/library/import-vndb#vndb-current-library')
                        ? m.library_vndb_browse_back({}, { locale: locale as never })
                        : zoneVisitReturn(visitReturn, locale)
                          ? m.zone_return({}, { locale: locale as never })
                          : m.recording_reader_return({}, { locale: locale as never })}
                    </a>
                  </p>
                ) : null}
                {overview && read && !page.account && returnSource && returnSource !== read.subject.id ? (
                  <CatalogueFileReturnLink
                    id={returnSource}
                    locale={locale}
                    {...(currentHref !== undefined ? { currentHref } : {})}
                    link={ContextLink}
                  />
                ) : null}
                {overview && read && !page.account ? (
                  <CatalogueFileReaderOverview
                    page={page}
                    public={composedSubjectRead(read)}
                    locale={locale}
                    link={ContextLink}
                    returning={returnSource === read.subject.id}
                    readerSpoiler={reader?.spoilerLevel ?? 0}
                    {...(currentHref !== undefined ? { currentHref } : {})}
                    recoverCurrentPage={recoverCatalogueFileReader}
                  />
                ) : null}
                {!overview && bar}
                {overview && !header && afterHeader}
                {overview &&
                !bookOverview &&
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
                    {...(realm !== undefined ? { realm } : {})}
                  />
                ) : null}
                {overview && gameReturnStatus ? (
                  <div className="space-y-2" data-game-return-status="">
                    <p role="status">{gameReturnMessage(gameReturnStatus, locale)}</p>
                    {gameRestart?.href ? (
                      <a
                        data-game-return-restart=""
                        className={`${linkClass} ${linkColor} inline-flex min-h-11 items-center underline underline-offset-4`}
                        href={gameRestart.href}
                      >
                        {m.game_visit_return({}, { locale: locale as never })}
                      </a>
                    ) : null}
                  </div>
                ) : null}
                {overview && read && !page.account && semanticProfiles?.gameReader ? (
                  <GameOverview
                    source={page}
                    reader={page.requestedReader ?? null}
                    id={read.subject.id}
                    type={read.subject.type}
                    context={page.context?.id ?? read.subject.context}
                    locale={locale}
                    {...(realm !== undefined ? { realm } : {})}
                    spoiler={reader?.spoilerLevel}
                    {...(returnCheck?.selection ? { returnSelection: returnCheck.selection } : {})}
                    sessionObservation={readingAdmission ?? ''}
                    {...(gameInitial ? { initial: gameInitial } : {})}
                  />
                ) : null}
                {overview && read && !page.account && !semanticProfiles?.gameReader && gameReading ? (
                  <PublicationOverlayView
                    reading={{ kind: 'game', fields: gameReading.fields }}
                    subject={read.subject}
                    related={read.related}
                    locale={locale}
                    link={ContextLink}
                  />
                ) : null}
                {overview &&
                read &&
                !page.account &&
                read.subject.type !== 'schema:Person' &&
                read.subject.type !== 'schema:Organization' &&
                agentReading ? (
                  <PublicationOverlayView
                    reading={{ kind: 'agent', fields: agentReading.fields }}
                    subject={read.subject}
                    related={read.related}
                    locale={locale}
                    link={ContextLink}
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
                      {...(realm !== undefined ? { realm } : {})}
                    />
                  </>
                ) : null}
                {overview && read && !page.account && musicReleaseEntry(read.subject.type, read.summary?.types) ? (
                  <MusicReleaseOverview
                    recoverCurrentPage={recoverMusicReleaseReader}
                    source={page}
                    reader={page.requestedReader ?? null}
                    id={read.subject.id}
                    context={page.context?.id ?? read.subject.context}
                    locale={locale}
                    {...(realm !== undefined ? { realm } : {})}
                  />
                ) : null}
                {overview && read && !page.account && read.subject.type === recordingType ? (
                  <RecordingOverview
                    locale={locale}
                    public={composedSubjectRead(read)}
                    bounds={boundedProfileRelations(page)}
                    {...(page.context ? { context: page.context } : {})}
                    {...(visitReturn ? { returnTo: visitReturn } : {})}
                    {...(currentHref ? { currentHref } : {})}
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
                    {...(realm !== undefined ? { realm } : {})}
                  />
                ) : null}
                {overview && read && !page.account && isScreenType(read.subject.type) ? (
                  <ScreenProfileOverview
                    locale={locale}
                    public={composedSubjectRead(read)}
                    bounds={boundedProfileRelations(page)}
                    link={ContextLink}
                    {...(page.context?.id ? { context: page.context.id } : {})}
                    {...(realm ? { realm } : {})}
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
                    {...(realm !== undefined ? { realm } : {})}
                    link={ContextLink}
                    public={composedSubjectRead(read)}
                    release={page.catalogue?.state === 'released' ? page.catalogue.definitions : undefined}
                    documents={read.documents}
                    preferences={reader ?? defaultReader}
                    currentHref={workReturn}
                    returnTo={visitReturn}
                  />
                ) : null}
                <SubjectCommunityRefreshContext.Provider value={refreshCommunityAdvice}>
                  <SubjectCommunityContext.Provider
                    value={page.community ? { ...page.community, queryKey: communityQueryKey } : undefined}
                  >
                    <SubjectCommunityVerificationContext.Provider value={verification}>
                      {bookOverview ? (
                        <BookOverviewSections>
                          <CompositionRender
                            document={composition.remaining}
                            definitions={pageDefinitions}
                            components={pageComponents(framed)}
                            root={CompositionRoot}
                          />
                        </BookOverviewSections>
                      ) : (
                        <CompositionRender
                          document={composition.remaining}
                          definitions={pageDefinitions}
                          components={pageComponents(framed)}
                          root={CompositionRoot}
                        />
                      )}
                    </SubjectCommunityVerificationContext.Provider>
                  </SubjectCommunityContext.Provider>
                </SubjectCommunityRefreshContext.Provider>
                <CharacterAssociationBridge source={page}>
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
                  {overview && !bookOverview && connections}
                </CharacterAssociationBridge>
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
        </BookOverviewContext.Provider>
        {renderJsonLd && jsonLd !== undefined && (
          <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
        )}
      </SubjectArtworkSession>
    </DefaultReaderProvider>
  );
}
