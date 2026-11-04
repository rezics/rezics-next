import type { Subject } from '../../../subject/types';
import { originalLanguage } from '../../../subject/language';
import { pageText } from '../../pages/shared';

const MAX_TITLES = 32;
const MAX_ALIASES = 48;
const MAX_DESCRIPTIONS = 16;

export type LiteraryName = { language: string; text: string };

export type LiteraryWorkIdentity = {
  id: string;
  title: ReturnType<typeof pageText>;
  titles: LiteraryName[];
  aliases: LiteraryName[];
  descriptions: LiteraryName[];
  limited?: boolean;
};

function languageEntries(value: Record<string, unknown> | undefined, maximum: number): LiteraryName[] {
  if (!value) return [];
  return Object.entries(value)
    .flatMap(([language, entry]) => {
      const values = Array.isArray(entry) ? entry : [entry];
      return values.flatMap((text) =>
        typeof text === 'string' && text.trim() ? [{ language, text: text.trim() }] : [],
      );
    })
    .slice(0, maximum);
}

/** The work retains every admitted language label without borrowing an edition's identity. */
export function literaryWorkIdentity(subject: Subject, locale: string): LiteraryWorkIdentity {
  return {
    id: subject.id,
    title: pageText(subject.labels, locale, originalLanguage(subject)),
    titles: languageEntries(subject.labels, MAX_TITLES),
    aliases: languageEntries(subject.aliases, MAX_ALIASES),
    descriptions: languageEntries(subject.descriptions, MAX_DESCRIPTIONS),
    limited:
      languageEntries(subject.labels, MAX_TITLES + 1).length > MAX_TITLES ||
      languageEntries(subject.aliases, MAX_ALIASES + 1).length > MAX_ALIASES ||
      languageEntries(subject.descriptions, MAX_DESCRIPTIONS + 1).length > MAX_DESCRIPTIONS,
  };
}

export type LiteraryReaderObservation = {
  source: object;
  subject: string;
  locale: string;
  context: string | null;
  authority: string | null;
};

/** A replacement source starts a fresh window; changes to the same source retire its displayed identity. */
export function literaryReaderRetired(
  captured: LiteraryReaderObservation,
  current: LiteraryReaderObservation,
): boolean {
  if (captured.source !== current.source || captured.subject !== current.subject) return false;
  return (
    captured.locale !== current.locale ||
    captured.context !== current.context ||
    (captured.authority !== null && captured.authority !== current.authority)
  );
}

export function literaryAuthorityKey(session: {
  state: string;
  subject?: string | null;
  csrfToken: string | null;
}): string | null {
  return session.state === 'unknown' ? null : `${session.state}:${session.subject ?? ''}:${session.csrfToken ?? ''}`;
}

// These are released identities, not names inferred from a URI or a numbered title.
import type { Release } from '@rezics/definitions';
import type { Related } from '../../../subject/types';
import type { Reader } from '../../../subject/reader';
import type { ProfileRelationWindow } from '../../pages/views';
import { bestRank, isRecord, spoilerLevel, type Stmt } from '../../pages/shared';
import { relationItemRows } from '../../pages/relation-item-identity';

export type LiteraryDefinitions = Pick<Release, 'types' | 'properties'>;
export type LiteraryGrain = 'work' | 'series' | 'edition';
export type LiteraryState =
  | 'loading'
  | 'preparing'
  | 'empty'
  | 'sparse'
  | 'ready'
  | 'withheld'
  | 'unavailable'
  | 'unsupported';
export type LiteraryAssertion = { statement: Stmt; related: Related };
export type LiteraryRow = LiteraryAssertion & {
  id: string;
  label: ReturnType<typeof pageText>;
  type: string;
  key: string;
};
export type LiteraryWindow = {
  native: ProfileRelationWindow;
  state: LiteraryState;
  rows: LiteraryRow[];
  withheld: boolean;
};

/** Traverse only the delivered released hierarchy. An unknown Type never gains a literary identity. */
export function literaryGrain(type: string, definitions?: LiteraryDefinitions): LiteraryGrain | undefined {
  if (!definitions?.types[type]) return;
  const seen = new Set<string>();
  const pending = [type];
  while (pending.length) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (current === 'bf:Instance') return 'edition';
    if (current === 'schema:BookSeries') return 'series';
    if (current === 'schema:Book') return 'work';
    pending.push(...(definitions.types[current]?.bases ?? []));
  }
  return;
}

/** Mount on actual supplied ancestry even when the current descriptor is unavailable. */
export function literaryReaderType(type: string, ancestors: readonly string[] = []): boolean {
  return [type, ...ancestors].some((id) => ['schema:Book', 'schema:BookSeries', 'bf:Instance'].includes(id));
}

