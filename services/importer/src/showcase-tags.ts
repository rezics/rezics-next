import { bundledDigest } from '@rezics/definitions/bundled';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import {
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
  type VndbPublicTagCategory,
} from '../../../packages/conversion/src/support.ts';
import type { CrossMediaGap, CrossMediaPort, CrossMediaTables } from './cross-media-seed.ts';
import {
  importVndbPublicTags,
  planVndbPublicTags,
  readVndbPublicTagBindings,
  vndbPublicTagVocabularyAdmission,
  type AdmittedPublicTag,
  type VndbPublicTagKnownBindings,
  type VndbPublicTagPlan,
  type VndbPublicTagsResult,
} from './vndb-public-tags.ts';
import {
  projectVndbPublicTag,
  projectVndbPublicTagAssociation,
  projectVndbPublicTagParent,
  vndbPublicTagLimits,
  type VndbPublicTagDictionaryRow,
} from './vndb-tables.ts';

type Row = Record<string, unknown>;
type Provider = 'bangumi' | 'vndb';
const workId = /^v[1-9][0-9]*$/u;
const tagId = /^g[1-9][0-9]{0,9}$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Native qualifier Semantic still has to release for public VNDB tag weight. */
export const showcaseTagWeightProperty = 'rezics:sourceTagWeight';
export const showcaseTagWeightGapReason =
  'Public VNDB tag weight (tags.rating in (0,3]) is not in the acquired COPY tables; tags_vn.vote is an individual admission filter, not a public score; native rezics:sourceTagWeight is not released';

export type ShowcaseTagVocabularyRecord = Readonly<{
  kind: 'scheme' | 'concept';
  source: 'vndb';
  key: string;
  uri: string;
  category: VndbPublicTagCategory;
  schemeUri: string;
  state: 'adopted' | 'proposed' | 'unavailable';
}>;

export type ShowcaseTagManifest = Readonly<{
  selectedWorks: readonly string[];
  vocabulary: readonly ShowcaseTagVocabularyRecord[];
  knownBindings?: VndbPublicTagKnownBindings;
}>;

export type ShowcaseTagPlan = VndbPublicTagPlan & {
  vocabulary: ShowcaseTagVocabularyRecord[];
  weightGap: CrossMediaGap | null;
  truncated: boolean;
};

