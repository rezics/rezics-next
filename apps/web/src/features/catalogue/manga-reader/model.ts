import type { RelationDefinition } from '../../../subject/relations';
import { WORK_PARTS_PAGE_CAP } from '../work-parts';
import { listView, type ProfileRelationWindow } from '../../pages/views';
import { qualifiedNotes } from '../../pages/qualified-relations';
import { isRecord, pageText, spoilerLevel, type Stmt } from '../../pages/shared';
import { relationItemRows } from '../../pages/relation-item-identity';
import { defaultReader, type Reader } from '../../../subject/reader';
import type { SubjectLinksResponse, SubjectRead } from '@rezics/client';
import type { Subject } from '../../../subject/types';
import { originalLanguage } from '../../../subject/language';
import { mangaOccurrenceKey, type MangaOccurrence } from './navigation';

export type MangaAssertion = NonNullable<SubjectLinksResponse['links'][number]['assertion']>;
export type MangaRelated = NonNullable<SubjectLinksResponse['links'][number]['related']>;

/** Reject an over-bound disclosure as a whole; never truncate evidence into a different assertion. */
export const MANGA_QUALIFIER_CAP = 16;
export const MANGA_REFERENCE_CAP = 16;
export const MANGA_REFERENCE_PART_CAP = 16;
export const MANGA_RELATED_CAP = 256;

export const mangaReaderTypes = ['schema:ComicSeries', 'schema:PublicationVolume'] as const;
export type MangaReaderType = (typeof mangaReaderTypes)[number];
export type MangaWindowStatus =
  | 'unsupported'
  | 'withheld'
  | 'unavailable'
  | 'empty-exhausted'
  | 'empty-continued'
  | 'populated';

export type MangaReaderRow = {
  id: string;
  label: string;
  labelLanguage?: string;
  type?: string;
  property: string;
  direction: 'forward' | 'inverse';
  group: 'contents' | 'editions';
  statementId: string;
  notes: string[];
  key: string;
  node: string;
  holder?: { id: string; label: string; language?: string };
  occurrence?: MangaOccurrence;
  assertion?: MangaAssertion;
  related: MangaRelated;
};

export type MangaReaderMeasure = {
  key: string;
  property: string;
  label: string;
  direction: 'forward' | 'inverse';
  count: NonNullable<ProfileRelationWindow['count']>;
  continued: boolean;
};

export type MangaReaderObservation = {
  source: object;
  release: object;
  subject: string;
  context: string | null;
  locale: string;
  viewer: string | null;
  view: string;
  window: string | null;
  realm?: string | undefined;
  reader?: string | undefined;
  /** Existing mount's session/credential identity, used only to retire this reading. */
  admission?: string | undefined;
  address?: string | undefined;
};

export function isMangaReaderType(type: string): type is MangaReaderType {
  return (mangaReaderTypes as readonly string[]).includes(type);
}

/** A source, release, locale, context or already-supplied reader replacement retires the captured visit. */
export function mangaReaderRetired(captured: MangaReaderObservation, current: MangaReaderObservation): boolean {
  return (
    captured.source !== current.source ||
    captured.release !== current.release ||
    captured.subject !== current.subject ||
    captured.context !== current.context ||
    captured.locale !== current.locale ||
    captured.viewer !== current.viewer ||
    captured.view !== current.view ||
    captured.window !== current.window ||
    captured.realm !== current.realm ||
    captured.reader !== current.reader ||
    captured.admission !== current.admission ||
    captured.address !== current.address
  );
}

function relationGroup(window: ProfileRelationWindow, definitions: Record<string, RelationDefinition>) {
  const view = listView(window.property);
  if (view === 'editions') return 'editions' as const;
  if (view === 'contents' || definitions[window.property]?.group === 'membership') return 'contents' as const;
  return undefined;
}

function directedLabel(window: ProfileRelationWindow, definitions: Record<string, RelationDefinition>) {
  const definition = definitions[window.property];
  return window.direction === 'forward' ? definition?.forwardLabel || definition?.label || '' : definition?.label || '';
}