export function literarySelected(subject: Subject, property: string, reader: Reader): Stmt[] {
  const statements = (subject.statements[property] ?? []) as Stmt[];
  return (subject.relationCounts ? statements : bestRank(statements)).filter(
    (statement) => statement.rank !== 'deprecated' && spoilerLevel(statement) <= reader.spoilerLevel,
  );
}

const memberProperties = new Set(['wdt:P179', 'schema:isPartOf', 'bf:hasPart']);
const editionProperties = new Set(['schema:exampleOfWork', 'schema:workExample', 'rezics:representativeEdition']);
export function literaryWindowKind(window: ProfileRelationWindow, definitions: LiteraryDefinitions) {
  const property = definitions.properties[window.property];
  if (!property?.relation || property.datatype !== 'wikibase-item') return;
  if (memberProperties.has(window.property) && property.relation.group === 'membership') return 'members';
  if (editionProperties.has(window.property)) return 'editions';
  return;
}

/** At most one current native member window and one edition window; prefer the explicitly continued node. */
export function literaryWindows(
  windows: readonly ProfileRelationWindow[],
  definitions: LiteraryDefinitions,
  node?: string,
): ProfileRelationWindow[] {
  const result: ProfileRelationWindow[] = [];
  for (const kind of ['members', 'editions']) {
    const candidates = windows.filter((window) => literaryWindowKind(window, definitions) === kind);
    const selected = candidates.find((window) => window.node === node) ?? candidates[0];
    if (selected) result.push(selected);
  }
  return result;
}

function statement(value: unknown, property: string): value is Stmt {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isRecord(value.property) &&
    value.property.id === property &&
    value.property.data_type === 'wikibase-item' &&
    isRecord(value.value) &&
    Array.isArray(value.qualifiers) &&
    Array.isArray(value.references)
  );
}

/** Native direction, assertion identity and target disclosure all agree before any destination becomes a link. */
export function literaryWindow(
  native: ProfileRelationWindow,
  root: string,
  locale: string,
  reader: Reader,
): LiteraryWindow {
  const result: LiteraryWindow = { native, state: 'unavailable', rows: [], withheld: false };
  if (native.status === undefined) return { ...result, state: 'loading' };
  if (native.status === 202) return { ...result, state: 'preparing' };
  if (native.status === 401 || native.status === 403) return { ...result, state: 'withheld' };
  if (
    native.status !== 200 ||
    !native.valid ||
    !native.limit ||
    native.rows.length > native.limit ||
    (!native.next && !native.complete)
  )
    return result;
  const rows = relationItemRows(native.rows, native.direction === 'inverse' ? 'links' : 'relations');
  if (!rows) return result;
  const invalid = () => ({ ...result, state: 'unavailable' as const, rows: [] });
  const keys = new Set<string>();
  for (const row of rows) {
    const assertion = native.direction === 'inverse' ? row.assertion : row.statement;
    if (
      !statement(assertion, native.property) ||
      (native.direction === 'inverse' && (row.property !== native.property || row.statement !== assertion.id))
    )
      return invalid();
    const id = native.direction === 'inverse' ? row.subject : row.target;
    if (assertion.value.type === 'value' && assertion.value.content !== (native.direction === 'inverse' ? root : id))
      return invalid();
    if (spoilerLevel(assertion) > reader.spoilerLevel || assertion.value.type !== 'value' || !isRecord(row.summary)) {
      result.withheld = true;
      continue;
    }
    if (typeof id !== 'string' || row.summary.id !== id || typeof row.summary.type !== 'string') return invalid();
    const key = `${native.node}:${native.direction}:${native.property}:${assertion.id}`;
    if (keys.has(key)) return invalid();
    keys.add(key);
    const label =
      isRecord(row.summary.label) && typeof row.summary.label.value === 'string'
        ? {
            text: row.summary.label.value,
            lang: typeof row.summary.label.language === 'string' ? row.summary.label.language : undefined,
          }
        : pageText(row.label, locale);
    // This projection is scoped to this assertion. It never resolves a parent or hydrates a row.
    const related = (isRecord(row.related) ? row.related : {}) as Related;
    result.rows.push({ id, key, label, type: row.summary.type, statement: assertion, related });
  }
  result.state =
    native.caughtUp === false
      ? 'preparing'
      : result.rows.length
        ? 'ready'
        : result.withheld
          ? 'withheld'
          : native.next
            ? 'sparse'
            : 'empty';
  return result;
}

/** Extra composition work: no requests or decoding; rows share the admitted native assertion and summaries. */
export function literaryCompositionCost(windows: readonly LiteraryWindow[]) {
  return {
    requests: 0,
    decodedBytes: 0,
    suppliedWindowBytes: new TextEncoder().encode(JSON.stringify(windows.map(({ native }) => native))).byteLength,
    windows: windows.length,
    rows: windows.reduce((count, window) => count + window.rows.length, 0),
    retainedBytes: new TextEncoder().encode(JSON.stringify(windows.map(({ rows }) => rows))).byteLength,
  };
}