function ensure(value: unknown, message: string): asserts value {
  if (!value) throw new TypeError(message);
}
function fieldsOf(table: string, record: Row): string[] {
  return Object.keys(record)
    .sort()
    .map((field) => `${table}.${field}`);
}
function copyCells(row: Row): Record<string, string | null> {
  const cells: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) cells[key] = null;
    else if (value === true) cells[key] = 't';
    else if (value === false) cells[key] = 'f';
    else if (typeof value === 'string' || typeof value === 'number') cells[key] = String(value);
  }
  return cells;
}
function safeTagRow(table: string, record: Row, reason: string): CrossMediaGap {
  const safe: Row = {};
  for (const field of ['id', 'tag', 'vid', 'cat', 'parent', 'spoiler', 'applicable']) {
    if (field in record) safe[field] = record[field];
  }
  return { source: 'vndb', fields: fieldsOf(table, safe), record: safe, reason };
}
function tablesFrom(rows: Record<string, Row[]>): CrossMediaTables {
  return {
    async *rows(provider: Provider, table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function tryProjectTag(row: Row) {
  try {
    return projectVndbPublicTag(copyCells(row));
  } catch {
    return null;
  }
}
function tryProjectAssociation(row: Row) {
  try {
    return projectVndbPublicTagAssociation(copyCells(row));
  } catch {
    return null;
  }
}
function tryProjectParent(row: Row) {
  try {
    return projectVndbPublicTagParent(copyCells(row));
  } catch {
    return null;
  }
}

export function parseShowcaseTagKnownBindings(value: unknown): VndbPublicTagKnownBindings {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'Invalid VNDB public tag bindings');
  const schemesValue = Reflect.get(value, 'schemes');
  const conceptsValue = Reflect.get(value, 'concepts');
  ensure(Array.isArray(schemesValue) && schemesValue.length <= 3, 'Invalid VNDB public tag scheme bindings');
  ensure(
    Array.isArray(conceptsValue) && conceptsValue.length <= vndbPublicTagLimits.dictionary,
    'Invalid VNDB public tag concept bindings',
  );
  const categories = new Set<VndbPublicTagCategory>();
  const schemes = schemesValue.map((item) => {
    ensure(item !== null && typeof item === 'object' && !Array.isArray(item), 'Invalid VNDB public tag scheme binding');
    const category = Reflect.get(item, 'category');
    const id = Reflect.get(item, 'id');
    ensure(category === 'cont' || category === 'ero' || category === 'tech', 'Invalid VNDB public tag scheme category');
    ensure(typeof id === 'string' && uuid.test(id), 'Invalid VNDB public tag scheme identity');
    ensure(!categories.has(category), 'Duplicate VNDB public tag scheme binding');
    categories.add(category);
    return { category, id };
  });
  const seen = new Set<string>();
  const concepts = conceptsValue.map((item) => {
    ensure(
      item !== null && typeof item === 'object' && !Array.isArray(item),
      'Invalid VNDB public tag concept binding',
    );
    const category = Reflect.get(item, 'category');
    const code = Reflect.get(item, 'code');
    const id = Reflect.get(item, 'id');
    ensure(
      category === 'cont' || category === 'ero' || category === 'tech',
      'Invalid VNDB public tag concept category',
    );
    ensure(typeof code === 'string' && tagId.test(code), 'Invalid VNDB public tag concept code');
    ensure(typeof id === 'string' && uuid.test(id), 'Invalid VNDB public tag concept identity');
    const key = `${category}\0${code}`;
    ensure(!seen.has(key), 'Duplicate VNDB public tag concept binding');
    seen.add(key);
    return { category, code, id };
  });
  return { schemes, concepts };
}

function selectedWorkIds(values: readonly string[]): Set<string> {
  const selected = new Set<string>();
  for (const id of values) {
    ensure(workId.test(id), 'Invalid selected VNDB work identity');
    selected.add(id);
  }
  return selected;
}

/**
 * Stream dump COPY tables and keep only the selected family's tag dictionary,
 * associations and taxonomy closure. Unrelated rows stay out of the finite plan.
 */
export async function projectShowcaseTagTables(
  input: CrossMediaTables,
  selectedVids: readonly string[],
  admittedCodes?: ReadonlySet<string>,
): Promise<{
  tables: CrossMediaTables;
  gaps: CrossMediaGap[];
  truncated: boolean;
  dictionary: Map<string, VndbPublicTagDictionaryRow>;
}> {
  const selected = selectedWorkIds(selectedVids);
  const gaps: CrossMediaGap[] = [];
  const truncated = { value: false };
  const gap = (table: string, record: Row, reason: string) => {
    gaps.push(safeTagRow(table, record, reason));
  };
  const associations: Row[] = [];
  const needed = new Set<string>();
  let associationCount = 0;
  const admittedAssociations = new Set<string>();
  for await (const row of input.rows('vndb', 'tags_vn')) {
    const vid = typeof row.vid === 'string' ? row.vid : undefined;
    if (!vid || !selected.has(vid)) continue;
    let admittedKey: string | undefined;
    if (admittedCodes) {
      if (!admittedCodes.has(String(row.tag))) continue;
      const projected = tryProjectAssociation(row);
      if (!projected || projected.ignore || projected.lie || projected.vote < 1 || projected.vote > 3) continue;
      const key = `${vid}:${projected.tag}`;
      if (admittedAssociations.has(key)) continue;
      admittedKey = key;
    }
    if (associationCount >= vndbPublicTagLimits.associations) {
      if (!truncated.value) gap('tags_vn', row, 'Selected tag associations exceed the bounded import cap');
      truncated.value = true;
      continue;
    }
    associationCount += 1;
    if (admittedKey) admittedAssociations.add(admittedKey);
    associations.push(row);
    const projected = tryProjectAssociation(row);
    if (projected) needed.add(projected.tag);
    else if (typeof row.tag === 'string' && tagId.test(row.tag)) needed.add(row.tag);
  }

  const parentByChild = new Map<string, string[]>();
  let parentCount = 0;
  for await (const row of input.rows('vndb', 'tags_parents')) {
    if (parentCount >= vndbPublicTagLimits.parents) {
      if (!truncated.value) gap('tags_parents', row, 'Tag parent rows exceed the bounded import cap');
      truncated.value = true;
      continue;
    }
    parentCount += 1;
    const projected = tryProjectParent(row);
    if (!projected) {
      gap('tags_parents', row, 'Invalid VNDB tag parent row');
      continue;
    }
    const parents = parentByChild.get(projected.id) ?? [];
    parents.push(projected.parent);
    parentByChild.set(projected.id, parents);
  }

  const closed = new Set(needed);
  let frontier = [...needed];
  for (let depth = 0; depth < vndbPublicTagLimits.closureDepth && frontier.length; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const parent of parentByChild.get(id) ?? []) {
        if (closed.size >= vndbPublicTagLimits.dictionary) {
          if (!truncated.value)
            gap('tags_parents', { id, parent }, 'Tag taxonomy closure exceeds the bounded import cap');
          truncated.value = true;
          continue;
        }
        if (closed.has(parent)) continue;
        closed.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  for (const [id, parents] of parentByChild) {
    if (!closed.has(id)) continue;
    for (const parent of parents) {
      if (closed.has(id) && closed.has(parent))
        gap(
          'tags_parents',
          { id, parent },
          'Parent tag relationship is not admitted for native writes; taxonomy closure keeps the dictionary record only',
        );
    }
  }

  const dictionary = new Map<string, VndbPublicTagDictionaryRow>();
  const tagRows: Row[] = [];
  for await (const row of input.rows('vndb', 'tags')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (!id || !closed.has(id)) continue;
    if (dictionary.size >= vndbPublicTagLimits.dictionary) {
      if (!truncated.value) gap('tags', row, 'Selected tag dictionary exceeds the bounded import cap');
      truncated.value = true;
      continue;
    }
    const projected = tryProjectTag(row);
    if (!projected) {
      gap('tags', row, 'Invalid VNDB tag dictionary row');
      continue;
    }
    dictionary.set(projected.id, projected);
    tagRows.push(row);
  }

  const vnRows: Row[] = [];
  const titleRows: Row[] = [];
  const revisionRows: Row[] = [];
  for await (const row of input.rows('vndb', 'vn')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (id && selected.has(id)) vnRows.push(row);
  }
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (id && selected.has(id)) titleRows.push(row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (id && selected.has(id)) revisionRows.push(row);
  }

  return {
    tables: tablesFrom({
      'vndb/tags': tagRows,
      'vndb/tags_vn': associations,
      'vndb/vn': vnRows,
      'vndb/vn_titles': titleRows,
      'vndb/entry_meta': revisionRows,
    }),
    gaps,
    truncated: truncated.value,
    dictionary,
  };
}

function vocabularyRecords(
  dictionary: Map<string, VndbPublicTagDictionaryRow>,
  bindings: SourceVocabularyBindings,
): ShowcaseTagVocabularyRecord[] {
  const adopted = new Set(bindings.concepts.map((item) => `${item.taxonomy}\0${item.code}`));
  const adoptedSchemes = new Set(bindings.schemes.map((item) => item.uri));
  const records: ShowcaseTagVocabularyRecord[] = [];
  const categories = new Set<VndbPublicTagCategory>();
  for (const tag of dictionary.values()) categories.add(tag.category);
  for (const category of [...categories].sort()) {
    const uri = vndbPublicTagScheme(category);
    records.push({
      kind: 'scheme',
      source: 'vndb',
      key: category,
      uri,
      category,
      schemeUri: uri,
      state: adoptedSchemes.has(uri) ? 'adopted' : 'unavailable',
    });
  }
  for (const tag of [...dictionary.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const uri = vndbPublicTagConceptUri(tag.category, tag.id);
    records.push({
      kind: 'concept',
      source: 'vndb',
      key: tag.id,
      uri,
      category: tag.category,
      schemeUri: vndbPublicTagScheme(tag.category),
      state: adopted.has(`vndb.tag.${tag.category}\0${tag.id}`) ? 'adopted' : 'unavailable',
    });
  }
  return records;
}

function weightGap(admitted: readonly AdmittedPublicTag[]): CrossMediaGap | null {
  if (!admitted.length) return null;
  return {
    source: 'vndb',
    fields: ['tags_vn.vote'],
    record: { metric: 'vndb.tags.rating', property: showcaseTagWeightProperty },
    reason: showcaseTagWeightGapReason,
    property: showcaseTagWeightProperty,
  };
}

function markProposed(
  records: ShowcaseTagVocabularyRecord[],
  known: VndbPublicTagKnownBindings,
): ShowcaseTagVocabularyRecord[] {
  const knownSchemes = new Set(known.schemes.map((item) => vndbPublicTagScheme(item.category)));
  const knownConcepts = new Set(known.concepts.map((item) => `${item.category}\0${item.code}`));
  return records.map((record) => {
    if (record.state === 'adopted') return record;
    if (record.kind === 'scheme' && knownSchemes.has(record.uri)) return { ...record, state: 'proposed' };
    if (record.kind === 'concept' && knownConcepts.has(`${record.category}\0${record.key}`))
      return { ...record, state: 'proposed' };
    return record;
  });
}

function mergeGaps(rows: readonly CrossMediaGap[]): CrossMediaGap[] {
  const unique = new Map<string, CrossMediaGap>();
  for (const gap of rows) {
    const key = `${gap.reason}\0${JSON.stringify(gap.record)}`;
    if (!unique.has(key)) unique.set(key, gap);
  }
  return [...unique.values()];
}

function composePlan(
  projected: Awaited<ReturnType<typeof projectShowcaseTagTables>>,
  plan: VndbPublicTagPlan,
  bindings: SourceVocabularyBindings,
  known: VndbPublicTagKnownBindings,
): ShowcaseTagPlan {
  const obligation = weightGap(plan.admitted);
  return {
    ...plan,
    gaps: mergeGaps([...projected.gaps, ...(obligation ? [obligation] : []), ...plan.gaps]),
    vocabulary: markProposed(vocabularyRecords(projected.dictionary, bindings), known),
    weightGap: obligation,
    truncated: projected.truncated,
  };
}

/** Finite selected-family tag plan for the default real-dump seed. */
export async function planShowcaseTags(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  bindings?: SourceVocabularyBindings;
  known?: VndbPublicTagKnownBindings;
}): Promise<ShowcaseTagPlan> {
  const projected = await projectShowcaseTagTables(input.tables, input.selectedVids);
  return composePlan(
    projected,
    await planVndbPublicTags(projected.tables),
    input.bindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    input.known ?? { schemes: [], concepts: [] },
  );
}

export type ShowcaseTagsResult = VndbPublicTagsResult & {
  vocabulary: ShowcaseTagVocabularyRecord[];
  weightGap: CrossMediaGap | null;
  truncated: boolean;
  bindings: SourceVocabularyBindings;
};

/** Prepare vocabulary in the elected run instead of reconciling the same source with a second, smaller run. */
export async function prepareShowcaseTags(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  port: CrossMediaPort;
  known?: VndbPublicTagKnownBindings;
}) {
  const known = input.known ?? { schemes: [], concepts: [] };
  const projected = await projectShowcaseTagTables(
    input.tables,
    input.selectedVids,
    known.concepts.length ? new Set(known.concepts.map((row) => row.code)) : undefined,
  );
  const bindings = await readVndbPublicTagBindings(input.port, known);
  const planned = composePlan(projected, await planVndbPublicTags(projected.tables), bindings, known);
  return { ...planned, bindings, vocabularyAdmission: vndbPublicTagVocabularyAdmission(bindings, planned.admitted) };
}

/** Default adapter: bounded projection, current binding read, then the integrated public-tag importer. */
export async function importShowcaseTags(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  path: string;
  port: CrossMediaPort;
  known?: VndbPublicTagKnownBindings;
  destination?: { origin: string };
  manifest?: { recordVocabulary?(records: readonly ShowcaseTagVocabularyRecord[]): void };
}): Promise<ShowcaseTagsResult> {
  const known = input.known ?? { schemes: [], concepts: [] };
  const projected = await projectShowcaseTagTables(
    input.tables,
    input.selectedVids,
    known.concepts.length ? new Set(known.concepts.map((row) => row.code)) : undefined,
  );
  const bindings = await readVndbPublicTagBindings(input.port, known);
  const planned = composePlan(projected, await planVndbPublicTags(projected.tables), bindings, known);
  input.manifest?.recordVocabulary?.(planned.vocabulary);
  const imported = await importVndbPublicTags({
    tables: projected.tables,
    path: input.path,
    port: input.port,
    bindings,
    ...(input.destination ? { destination: input.destination } : {}),
  });
  const gaps = mergeGaps([...planned.gaps, ...imported.gaps]);
  return {
    ...imported,
    status: gaps.length ? 'imported-with-gaps' : imported.status,
    gaps,
    vocabulary: planned.vocabulary,
    weightGap: planned.weightGap,
    truncated: planned.truncated,
    bindings,
  };
}

export type { VndbPublicTagKnownBindings };
export type { CrossMediaGap };
