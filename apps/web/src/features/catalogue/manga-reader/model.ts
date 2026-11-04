import type { RelationDefinition } from '../../../subject/relations';
import { WORK_PARTS_PAGE_CAP } from '../work-parts';
import { listView, type ProfileRelationWindow } from '../../pages/views';
import { qualifiedNotes } from '../../pages/qualified-relations';
import { isRecord, spoilerLevel, type Stmt } from '../../pages/shared';
import { relationItemRows } from '../../pages/relation-item-identity';
import { defaultReader, type Reader } from '../../../subject/reader';

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
};

export function isMangaReaderType(type: string): type is MangaReaderType {
  return (mangaReaderTypes as readonly string[]).includes(type);
}

/** A source, release, locale, context or already-supplied reader replacement retires the captured visit. */
export function mangaReaderRetired(
  captured: MangaReaderObservation,
  current: MangaReaderObservation,
): boolean {
  return (
    captured.source !== current.source ||
    captured.release !== current.release ||
    captured.subject !== current.subject ||
    captured.context !== current.context ||
    captured.locale !== current.locale ||
    captured.viewer !== current.viewer ||
    captured.view !== current.view ||
    captured.window !== current.window
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
  return window.direction === 'forward'
    ? definition?.forwardLabel || definition?.label || ''
    : definition?.label || '';
}

function assertionOf(row: Record<string, unknown>, direction: 'forward' | 'inverse') {
  const assertion = direction === 'forward' ? row.statement : row.assertion;
  return isRecord(assertion) ? assertion : undefined;
}

function admittedRows(window: ProfileRelationWindow): Record<string, unknown>[] | undefined {
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
        !Array.isArray(assertion.references))
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
): MangaReaderRow[] {
  const result: MangaReaderRow[] = [];
  for (const window of windows) {
    const group = relationGroup(window, definitions);
    if (!group || window.status !== 200 || !window.valid || window.rows.length > WORK_PARTS_PAGE_CAP) continue;
    const rows = admittedRows(window);
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
        key: `${window.node}:${window.direction}:${window.property}:${statementId}`,
      });
    }
  }
  return result;
}

/** Counts stay attached to one admitted relation property and its native direction. */
export function mangaReaderMeasures(
  windows: readonly ProfileRelationWindow[],
  definitions: Record<string, RelationDefinition>,
  reader: Reader = defaultReader,
): MangaReaderMeasure[] {
  return windows.flatMap((window) => {
    if (window.status !== 200 || !window.valid || window.rows.length > WORK_PARTS_PAGE_CAP) return [];
    if (!relationGroup(window, definitions) || !window.count) return [];
    const rows = admittedRows(window);
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
        !admittedRows(window),
    )
  )
    return 'unavailable';
  if (
    selected.some((window) =>
      admittedRows(window)!.some((row) => disclosedToReader(assertionOf(row, window.direction), reader)),
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
  if (view === 'contents')
    return windows.filter((window) => relationGroup(window, definitions) === 'contents');
  if (view === 'editions')
    return windows.filter((window) => relationGroup(window, definitions) === 'editions');
  return windows.filter((window) => !!relationGroup(window, definitions));
}
