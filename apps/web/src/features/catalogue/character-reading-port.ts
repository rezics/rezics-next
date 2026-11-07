import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { pickText, type PageRead, type SelectedContext } from '@rezics/composition';
import type { ReleasedRelationDirectionResult } from '@rezics/definitions';
import type { SubjectRead } from '@rezics/client';
import type { Reader } from '../../subject/reader';
import { m } from '../../paraglide/messages.js';

export type LinkProps = {
  href: string;
  lang?: string | undefined;
  className?: string | undefined;
  children: ReactNode;
};
export type PageLink = ComponentType<LinkProps>;
export type Snak = {
  property: { id: string; data_type: string };
  value: { type: string; content?: unknown };
};
export type Stmt = Snak & {
  id: string;
  rank: string;
  qualifiers: Snak[];
  references: { parts: Snak[] }[];
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageText(value: unknown, locale: string, original?: string) {
  const safe = typeof value === 'string' || isRecord(value) ? value : '';
  const picked = pickText(safe as string | Record<string, string>, locale, original);
  return {
    text: typeof picked.text === 'string' ? picked.text : '',
    lang: picked.lang && picked.lang !== locale ? picked.lang : undefined,
  };
}

const SPOILER_PROPERTY = 'rezics:spoilerLevel';

function spoilerLevel(statement: Stmt): number {
  let level = 0;
  for (const qualifier of statement.qualifiers) {
    if (qualifier.property.id !== SPOILER_PROPERTY) continue;
    const content = qualifier.value.type === 'value' ? qualifier.value.content : undefined;
    const amount = isRecord(content) ? Number(content.amount) : Number.NaN;
    level = Math.max(level, Number.isInteger(amount) ? Math.min(2, Math.max(0, amount)) : 2);
  }
  return level;
}

/** One native association page; Connections uses the same bound. */
export const CHARACTER_WORK_PAGE_LIMIT = 12;

export type CharacterWorkKind = 'appearance' | 'performance';
export type CharacterConnectionGroup = 'relations' | 'characters' | 'credits';

export type CharacterRelated = SubjectRead['related'] &
  Record<string, SubjectRead['related'][string] & { redirect?: string }>;

export type CharacterPageSection =
  | {
      ok: false;
      status?: number | undefined;
      code?: string | undefined;
      retryAfter?: string | undefined;
      retryAt?: number | undefined;
    }
  | { ok: true; read: PageRead; body: Record<string, unknown>; sources?: unknown };

/** Current Subject page observation Character reading retains; extra page fields are ignored. */
export type CharacterPage = {
  locale: string;
  currentHref?: string;
  context?: SelectedContext;
  realm?: string | undefined;
  cacheReader?: string | null | undefined;
  subject: string | null;
  subjectLabel?: string;
  link: PageLink;
  reader: Reader;
  labels: { spoilerHide?: string };
  unlabelled: string;
  spoilerShow: string;
  releaseDigest?: string;
  candidatePropertyLabel?: (propertyId: string) => string;
  relations: Record<string, { forwardLabel?: string }>;
  relationDirections?: ReleasedRelationDirectionResult[];
  relationNodes?: { id: string; props: Record<string, unknown> }[];
};

export type CharacterQualifiedNote = {
  text: string;
  property?: string;
  subject?: { id: string; label: string; summary?: unknown };
  language?: string;
};

export type CharacterCreditSlot = {
  property: string;
  target?: string;
  sameAs?: string;
  key?: string;
  context?: string;
};

export type CharacterCreditAssertion = {
  holder: string;
  statement: Stmt & { rezics: { release: string; revision: number } };
  related: Record<string, { id?: string; label?: { value: string; language: string } | string | null }>;
  slot?: CharacterCreditSlot;
};

export type CharacterCreditVisit = {
  person: string;
  node: string;
  stream: PageRead;
  context: string;
  reader: string | null;
  release: string;
  propertyLabel: string;
  labels?: Readonly<Record<string, string>>;
  definition?: string;
  realm?: string | undefined;
};

export type CharacterPageItem = {
  id: string;
  label: { text: string; lang?: string | undefined };
  href?: string;
  summary?: unknown;
  type?: string;
  notes: string[];
  qualified?: CharacterQualifiedNote[];
  statement?: string | undefined;
  credit?: CharacterCreditAssertion | undefined;
  gated: boolean;
  property?: string;
  date?: string;
};

export type CharacterConnectionStream = {
  key: string;
  property: string;
  direction: 'in' | 'out';
  group: CharacterConnectionGroup;
  label: string;
  forwardLabel: string;
  language: string | null;
  filter?: string;
  qualifier?: string;
};

export type CharacterConnectionSelection = { stream: string; cursor?: string; reading?: string };
export type CharacterConnectionAddress = {
  id: string;
  locale: string;
  realm?: string | undefined;
  viewer?: string | undefined;
  context?: string | undefined;
  release?: string | undefined;
  selection?: Partial<Record<CharacterConnectionGroup, CharacterConnectionSelection>> | undefined;
  only?: CharacterConnectionGroup | undefined;
  graph?: { properties: string[]; depth: 1 | 2 } | undefined;
};

export type CharacterConnectionSection = {
  stream: CharacterConnectionStream;
  section: CharacterPageSection;
  reading?: string;
};

export type CharacterConnectionVisit =
  | { ok: false; status: number }
  | {
      ok: true;
      id: string;
      release: string;
      context?: SelectedContext;
      streams: CharacterConnectionStream[];
      sections: Partial<Record<CharacterConnectionGroup, CharacterConnectionSection>>;
      graph?: { ok: true; body: unknown } | { ok: false; status: number };
    };

export type CharacterConnectionRead = (
  address: CharacterConnectionAddress,
  signal: AbortSignal,
) => Promise<CharacterConnectionVisit>;

export type CharacterConnectionPageState = {
  stream: string;
  history: { cursor?: string; reading: string; page?: number }[];
  index: number;
  page?: number;
};

export type CharacterConnectionSnapshot = {
  visit?: Extract<CharacterConnectionVisit, { ok: true }>;
  failure?: number;
  pending: ReadonlySet<string>;
  pages?: Partial<Record<CharacterConnectionGroup, CharacterConnectionPageState>>;
};

export type CharacterConnectionWindow = {
  snapshot: () => CharacterConnectionSnapshot;
  subscribe: (listener: () => void) => () => void;
  load: (
    group?: CharacterConnectionGroup,
    selection?: CharacterConnectionSelection,
    graph?: CharacterConnectionAddress['graph'],
  ) => Promise<void> | void;
  next: (group: CharacterConnectionGroup) => Promise<void> | void;
  previous: (group: CharacterConnectionGroup) => Promise<void> | void;
  restartGroup: (group: CharacterConnectionGroup) => Promise<void> | void;
  restart: () => Promise<void> | void;
  activate: () => void;
  retire: (silent?: boolean) => void;
};

export type CharacterReturnWindow = {
  stream: string;
  cursor?: string;
  reading?: string;
  focus?: string;
  holder?: string;
  control?: 'browse' | 'evidence';
  history?: { cursor?: string; reading: string; page: number }[];
  index?: number;
};

export type CharacterCoverListProps = {
  items: CharacterPageItem[];
  value: Pick<CharacterPage, 'locale' | 'link' | 'reader' | 'labels' | 'unlabelled' | 'spoilerShow' | 'context'> & {
    subject?: string | null;
  };
  label: string;
};

export type CharacterCandidateValueProps = {
  snak: Snak & { id?: string };
  related: CharacterRelated;
  locale: string;
  link?: PageLink;
};

export type CharacterSpoilerGateProps = {
  label: string;
  hideLabel?: string | undefined;
  children: ReactNode;
};

/** Page observation and the holder projection already bound to this visit. */
export type CharacterPageSlot = {
  usePage: () => CharacterPage | null;
  itemsFromHolder: (body: Record<string, unknown>, limit: number, locale: string, level: number) => CharacterPageItem[];
};

/** Native association window factory; the page owns the transport. */
export type CharacterReadSlot = {
  pageLimit: number;
  createWindow: (address: CharacterConnectionAddress, read: CharacterConnectionRead) => CharacterConnectionWindow;
  connectionReturn: (
    current: CharacterConnectionSection,
    page?: CharacterConnectionPageState,
    focus?: string,
    holder?: string,
  ) => CharacterReturnWindow | undefined;
};

/** Return, destination and work addresses; Context is never overridden. */
export type CharacterNavigationSlot = {
  connectionReturnHref: (
    id: string,
    label: string,
    locale: string,
    realm?: string,
    window?: CharacterReturnWindow,
  ) => string;
  withVisitReturn: (href: string, value: string, locale: string) => string;
  workHref: (subject: { id: string; label: string }, locale: string, context?: SelectedContext) => string;
  subjectViewHref: (subject: { id: string; label: string }, locale: string, view: string) => string;
};

export type CharacterPresentationSlot = {
  CoverList: ComponentType<CharacterCoverListProps>;
  CandidateValue: ComponentType<CharacterCandidateValueProps>;
  SpoilerGate: ComponentType<CharacterSpoilerGateProps>;
};

export type CharacterReadingSlots = {
  page: CharacterPageSlot;
  read: CharacterReadSlot;
  navigation: CharacterNavigationSlot;
  presentation: CharacterPresentationSlot;
};

export const CharacterReadingSlotsContext = createContext<CharacterReadingSlots | null>(null);

export function useCharacterReadingSlots(): CharacterReadingSlots {
  const slots = useContext(CharacterReadingSlotsContext);
  if (!slots) throw new Error('Character reading slots are not installed');
  return slots;
}

export function useCharacterPage(): CharacterPage | null {
  return useCharacterReadingSlots().page.usePage();
}

/** Only streams already admitted by the current release enter this presentation. No inverse aliases. */
export function characterWorkStream(
  stream: CharacterConnectionStream,
  character: string,
): CharacterWorkKind | undefined {
  if (stream.direction !== 'in') return;
  if (stream.group === 'characters' && stream.property === 'schema:character' && !stream.filter) return 'appearance';
  if (
    stream.group === 'credits' &&
    stream.property === 'wdt:P725' &&
    stream.qualifier === 'wdt:P453' &&
    stream.filter === character
  )
    return 'performance';
}

/** Convert only identity-checked native summaries, including the assertion's own qualifier/citation summaries. */
export function characterRelationRelated(value: unknown): CharacterRelated {
  if (!isRecord(value)) return {};
  const related: CharacterRelated = {};
  for (const [id, summary] of Object.entries(value)) {
    if (!isRecord(summary) || summary.id !== id) continue;
    const label = summary.label;
    const labels =
      isRecord(label) && typeof label.value === 'string' && typeof label.language === 'string'
        ? { [label.language]: label.value }
        : typeof label === 'string'
          ? { en: label }
          : {};
    const redirect = typeof summary.redirect === 'string' ? summary.redirect : undefined;
    related[id] = { labels, ...(redirect ? { redirect } : {}) };
  }
  return related;
}

const noteLabels: Record<string, (options: { locale: never }) => string> = {
  'wdt:P1932': (options) => m.subject_credit_named({}, options),
  'wdt:P1545': (options) => m.subject_credit_order({}, options),
  'schema:position': (options) => m.subject_credit_order({}, options),
  'wdt:P3831': (options) => m.subject_credit_role({}, options),
  'wdt:P453': (options) => m.subject_credit_character({}, options),
  'schema:character': (options) => m.subject_credit_character({}, options),
  'wdt:P518': (options) => m.subject_credit_part({}, options),
};

function disclosedLabel(related: Record<string, unknown>, target: string): string | undefined {
  if (!Object.hasOwn(related, target) || !isRecord(related[target])) return;
  const summary = related[target]!;
  if (summary.id !== target) return;
  const label = summary.label;
  if (typeof label === 'string' && label.trim()) return label;
  if (isRecord(label) && typeof label.value === 'string' && label.value.trim()) return label.value;
}

/** Qualifiers this Character window discloses; missing item labels never become raw identifiers. */
export function characterWorkNotes(statement: Stmt, related: unknown, locale: string): CharacterQualifiedNote[] {
  const options = { locale: locale as never };
  const disclosed = isRecord(related) ? related : {};
  return statement.qualifiers.flatMap((snak): CharacterQualifiedNote[] => {
    const prefix = Object.hasOwn(noteLabels, snak.property.id) ? noteLabels[snak.property.id]!(options) : undefined;
    if (!prefix) return [];
    const property = snak.property.id;
    if (snak.value.type === 'somevalue' || snak.value.type === 'novalue')
      return [
        {
          property,
          text: `${prefix}: ${
            snak.value.type === 'somevalue' ? m.subject_value_unknown({}, options) : m.subject_value_none({}, options)
          }`,
        },
      ];
    if (snak.value.type !== 'value') return [];
    const content = snak.value.content;
    if (snak.property.data_type === 'wikibase-item' && typeof content === 'string') {
      const label = disclosedLabel(disclosed, content);
      return [
        {
          property,
          text: `${prefix}: ${label ?? m.subject_value_unlabelled({}, options)}`,
          ...(label ? { subject: { id: content, label } } : {}),
        },
      ];
    }
    if (
      (snak.property.data_type === 'string' || snak.property.data_type === 'external-id') &&
      typeof content === 'string'
    )
      return [{ property, text: `${prefix}: ${content}` }];
    if (
      snak.property.data_type === 'monolingualtext' &&
      isRecord(content) &&
      typeof content.text === 'string' &&
      typeof content.language === 'string'
    )
      return [{ property, text: `${prefix}: ${content.text}`, language: content.language }];
    return [];
  });
}

export type CharacterWorkRow = {
  item: CharacterPageItem;
  holder: string;
  statement?: string;
  original?: Stmt;
  related: CharacterRelated;
  performer?: { id: string; label: string };
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function appearanceMatches(statement: Stmt, character: string, related: CharacterRelated): boolean {
  return (
    statement.value.type === 'value' &&
    (statement.value.content === character ||
      (typeof statement.value.content === 'string' && related[statement.value.content]?.redirect === character))
  );
}

function performanceMatches(statement: Stmt, character: string): boolean {
  return statement.qualifiers.some(
    (part) =>
      isRecord(part) &&
      isRecord(part.property) &&
      part.property.id === 'wdt:P453' &&
      isRecord(part.value) &&
      part.value.type === 'value' &&
      part.value.content === character,
  );
}

/** One current native window; never pair assertions, hydrate targets or retain a discarded page. */
export function characterWorkRows(
  current: CharacterConnectionSection,
  character: string,
  locale: string,
  level: number,
): CharacterWorkRow[] {
  const kind = characterWorkStream(current.stream, character);
  if (!kind || !current.section.ok || !Array.isArray(current.section.body.links)) return [];
  return current.section.body.links.slice(0, CHARACTER_WORK_PAGE_LIMIT).flatMap((row): CharacterWorkRow[] => {
    if (
      !isRecord(row) ||
      typeof row.subject !== 'string' ||
      !uuid.test(row.subject) ||
      !isRecord(row.summary) ||
      row.summary.id !== row.subject ||
      row.property !== current.stream.property
    )
      return [];
    const label = row.summary.label;
    const title =
      typeof label === 'string' ? label : isRecord(label) && typeof label.value === 'string' ? label.value : '';
    const statement = typeof row.statement === 'string' && uuid.test(row.statement) ? row.statement : undefined;
    const assertion = row.assertion;
    const related = characterRelationRelated(row.related);
    const original =
      statement &&
      isRecord(assertion) &&
      assertion.id === statement &&
      isRecord(assertion.property) &&
      assertion.property.id === current.stream.property &&
      isRecord(assertion.value) &&
      Array.isArray(assertion.qualifiers) &&
      Array.isArray(assertion.references) &&
      (kind === 'appearance'
        ? appearanceMatches(assertion as unknown as Stmt, character, related)
        : performanceMatches(assertion as unknown as Stmt, character))
        ? (assertion as unknown as Stmt)
        : undefined;
    const language = isRecord(label) && typeof label.language === 'string' ? label.language : undefined;
    const item: CharacterPageItem = {
      id: row.subject,
      label: language ? { text: title, lang: language } : { text: title },
      ...(row.summary ? { summary: row.summary } : {}),
      ...(typeof row.type === 'string' ? { type: row.type } : {}),
      ...(typeof row.property === 'string' ? { property: row.property } : {}),
      ...(statement ? { statement } : {}),
      notes: [],
      ...(original
        ? { qualified: characterWorkNotes(original, isRecord(row.related) ? row.related : {}, locale) }
        : {}),
      gated: original ? spoilerLevel(original) > level : false,
    };
    if (!item.id) return [];
    const performerId =
      kind === 'performance' && original?.value.type === 'value' && typeof original.value.content === 'string'
        ? original.value.content
        : undefined;
    const performer = performerId && isRecord(row.related) ? row.related[performerId] : undefined;
    const performerLabel =
      isRecord(performer) &&
      performer.id === performerId &&
      isRecord(performer.label) &&
      typeof performer.label.value === 'string'
        ? performer.label.value
        : undefined;
    return [
      {
        item: { ...item, ...(original ? {} : { qualified: [] }) },
        holder: row.subject,
        ...(statement ? { statement } : {}),
        ...(original ? { original } : {}),
        related,
        ...(performerId && performerLabel ? { performer: { id: performerId, label: performerLabel } } : {}),
      },
    ];
  });
}

export function characterPageLabel(value: unknown, locale: string): { text: string; lang?: string | undefined } {
  return pageText(value, locale);
}