function assertionOf(row: Record<string, unknown>, direction: 'forward' | 'inverse') {
  const assertion = direction === 'forward' ? row.statement : row.assertion;
  return isRecord(assertion) ? assertion : undefined;
}

function snak(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.property) &&
    typeof value.property.id === 'string' &&
    typeof value.property.data_type === 'string' &&
    isRecord(value.value) &&
    ['value', 'somevalue', 'novalue'].includes(String(value.value.type))
  );
}

function admittedAssertion(value: Record<string, unknown>): value is MangaAssertion & Record<string, unknown> {
  return (
    snak(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    ['normal', 'preferred', 'deprecated'].includes(String(value.rank)) &&
    Array.isArray(value.qualifiers) &&
    value.qualifiers.length <= MANGA_QUALIFIER_CAP &&
    value.qualifiers.every(snak) &&
    Array.isArray(value.references) &&
    value.references.length <= MANGA_REFERENCE_CAP &&
    value.references.every(
      (reference) =>
        isRecord(reference) &&
        typeof reference.hash === 'string' &&
        Array.isArray(reference.parts) &&
        reference.parts.length <= MANGA_REFERENCE_PART_CAP &&
        reference.parts.every(snak),
    ) &&
    isRecord(value.rezics) &&
    typeof value.rezics.release === 'string' &&
    Number.isSafeInteger(value.rezics.revision) &&
    Number(value.rezics.revision) > 0
  );
}

function admittedRows(window: ProfileRelationWindow, subject?: string): Record<string, unknown>[] | undefined {
  const rows = relationItemRows(window.rows, window.direction === 'inverse' ? 'links' : 'relations');
  if (!rows) return;
  for (const row of rows) {
    if (window.direction === 'inverse' && row.property !== window.property) return;
    const assertion = assertionOf(row, window.direction);
    if (
      assertion &&
      (!isRecord(assertion.property) ||
        assertion.property.id !== window.property ||
        !Array.isArray(assertion.qualifiers) ||
        !Array.isArray(assertion.references) ||
        !admittedAssertion(assertion))
    )
      return;
    if (row.related !== undefined && (!isRecord(row.related) || Object.keys(row.related).length > MANGA_RELATED_CAP))
      return;
    const target = window.direction === 'forward' ? row.target : subject;
    if (
      assertion &&
      typeof target === 'string' &&
      (!isRecord(assertion.value) || assertion.value.type !== 'value' || assertion.value.content !== target)
    )
      return;
  }
  return rows;
}

function disclosedToReader(assertion: Record<string, unknown> | undefined, reader: Reader): boolean {
  return !assertion || spoilerLevel(assertion as unknown as Stmt) <= reader.spoilerLevel;
}

/** Only current native rows are projected. Their relation order and statement identities are retained verbatim. */
export function mangaReaderRows(
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  locale: string,
  reader: Reader,
  subject?: Subject,
): MangaReaderRow[] {
  const result: MangaReaderRow[] = [];
  for (const window of windows) {
    const group = relationGroup(window, definitions);
    if (!group || window.status !== 200 || !window.valid || window.rows.length > WORK_PARTS_PAGE_CAP) continue;
    const rows = admittedRows(window, subject?.id);
    if (!rows) continue;
    for (const row of rows) {
      const id = window.direction === 'inverse' ? row.subject : row.target;
      if (typeof id !== 'string' || !id.trim()) continue;
      const assertion = assertionOf(row, window.direction);
      if (!disclosedToReader(assertion, reader)) continue;
      const summary = isRecord(row.summary) ? row.summary : undefined;
      const summaryLabel = summary && isRecord(summary.label) ? summary.label.value : undefined;
      const labelLanguage =
        summary && isRecord(summary.label) && typeof summary.label.language === 'string'
          ? summary.label.language
          : undefined;
      const label = typeof row.label === 'string' ? row.label : typeof summaryLabel === 'string' ? summaryLabel : '';
      const statementId =
        typeof row.statement === 'string'
          ? row.statement
          : assertion && typeof assertion.id === 'string'
            ? assertion.id
            : undefined;
      if (!statementId) continue;
      const notes = assertion
        ? qualifiedNotes(assertion as unknown as Stmt, row.related, locale).map((note) => note.text)
        : [];
      const holder =
        window.direction === 'inverse'
          ? { id, label, ...(labelLanguage ? { language: labelLanguage } : {}) }
          : subject
            ? { id: subject.id, label: pageText(subject.labels, locale, originalLanguage(subject)).text }
            : undefined;
      const occurrence = holder
        ? {
            node: window.node,
            direction: window.direction,
            property: window.property,
            holder: holder.id,
            statement: statementId,
            target: id,
          }
        : undefined;
      const related = Object.fromEntries(
        Object.entries(isRecord(row.related) ? row.related : {}).filter(
          ([id, summary]) => isRecord(summary) && summary.id === id,
        ),
      ) as MangaRelated;
      result.push({
        id,
        label,
        ...(labelLanguage ? { labelLanguage } : {}),
        ...(typeof row.type === 'string'
          ? { type: row.type }
          : typeof summary?.type === 'string'
            ? { type: summary.type }
            : {}),
        property: window.property,
        direction: window.direction,
        group,
        statementId,
        notes,
        key: occurrence
          ? mangaOccurrenceKey(occurrence)
          : JSON.stringify([window.node, window.direction, window.property, statementId, id]),
        node: window.node,
        ...(holder ? { holder } : {}),
        ...(occurrence ? { occurrence } : {}),
        ...(assertion ? { assertion: assertion as MangaAssertion } : {}),
        related,
      });
    }
  }
  return result;
}

/** Only disclosed response summaries become labels for the existing value renderer. */
export function mangaRelatedLabels(related: MangaRelated): SubjectRead['related'] {
  return Object.fromEntries(
    Object.entries(related).flatMap(([id, summary]) => {
      const label = summary?.label;
      return label && typeof label.value === 'string' && typeof label.language === 'string'
        ? [[id, { labels: { [label.language]: label.value } }]]
        : [];
    }),
  );
}

/** Counts stay attached to one admitted relation property and its native direction. */
export function mangaReaderMeasures(
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  reader: Reader = defaultReader,
  subject?: string,
): MangaReaderMeasure[] {
  return windows.flatMap((window) => {
    if (window.status !== 200 || !window.valid || window.rows.length > WORK_PARTS_PAGE_CAP) return [];
    if (!relationGroup(window, definitions) || !window.count) return [];
    const rows = admittedRows(window, subject);
    if (!rows || rows.some((row) => !disclosedToReader(assertionOf(row, window.direction), reader))) return [];
    return [
      {
        key: `${window.node}:${window.direction}:${window.property}`,
        property: window.property,
        label: directedLabel(window, definitions),
        direction: window.direction,
        count: window.count,
        continued: !!window.next,
      },
    ];
  });
}

/** Empty terminal pages, sparse continuation, withholding and dependency failure remain separate. */
export function mangaReaderWindowStatus(
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  reader: Reader = defaultReader,
  subject?: string,
): MangaWindowStatus {
  const selected = windows.filter((window) => !!relationGroup(window, definitions));
  if (selected.length === 0) return 'unsupported';
  if (selected.some((window) => window.status === 401 || window.status === 403)) return 'withheld';
  if (
    selected.some(
      (window) =>
        window.status !== 200 ||
        !window.valid ||
        window.rows.length > WORK_PARTS_PAGE_CAP ||
        !admittedRows(window, subject),
    )
  )
    return 'unavailable';
  if (
    selected.some((window) =>
      admittedRows(window, subject)!.some((row) => disclosedToReader(assertionOf(row, window.direction), reader)),
    )
  )
    return 'populated';
  if (selected.some((window) => !!window.next)) return 'empty-continued';
  return 'empty-exhausted';
}

export function mangaReaderWindowScope(
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  view: string,
): ProfileRelationWindow[] {
  if (view === 'contents') return windows.filter((window) => relationGroup(window, definitions) === 'contents');
  if (view === 'editions') return windows.filter((window) => relationGroup(window, definitions) === 'editions');
  return windows.filter((window) => !!relationGroup(window, definitions));
}
