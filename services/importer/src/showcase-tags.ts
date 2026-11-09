import { importCommandPages } from './import-client.ts';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { checkBatchWrite, type BatchCommand, type BatchReference, type BatchStatement } from '@rezics/definitions/bulk';
import type { SourceVocabularyBindings } from '@rezics/conversion';
import { vndbPublicTagParentRevision } from '@rezics/conversion/vndb-vocabulary';
import { vndbRecordUrl } from '@rezics/conversion/cross-media-entities';
import {
  commandKey,
  sourceDigest,
  sourceEnvelope,
  vndbPublicTagConceptUri,
  vndbPublicTagScheme,
  vndbPublicTagTaxonomy,
  type VndbPublicTagCategory,
} from '@rezics/conversion/support';
import {
  type CrossMediaGap,
  type CrossMediaPlan,
  type CrossMediaPort,
  type CrossMediaTables,
  type ShowcaseReviewPort,
} from './showcase-contract.ts';
import { GLOBAL_CONTEXT } from './public-bulk-client.ts';
import { ImportTransportError, type ReviewedSubjectRead } from './import-client.ts';
import type { seedCrossMedia } from './cross-media-seed.ts';
import {
  showcaseDigest,
  showcaseLimits,
  showcaseVocabularyExternalId,
  type ShowcaseAcknowledgement,
  type ShowcaseTagAssociation,
  type ShowcaseTagAssociationWithdrawal,
  type ShowcaseTagParentBinding,
  type ShowcaseTagParentRefresh,
  type ShowcaseVocabularyRequirement,
} from './showcase-contract.ts';
import {
  bindShowcaseTagParents,
  showcaseTagParentCommand,
  showcaseTagParentMetadata,
  showcaseTagParentSourceFence,
  withholdShowcaseTagAssociations,
} from './showcase-cross-provider-tags.ts';
import {
  adoptResumeKeys,
  sendSealedShowcaseAction,
  showcaseAdoptGenerationKey,
  showcaseAdoptIdentity,
  showcaseAdoptInvocationBound,
  showcaseReviewActionKey,
} from './showcase-adoption.ts';
import { currentCandidateSelection, safeCandidatePage, sameAdoptionSelection } from './showcase-current-reads.ts';
import type { ShowcaseJournal } from './showcase-journal.ts';
import {
  acquireShowcaseVndbTagRatings,
  showcaseVndbTagRatingLimits,
  type VndbTagRatingFetch,
  type VndbTagRatingIdentity,
  type VndbTagRatingObservation,
} from './showcase-vndb-tag-ratings.ts';
import { vndbLimits } from '@rezics/conversion/vndb';
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
const tagRatingIdentity: VndbTagRatingIdentity = {
  conceptUri: vndbPublicTagConceptUri,
  schemeUri: vndbPublicTagScheme,
  taxonomy: vndbPublicTagTaxonomy,
};

export type ShowcaseTagVocabularyRecord = Readonly<{
  kind: 'scheme' | 'concept';
  source: 'vndb';
  key: string;
  uri: string;
  category: VndbPublicTagCategory;
  schemeUri: string;
  state: 'adopted' | 'proposed' | 'unavailable';
}>;

/** Source evidence only; current native hierarchy admission is a separate publication step. */
export type ShowcaseTagSourceParent = Readonly<{
  child: string;
  parent: string;
  main: boolean;
  category: VndbPublicTagCategory;
  path: string;
}>;

export type ShowcaseTagManifest = Readonly<{
  selectedWorks: readonly string[];
  vocabulary: readonly ShowcaseTagVocabularyRecord[];
  knownBindings?: VndbPublicTagKnownBindings;
}>;

export type ShowcaseTagPlan = VndbPublicTagPlan & {
  vocabulary: ShowcaseTagVocabularyRecord[];
  sourceParents: ShowcaseTagSourceParent[];
  invalidParentTags: string[];
  tagParentEvidence: ShowcaseTagParentBinding[];
  parentBindingGaps: CrossMediaGap[];
  tagParentRefreshes: ShowcaseTagParentRefresh[];
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
  ensure(values.length <= showcaseVndbTagRatingLimits.works, 'Selected VNDB work limit exceeded');
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
  sourceParents: ShowcaseTagSourceParent[];
  invalidParentTags: string[];
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
  const parentEvidence = new Map<string, ReturnType<typeof projectVndbPublicTagParent>>();
  const invalidParentTags = new Set<string>();
  let parentCount = 0;
  let parentInventoryTruncated = false;
  for await (const row of input.rows('vndb', 'tags_parents')) {
    if (parentCount >= vndbPublicTagLimits.parents) {
      if (!truncated.value) gap('tags_parents', row, 'Tag parent rows exceed the bounded import cap');
      truncated.value = true;
      parentInventoryTruncated = true;
      continue;
    }
    parentCount += 1;
    const projected = tryProjectParent(row);
    if (!projected) {
      gap('tags_parents', row, 'Invalid VNDB tag parent row');
      if (typeof row.id === 'string' && tagId.test(row.id)) invalidParentTags.add(row.id);
      continue;
    }
    parentEvidence.set(`${projected.id}/${projected.parent}`, projected);
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

  // Compute the complete source ancestry height once per selected dictionary node.
  // A cycle, missing endpoint or category crossing invalidates dependent ancestry,
  // without suppressing independent work facts or claiming native admission.
  const heights = new Map<string, number>();
  const visiting = new Set<string>();
  const height = (id: string): number => {
    const cached = heights.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) {
      gap('tags_parents', { id }, 'Cyclic source tag ancestry');
      invalidParentTags.add(id);
      return Infinity;
    }
    visiting.add(id);
    let result = 0;
    for (const parent of parentByChild.get(id) ?? []) {
      const childRow = dictionary.get(id);
      const parentRow = dictionary.get(parent);
      if (!childRow || !parentRow) {
        gap('tags_parents', { id, parent }, 'Missing source tag parent dictionary endpoint');
        invalidParentTags.add(id);
        result = Infinity;
      } else if (childRow.category !== parentRow.category) {
        gap('tags_parents', { id, parent }, 'Source tag parent crosses Scheme category');
        invalidParentTags.add(id);
        result = Infinity;
      } else {
        const parentHeight = height(parent);
        if (!Number.isFinite(parentHeight)) invalidParentTags.add(id);
        result = Math.max(result, 1 + parentHeight);
      }
    }
    visiting.delete(id);
    heights.set(id, result);
    return result;
  };
  if (parentInventoryTruncated) for (const id of closed) invalidParentTags.add(id);
  const sourceParents: ShowcaseTagSourceParent[] = [];
  for (const id of closed) {
    const depth = height(id);
    if (depth > vndbPublicTagLimits.closureDepth) {
      if (Number.isFinite(depth)) gap('tags_parents', { id }, 'Source tag ancestry exceeds closure depth');
      invalidParentTags.add(id);
      continue;
    }
    for (const parent of new Set(parentByChild.get(id) ?? [])) {
      const evidence = parentEvidence.get(`${id}/${parent}`)!;
      sourceParents.push({
        child: id,
        parent,
        main: evidence.main,
        category: dictionary.get(id)!.category,
        path: `/tags_parents/${id}/${parent}`,
      });
    }
  }
  sourceParents.sort((left, right) => left.path.localeCompare(right.path));

  const vnRows: Row[] = [];
  const titleRows: Row[] = [];
  const revisionRows: Row[] = [];
  const vnCounts = new Map<string, number>();
  const titleCounts = new Map<string, number>();
  const titleBytes = new Map<string, number>();
  const revisionCounts = new Map<string, number>();
  const titleLimitReported = new Set<string>();
  const retainOnceOrDuplicate = (rows: Row[], counts: Map<string, number>, id: string, row: Row) => {
    const count = counts.get(id) ?? 0;
    if (count >= 2) return;
    counts.set(id, count + 1);
    rows.push(row);
  };
  for await (const row of input.rows('vndb', 'vn')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (id && selected.has(id)) retainOnceOrDuplicate(vnRows, vnCounts, id, row);
  }
  for await (const row of input.rows('vndb', 'vn_titles')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (!id || !selected.has(id)) continue;
    const count = titleCounts.get(id) ?? 0;
    const latin = row.latin;
    const titleValues = [row.id, row.lang, row.title, ...(typeof latin === 'string' ? [latin] : [])];
    const official =
      row.official === true || row.official === 't'
        ? true
        : row.official === false || row.official === 'f'
          ? false
          : null;
    const fieldsValid =
      official !== null &&
      (latin === null || typeof latin === 'string') &&
      titleValues.every(
        (value) => typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= vndbLimits.stringBytes,
      );
    const bytes = fieldsValid
      ? Buffer.byteLength(JSON.stringify({ id: row.id, lang: row.lang, official, title: row.title, latin }))
      : Number.POSITIVE_INFINITY;
    const usedBytes = titleBytes.get(id) ?? 0;
    if (count >= vndbLimits.maxTitles || !Number.isFinite(bytes) || bytes > vndbLimits.recordBytes - usedBytes) {
      if (!titleLimitReported.has(id)) {
        gap('vn_titles', { id }, 'Selected VNDB title projection exceeds the source record cap');
        titleLimitReported.add(id);
      }
      truncated.value = true;
      continue;
    }
    titleCounts.set(id, count + 1);
    titleBytes.set(id, usedBytes + bytes);
    titleRows.push(row);
  }
  for await (const row of input.rows('vndb', 'entry_meta')) {
    const id = typeof row.id === 'string' ? row.id : undefined;
    if (id && selected.has(id)) retainOnceOrDuplicate(revisionRows, revisionCounts, id, row);
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
    sourceParents,
    invalidParentTags: [...invalidParentTags].sort(),
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
  return {
    ...plan,
    gaps: mergeGaps([...projected.gaps, ...plan.gaps]),
    vocabulary: markProposed(vocabularyRecords(projected.dictionary, bindings), known),
    sourceParents: projected.sourceParents,
    invalidParentTags: projected.invalidParentTags,
    tagParentEvidence: [],
    parentBindingGaps: [],
    tagParentRefreshes: [],
    truncated: projected.truncated,
  };
}

function associationBindings(
  admitted: readonly AdmittedPublicTag[],
  bindings: SourceVocabularyBindings,
): ShowcaseTagAssociation[] {
  return admitted
    .map((row) => {
      const taxonomy = vndbPublicTagTaxonomy(row.category);
      const scheme = bindings.schemes.find((item) => item.taxonomy === taxonomy);
      const concept = bindings.concepts.find((item) => item.taxonomy === taxonomy && item.code === row.tag);
      return {
        workId: row.vid,
        sourceKey: row.path,
        tagId: row.tag,
        category: row.category,
        spoiler: row.spoiler,
        conceptId: concept?.id ?? null,
        schemeId: concept?.schemeId ?? scheme?.id ?? null,
        conceptUri: vndbPublicTagConceptUri(row.category, row.tag),
        schemeUri: vndbPublicTagScheme(row.category),
        releaseDigest: bindings.releaseDigest,
      };
    })
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function associationWithdrawals(
  admitted: readonly AdmittedPublicTag[],
  unavailableTagCodes: readonly string[],
): ShowcaseTagAssociationWithdrawal[] {
  const unavailable = new Set(unavailableTagCodes);
  return admitted
    .filter((row) => unavailable.has(row.tag))
    .map((row) => ({ workId: row.vid, sourceKey: row.path, tagId: row.tag }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
}

function associationRefreshes(planned: ShowcaseTagPlan, selectedVids: readonly string[]): string[] {
  return planned.truncated || planned.gaps.length ? [] : [...new Set(selectedVids)];
}

function tagParentRefreshes(
  projected: Awaited<ReturnType<typeof projectShowcaseTagTables>>,
  planned: ShowcaseTagPlan,
  parentBindingGaps: readonly CrossMediaGap[],
  bindings: SourceVocabularyBindings,
): ShowcaseTagParentRefresh[] {
  if (
    projected.truncated ||
    projected.gaps.length ||
    planned.truncated ||
    planned.gaps.length ||
    parentBindingGaps.length ||
    bindings.releaseDigest !== bundledDigest
  )
    return [];
  return [...projected.dictionary.values()]
    .flatMap((tag) => {
      const taxonomy = vndbPublicTagTaxonomy(tag.category);
      const concept = bindings.concepts.find((item) => item.taxonomy === taxonomy && item.code === tag.id);
      const scheme = bindings.schemes.find((item) => item.taxonomy === taxonomy);
      if (
        !concept ||
        !scheme ||
        concept.type !== 'skos:Concept' ||
        scheme.type !== 'skos:ConceptScheme' ||
        concept.releaseDigest !== bundledDigest ||
        scheme.releaseDigest !== bundledDigest ||
        concept.schemeId !== scheme.id
      )
        return [];
      return [
        {
          category: tag.category,
          tagId: tag.id,
          childId: concept.id,
          schemeId: scheme.id,
          childUri: vndbPublicTagConceptUri(tag.category, tag.id),
          schemeUri: vndbPublicTagScheme(tag.category),
          releaseDigest: bundledDigest,
        },
      ];
    })
    .sort((left, right) => left.childId.localeCompare(right.childId));
}

/** Finite selected-family tag plan for the default real-dump seed. */
export async function planShowcaseTags(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  bindings?: SourceVocabularyBindings;
  known?: VndbPublicTagKnownBindings;
}): Promise<ShowcaseTagPlan> {
  const projected = await projectShowcaseTagTables(input.tables, input.selectedVids);
  const planned = composePlan(
    projected,
    await planVndbPublicTags(projected.tables),
    input.bindings ?? { releaseDigest: bundledDigest, schemes: [], concepts: [] },
    input.known ?? { schemes: [], concepts: [] },
  );
  if (!input.bindings) return planned;
  const parents = bindShowcaseTagParents({
    sourceParents: planned.sourceParents,
    invalidParentTags: planned.invalidParentTags,
    bindings: input.bindings,
  });
  return {
    ...planned,
    admitted: withholdShowcaseTagAssociations(planned.admitted, parents.unavailableTagCodes),
    tagParentEvidence: parents.tagParentEvidence,
    parentBindingGaps: parents.gaps,
    tagParentRefreshes: tagParentRefreshes(projected, planned, parents.gaps, input.bindings),
  };
}

export type ShowcaseTagsResult = VndbPublicTagsResult & {
  vocabulary: ShowcaseTagVocabularyRecord[];
  sourceParents: ShowcaseTagSourceParent[];
  invalidParentTags: string[];
  truncated: boolean;
  bindings: SourceVocabularyBindings;
  associationBindings: ShowcaseTagAssociation[];
  tagAssociationWithdrawals: ShowcaseTagAssociationWithdrawal[];
  tagParentEvidence: ShowcaseTagParentBinding[];
  parentBindingGaps: CrossMediaGap[];
  tagParentRefreshes: ShowcaseTagParentRefresh[];
  associationRefreshes: string[];
  tagWeightObservations: readonly VndbTagRatingObservation[];
  tagWeightRefreshes: readonly string[];
};

/** Prepare the selected tags for admission with the elected works' single reconciliation run. */
export async function prepareShowcaseTags(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  port: CrossMediaPort;
  known?: VndbPublicTagKnownBindings;
  fetch?: VndbTagRatingFetch;
  journal?: ShowcaseJournal;
}) {
  const known = input.known ?? { schemes: [], concepts: [] };
  const projected = await projectShowcaseTagTables(
    input.tables,
    input.selectedVids,
    known.concepts.length ? new Set(known.concepts.map((row) => row.code)) : undefined,
  );
  const bindings = await readVndbPublicTagBindings(input.port, known);
  const planned = composePlan(projected, await planVndbPublicTags(projected.tables), bindings, known);
  const parents = bindShowcaseTagParents({
    sourceParents: planned.sourceParents,
    invalidParentTags: planned.invalidParentTags,
    bindings,
  });
  const admitted = withholdShowcaseTagAssociations(planned.admitted, parents.unavailableTagCodes);
  const withParentGaps = { ...planned, gaps: mergeGaps([...planned.gaps, ...parents.gaps]) };
  const ratingAcquisition = await acquireShowcaseVndbTagRatings({
    selectedVids: input.selectedVids,
    admitted,
    bindings,
    identity: tagRatingIdentity,
    ...(input.journal ? { journal: input.journal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  return {
    ...planned,
    admitted,
    bindings,
    associationBindings: associationBindings(admitted, bindings),
    tagAssociationWithdrawals: associationWithdrawals(planned.admitted, parents.unavailableTagCodes),
    tagParentEvidence: parents.tagParentEvidence,
    parentBindingGaps: parents.gaps,
    tagParentRefreshes: tagParentRefreshes(projected, planned, parents.gaps, bindings),
    gaps: withParentGaps.gaps,
    associationRefreshes: associationRefreshes(withParentGaps, input.selectedVids),
    vocabularyAdmission: vndbPublicTagVocabularyAdmission(bindings, admitted, ratingAcquisition.snapshots),
    tagWeightObservations: ratingAcquisition.observations,
    tagWeightRefreshes: [...new Set(input.selectedVids)],
  };
}

/** Default adapter: bounded projection, current binding read, then the integrated public-tag importer. */
export async function importShowcaseTags(input: {
  seed: typeof seedCrossMedia;
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  path: string;
  port: CrossMediaPort;
  known?: VndbPublicTagKnownBindings;
  destination?: { origin: string };
  fetch?: VndbTagRatingFetch;
  journal?: ShowcaseJournal;
  manifest?: { recordVocabulary?(records: readonly ShowcaseTagVocabularyRecord[]): void };
}): Promise<ShowcaseTagsResult> {
  const known = input.known ?? { schemes: [], concepts: [] };
  const projected = await projectShowcaseTagTables(input.tables, input.selectedVids);
  const bindings = await readVndbPublicTagBindings(input.port, known);
  const planned = composePlan(projected, await planVndbPublicTags(projected.tables), bindings, known);
  const parents = bindShowcaseTagParents({
    sourceParents: planned.sourceParents,
    invalidParentTags: planned.invalidParentTags,
    bindings,
  });
  const admitted = withholdShowcaseTagAssociations(planned.admitted, parents.unavailableTagCodes);
  const withParentGaps = { ...planned, gaps: mergeGaps([...planned.gaps, ...parents.gaps]) };
  const ratingAcquisition = await acquireShowcaseVndbTagRatings({
    selectedVids: input.selectedVids,
    admitted,
    bindings,
    identity: tagRatingIdentity,
    ...(input.journal ? { journal: input.journal } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  input.manifest?.recordVocabulary?.(planned.vocabulary);
  const imported = await importVndbPublicTags({
    seed: input.seed,
    tables: projected.tables,
    path: input.path,
    port: input.port,
    bindings,
    admitted,
    ratings: ratingAcquisition.snapshots,
    ...(input.destination ? { destination: input.destination } : {}),
  });
  const gaps = mergeGaps([...withParentGaps.gaps, ...imported.gaps]);
  const withImportGaps = { ...planned, gaps };
  return {
    ...imported,
    admitted,
    status: gaps.length ? 'imported-with-gaps' : imported.status,
    gaps,
    vocabulary: planned.vocabulary,
    sourceParents: planned.sourceParents,
    invalidParentTags: planned.invalidParentTags,
    tagParentEvidence: parents.tagParentEvidence,
    parentBindingGaps: parents.gaps,
    tagParentRefreshes: tagParentRefreshes(projected, planned, parents.gaps, bindings),
    truncated: planned.truncated,
    bindings,
    associationBindings: associationBindings(admitted, bindings),
    tagAssociationWithdrawals: associationWithdrawals(planned.admitted, parents.unavailableTagCodes),
    associationRefreshes: associationRefreshes(withImportGaps, input.selectedVids),
    tagWeightObservations: ratingAcquisition.observations,
    tagWeightRefreshes: [...new Set(input.selectedVids)],
  };
}

const adapterRevision = 'vndb-public-tag-vocabulary@1';
const schemeCitation = 'https://vndb.org/tags';

type TagDictionaryNeed = {
  ownerKey: string;
  truncated: boolean;
  diagnostics: CrossMediaGap[];
  associated: ReadonlySet<string>;
  schemes: { category: VndbPublicTagCategory; uri: string; citation: string }[];
  concepts: {
    category: VndbPublicTagCategory;
    code: string;
    uri: string;
    citation: string;
    labels: { und: string };
  }[];
};

export type ShowcaseVndbPublicTagVocabulary = {
  requirements: ShowcaseVocabularyRequirement[];
  bindings: SourceVocabularyBindings;
  diagnostics: CrossMediaGap[];
  truncated: boolean;
};

function categoryFromTaxonomy(taxonomy: string): VndbPublicTagCategory | undefined {
  if (taxonomy === vndbPublicTagTaxonomy('cont')) return 'cont';
  if (taxonomy === vndbPublicTagTaxonomy('ero')) return 'ero';
  if (taxonomy === vndbPublicTagTaxonomy('tech')) return 'tech';
  return undefined;
}

function sourceNameLabels(name: unknown): { und: string } | undefined {
  if (typeof name !== 'string' || name.length < 1 || name.length > 250 || name.trim() !== name) return;
  return { und: name };
}

function vocabularyKey(category: VndbPublicTagCategory, code?: string): string {
  return code === undefined ? vndbPublicTagTaxonomy(category) : `${vndbPublicTagTaxonomy(category)}:${code}`;
}

function ownerKeyFor(plan: CrossMediaPlan, selectedVids: readonly string[]): string | undefined {
  const selected = new Set(selectedVids);
  return [...plan.records.vndb, ...plan.entities.vndb].find((row) => selected.has(row.key))?.key;
}

async function selectedTagNeed(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  plan: CrossMediaPlan;
}): Promise<TagDictionaryNeed | undefined> {
  const ownerKey = ownerKeyFor(input.plan, input.selectedVids);
  if (!ownerKey) return;
  const projected = await projectShowcaseTagTables(input.tables, input.selectedVids);
  const planned = await planVndbPublicTags(projected.tables);
  const associated = new Set(planned.admitted.map((row) => row.tag));
  const names = new Map<string, unknown>();
  for await (const row of projected.tables.rows('vndb', 'tags')) {
    if (typeof row.id === 'string') names.set(row.id, row.name);
  }
  const schemes = new Map<VndbPublicTagCategory, { category: VndbPublicTagCategory; uri: string; citation: string }>();
  const concepts: TagDictionaryNeed['concepts'] = [];
  for (const tag of [...projected.dictionary.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    const labels = sourceNameLabels(names.get(tag.id));
    if (!labels) {
      projected.gaps.push(safeTagRow('tags', { id: tag.id, cat: tag.category }, 'Invalid VNDB tag dictionary row'));
      continue;
    }
    if (!schemes.has(tag.category))
      schemes.set(tag.category, {
        category: tag.category,
        uri: vndbPublicTagScheme(tag.category),
        citation: schemeCitation,
      });
    concepts.push({
      category: tag.category,
      code: tag.id,
      uri: vndbPublicTagConceptUri(tag.category, tag.id),
      citation: vndbRecordUrl(tag.id),
      labels,
    });
  }
  return {
    ownerKey,
    truncated: projected.truncated,
    diagnostics: mergeGaps(projected.gaps),
    associated,
    schemes: [...schemes.values()].sort((left, right) => left.category.localeCompare(right.category)),
    concepts,
  };
}

function sourceFor(sourceKey: string, uri: string, citations: readonly string[]) {
  return sourceEnvelope(
    {
      source: 'vndb_cross_media',
      external_id: showcaseVocabularyExternalId(sourceKey),
      record_revision: null,
      converter_revision: adapterRevision,
      digest: sourceDigest({ sourceKey, uri, citations, adapterRevision }),
    },
    'facts',
  );
}

function references(uri: string, citation: string): BatchReference[] {
  return [
    {
      parts: [uri, citation].map((content) => ({
        property: { id: 'schema:url' },
        value: { type: 'value' as const, content },
      })),
    },
  ];
}

function requirementFor(
  ownerKey: string,
  sourceKey: string,
  sourceUri: string,
  citation: string,
  nativeType: 'skos:ConceptScheme' | 'skos:Concept',
  schemeId?: string,
): ShowcaseVocabularyRequirement {
  return {
    provider: 'vndb',
    ownerKey,
    sourceKey,
    source: sourceFor(sourceKey, sourceUri, [sourceUri, citation]),
    sourceUri,
    nativeType,
    ...(schemeId ? { schemeId } : {}),
  };
}

function vocabularyCommands(input: {
  sourceKey: string;
  sourceUri: string;
  citation: string;
  nativeType: 'skos:ConceptScheme' | 'skos:Concept';
  labels: Record<string, string>;
  schemeId?: string;
  subjectId?: string;
}): BatchCommand[] {
  const source = sourceFor(input.sourceKey, input.sourceUri, [input.sourceUri, input.citation]);
  const create: BatchCommand = {
    op: 'create',
    key: `vndb-public-tag-vocabulary:${commandKey([JSON.stringify(source), 'create', input.nativeType, JSON.stringify(input.labels)])}`,
    source,
    subject: { type: input.nativeType, labels: input.labels },
  };
  const subjectId = input.subjectId;
  if (!subjectId) return [create];
  const statements: BatchStatement[] = [
    {
      property: { id: 'schema:url' },
      value: { type: 'value', content: input.sourceUri },
      references: references(input.sourceUri, input.citation),
    },
  ];
  if (input.nativeType === 'skos:Concept' && input.schemeId) {
    statements.push({
      property: { id: 'skos:inScheme' },
      value: { type: 'value', content: input.schemeId },
      references: references(input.sourceUri, input.citation),
    });
  }
  return statements.map((statement) => ({
    op: 'propose' as const,
    key: `vndb-public-tag-vocabulary:${commandKey([JSON.stringify(source), subjectId, 'propose', JSON.stringify(statement)])}`,
    source,
    subject: subjectId,
    statement,
  }));
}

function ackedTagCreates(journal: ShowcaseJournal): Map<string, string> {
  return new Map(
    journal
      .acknowledgedCommands()
      .flatMap((ack) =>
        ack.command.op === 'create' &&
        ack.subjectId &&
        ack.command.source.source === 'vndb_cross_media' &&
        ack.command.source.converter_revision === adapterRevision
          ? [[ack.command.source.external_id, ack.subjectId] as const]
          : [],
      ),
  );
}

function isTagVocabularyCommand(command: BatchCommand): boolean {
  return (
    command.source.source === 'vndb_cross_media' &&
    [adapterRevision, vndbPublicTagParentRevision].includes(command.source.converter_revision)
  );
}

async function sendTagCommandPages(
  port: Pick<CrossMediaPort, 'batch'>,
  commands: readonly BatchCommand[],
): Promise<void> {
  for (const page of importCommandPages(commands, (command) => command)) {
    if (checkBatchWrite({ commands: [...page] }, bundledRelease).length)
      throw new TypeError('VNDB public tag vocabulary commands failed portable validation');
    await port.batch({ commands: [...page] });
  }
}

async function sendMissingTagCommands(input: {
  port: Pick<CrossMediaPort, 'batch'>;
  journal: ShowcaseJournal;
  commands: readonly BatchCommand[];
}): Promise<void> {
  const outgoingKeys = new Set(input.commands.map((command) => command.key));
  const outgoingCreates = new Set(
    input.commands.flatMap((command) => (command.op === 'create' ? [command.source.external_id] : [])),
  );
  const prepared = input.journal.preparedCommands().flatMap((row) => {
    if (!isTagVocabularyCommand(row.command)) return [];
    if (outgoingKeys.has(row.command.key)) return [row.command];
    if (row.command.op === 'create' && outgoingCreates.has(row.command.source.external_id)) return [row.command];
    return [];
  });
  if (prepared.length) await sendTagCommandPages(input.port, prepared);
  const sealed = new Map<string, string>();
  const created = new Set<string>();
  for (const row of [...input.journal.acknowledgedCommands(), ...input.journal.preparedCommands()]) {
    if (!isTagVocabularyCommand(row.command)) continue;
    sealed.set(row.command.key, row.commandDigest);
    if (row.command.op === 'create') created.add(row.command.source.external_id);
  }
  const commands = input.commands.filter((command) => {
    const digest = sealed.get(command.key);
    if (digest !== undefined) {
      if (digest !== showcaseDigest(command))
        throw new TypeError('VNDB public tag vocabulary ACK changed its command body');
      return false;
    }
    if (command.op === 'create' && created.has(command.source.external_id)) return false;
    return true;
  });
  if (commands.length) await sendTagCommandPages(input.port, commands);
}

/** Journal and propose exact source-parent assertions only while their current source tuple is open. */
export async function prepareShowcaseTagParentPublications(input: {
  evidence: readonly ShowcaseTagParentBinding[];
  port: Pick<CrossMediaPort, 'batch' | 'fence' | 'setSourceRecordMetadata'>;
  journal: ShowcaseJournal;
}): Promise<{
  acknowledgements: ShowcaseAcknowledgement[];
  gaps: CrossMediaGap[];
  unavailableTagCodes: string[];
}> {
  const commands: BatchCommand[] = [];
  const gaps: CrossMediaGap[] = [];
  const unavailable = new Set<string>();
  const byKey = new Map<string, ShowcaseTagParentBinding>();
  for (const binding of input.evidence) {
    const fence = await showcaseTagParentSourceFence(input.port.fence, binding);
    if (fence !== 'open') {
      unavailable.add(binding.child);
      gaps.push({
        source: 'vndb',
        fields: ['tags_parents.id', 'tags_parents.parent'],
        record: { id: binding.child, parent: binding.parent, path: binding.path, main: binding.main },
        reason:
          fence === 'fenced' ? 'VNDB tag parent source tuple is fenced' : 'VNDB tag parent source fence is unavailable',
      });
      continue;
    }
    const metadata = showcaseTagParentMetadata(binding);
    // Replay still obtains a current-authorized native ACK before proposing or reusing a candidate.
    await input.port.setSourceRecordMetadata({
      command: metadata,
      idempotencyKey: `vndb-tag-parent-metadata:${showcaseDigest(metadata)}`,
    });
    const command = showcaseTagParentCommand(binding);
    commands.push(command);
    byKey.set(command.key, binding);
  }
  if (commands.length) await sendMissingTagCommands({ port: input.port, journal: input.journal, commands });

  const acknowledgements: ShowcaseAcknowledgement[] = [];
  const acknowledgedByKey = new Map(input.journal.acknowledgedCommands().map((row) => [row.command.key, row]));
  for (const command of commands) {
    const acknowledgement = acknowledgedByKey.get(command.key);
    const binding = byKey.get(command.key)!;
    if (!acknowledgement) {
      unavailable.add(binding.child);
      gaps.push({
        source: 'vndb',
        fields: ['tags_parents.id', 'tags_parents.parent'],
        record: { id: binding.child, parent: binding.parent, path: binding.path, main: binding.main },
        reason: 'VNDB tag parent proposal has no acknowledged candidate',
      });
      continue;
    }
    if (acknowledgement.commandDigest !== showcaseDigest(command))
      throw new TypeError('VNDB tag parent ACK changed its exact command body');
    if (acknowledgement.command.op !== 'propose' || !acknowledgement.candidateId) {
      unavailable.add(binding.child);
      gaps.push({
        source: 'vndb',
        fields: ['tags_parents.id', 'tags_parents.parent'],
        record: { id: binding.child, parent: binding.parent, path: binding.path, main: binding.main },
        reason: 'VNDB tag parent proposal did not return a candidate',
      });
      continue;
    }
    acknowledgements.push(acknowledgement);
  }
  const descendants = new Map<string, string[]>();
  for (const binding of input.evidence) {
    const children = descendants.get(binding.parent) ?? [];
    children.push(binding.child);
    descendants.set(binding.parent, children);
  }
  const queue = [...unavailable];
  for (let offset = 0; offset < queue.length; offset += 1)
    for (const child of descendants.get(queue[offset]!) ?? [])
      if (!unavailable.has(child)) {
        unavailable.add(child);
        queue.push(child);
      }
  return { acknowledgements, gaps, unavailableTagCodes: [...unavailable].sort() };
}

/** Map journal-acknowledged tag identities into the existing known-binding file shape. */
export function knownShowcaseTagBindings(bindings: SourceVocabularyBindings): VndbPublicTagKnownBindings {
  const schemes: VndbPublicTagKnownBindings['schemes'][number][] = [];
  for (const scheme of bindings.schemes) {
    const category = categoryFromTaxonomy(scheme.taxonomy);
    if (category) schemes.push({ category, id: scheme.id });
  }
  const concepts: VndbPublicTagKnownBindings['concepts'][number][] = [];
  for (const concept of bindings.concepts) {
    const category = categoryFromTaxonomy(concept.taxonomy);
    if (category) concepts.push({ category, code: concept.code, id: concept.id });
  }
  return { schemes, concepts };
}

function identityKnownBindings(need: TagDictionaryNeed, journal: ShowcaseJournal): VndbPublicTagKnownBindings {
  const creates = ackedTagCreates(journal);
  const schemes = need.schemes.flatMap((entry) => {
    const id = creates.get(showcaseVocabularyExternalId(vocabularyKey(entry.category)));
    return id ? [{ category: entry.category, id }] : [];
  });
  const concepts = need.concepts.flatMap((entry) => {
    const id = creates.get(showcaseVocabularyExternalId(vocabularyKey(entry.category, entry.code)));
    return id ? [{ category: entry.category, code: entry.code, id }] : [];
  });
  return { schemes, concepts };
}

/** Stage only dictionary schemes then Concepts demanded by selected public-tag rows. */
export async function prepareShowcaseVndbPublicTagVocabulary(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'batch' | 'readReviewedSubject'>;
  journal: ShowcaseJournal;
  stage: 'schemes' | 'concepts';
}): Promise<ShowcaseVndbPublicTagVocabulary> {
  const need = await selectedTagNeed(input);
  if (!need)
    return {
      requirements: [],
      bindings: { releaseDigest: bundledDigest, schemes: [], concepts: [] },
      diagnostics: [],
      truncated: false,
    };
  const schemeCommands = need.schemes.flatMap((entry) =>
    vocabularyCommands({
      sourceKey: vocabularyKey(entry.category),
      sourceUri: entry.uri,
      citation: entry.citation,
      nativeType: 'skos:ConceptScheme',
      labels: { en: entry.category },
    }),
  );
  if (schemeCommands.length)
    await sendMissingTagCommands({ port: input.port, journal: input.journal, commands: schemeCommands });
  const schemeCreates = ackedTagCreates(input.journal);
  const schemeProposals = need.schemes.flatMap((entry) => {
    const subjectId = schemeCreates.get(showcaseVocabularyExternalId(vocabularyKey(entry.category)));
    return subjectId
      ? vocabularyCommands({
          sourceKey: vocabularyKey(entry.category),
          sourceUri: entry.uri,
          citation: entry.citation,
          nativeType: 'skos:ConceptScheme',
          labels: { en: entry.category },
          subjectId,
        })
      : [];
  });
  if (schemeProposals.length)
    await sendMissingTagCommands({ port: input.port, journal: input.journal, commands: schemeProposals });
  const schemeRequirements = need.schemes.map((entry) =>
    requirementFor(need.ownerKey, vocabularyKey(entry.category), entry.uri, entry.citation, 'skos:ConceptScheme'),
  );
  if (input.stage === 'schemes')
    return {
      requirements: schemeRequirements,
      bindings: await readVndbPublicTagBindings(input.port, identityKnownBindings(need, input.journal)),
      diagnostics: need.diagnostics,
      truncated: need.truncated,
    };

  const current = await readVndbPublicTagBindings(input.port, identityKnownBindings(need, input.journal));
  const currentSchemes = new Map(
    current.schemes.flatMap((entry) => {
      const category = categoryFromTaxonomy(entry.taxonomy);
      return category ? [[category, entry.id] as const] : [];
    }),
  );
  const budget = Math.max(0, showcaseLimits.vocabulary - schemeRequirements.length);
  const admittedConcepts = need.concepts.filter((entry) => currentSchemes.has(entry.category));
  const associatedConcepts = admittedConcepts.filter((entry) => need.associated.has(entry.code));
  const parentConcepts = admittedConcepts.filter((entry) => !need.associated.has(entry.code));
  const conceptEntries = [...associatedConcepts, ...parentConcepts].slice(0, budget);
  const truncated = need.truncated || admittedConcepts.length > conceptEntries.length;
  const conceptCommands = conceptEntries.flatMap((entry) =>
    vocabularyCommands({
      sourceKey: vocabularyKey(entry.category, entry.code),
      sourceUri: entry.uri,
      citation: entry.citation,
      nativeType: 'skos:Concept',
      labels: entry.labels,
    }),
  );
  if (conceptCommands.length)
    await sendMissingTagCommands({ port: input.port, journal: input.journal, commands: conceptCommands });
  const conceptCreates = ackedTagCreates(input.journal);
  const conceptProposals = conceptEntries.flatMap((entry) => {
    const subjectId = conceptCreates.get(showcaseVocabularyExternalId(vocabularyKey(entry.category, entry.code)));
    const schemeId = currentSchemes.get(entry.category);
    return subjectId && schemeId
      ? vocabularyCommands({
          sourceKey: vocabularyKey(entry.category, entry.code),
          sourceUri: entry.uri,
          citation: entry.citation,
          nativeType: 'skos:Concept',
          labels: entry.labels,
          schemeId,
          subjectId,
        })
      : [];
  });
  if (conceptProposals.length)
    await sendMissingTagCommands({ port: input.port, journal: input.journal, commands: conceptProposals });
  const conceptRequirements = conceptEntries.map((entry) =>
    requirementFor(
      need.ownerKey,
      vocabularyKey(entry.category, entry.code),
      entry.uri,
      entry.citation,
      'skos:Concept',
      currentSchemes.get(entry.category),
    ),
  );
  const blocked = need.schemes
    .filter((entry) => !currentSchemes.has(entry.category))
    .map((entry) =>
      safeTagRow('tags', { cat: entry.category }, 'VNDB public tag scheme is not current for native writes'),
    );
  const bindings = await readVndbPublicTagBindings(input.port, identityKnownBindings(need, input.journal));
  return {
    requirements: [...schemeRequirements, ...conceptRequirements],
    bindings,
    diagnostics: mergeGaps([...need.diagnostics, ...blocked]),
    truncated,
  };
}

/** Resolve only journal-acknowledged UUIDs after exact current public vocabulary checks. */
export async function readShowcaseVndbPublicTagVocabulary(input: {
  tables: CrossMediaTables;
  selectedVids: readonly string[];
  plan: CrossMediaPlan;
  port: Pick<CrossMediaPort, 'readReviewedSubject'>;
  journal: ShowcaseJournal;
}): Promise<SourceVocabularyBindings> {
  const need = await selectedTagNeed(input);
  if (!need) return { releaseDigest: bundledDigest, schemes: [], concepts: [] };
  return readVndbPublicTagBindings(input.port, identityKnownBindings(need, input.journal));
}

export type { VndbPublicTagKnownBindings };
export type { CrossMediaGap };

export type ReviewedTagCandidateVerdict = 'accepted' | 'rejected' | 'abstained' | null;
export type ReviewedTagRank = 'normal' | 'preferred' | 'deprecated';
export type ReviewedTagCandidate = Readonly<{
  id: string;
  decision: ReviewedTagCandidateVerdict;
  retracted: number | null;
  rank: ReviewedTagRank | null;
  head: number | null;
  source: { source?: string; external_id?: string } | null;
}>;
export type ReviewedTagAdoption = Readonly<{
  head: number | null;
  selection: readonly { candidate: string; rank: ReviewedTagRank }[];
}>;
export type ReviewedTagCandidatePage = Readonly<{
  candidates: readonly ReviewedTagCandidate[];
  next: string | null;
  adoption: ReviewedTagAdoption | null;
}>;
export type ReviewedTagPhase =
  | 'proposal'
  | 'acceptance'
  | 'adoption'
  | 'current-scheme'
  | 'current-concept'
  | 'membership';
export type ReviewedTagCurrentSubject = Readonly<{
  requestedId: string;
  currentId: string;
  type: string | null;
  available: boolean;
  inScheme: readonly string[];
  broader: readonly string[];
}>;
export type ReviewedTagMembershipRead = Readonly<{
  workId: string;
  property: string;
  currentId: string;
  available: boolean;
  values: readonly string[];
  weights: readonly { target: string; amount: string; metric: string }[];
}>;
export type ReviewedTagFlowResult = Readonly<{
  pages: Readonly<Record<string, ReviewedTagCandidatePage>>;
  accepted: readonly string[];
  rejected: readonly string[];
  adopted: Readonly<Record<string, ReviewedTagAdoption | null>>;
  schemes: readonly ReviewedTagCurrentSubject[];
  concepts: readonly ReviewedTagCurrentSubject[];
  membership: readonly ReviewedTagMembershipRead[];
  retiredCandidateIds: readonly string[];
}>;

const reviewedTagUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const kanaWeightMetric = 'vndbTagsRating';
const kanaWeightAmount = /^\+?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function reviewedTagRank(value: unknown): ReviewedTagRank | null {
  return value === 'normal' || value === 'preferred' || value === 'deprecated' ? value : null;
}

function reviewedTagDecision(value: unknown): ReviewedTagCandidateVerdict {
  if (value === 'accepted' || value === 'rejected' || value === 'abstained') return value;
  return null;
}

/** Native candidate pages stay closed: only the contract fields enter acceptance/adoption. */
export function readReviewedTagCandidatePage(value: unknown): ReviewedTagCandidatePage {
  const normalized = safeCandidatePage(value);
  const candidates: ReviewedTagCandidate[] = normalized.candidates.map((candidate) => {
    const row = candidate as unknown as Record<string, unknown>;
    const source = isRecord(candidate.source)
      ? {
          ...(typeof candidate.source.source === 'string' ? { source: candidate.source.source } : {}),
          ...(typeof candidate.source.external_id === 'string' ? { external_id: candidate.source.external_id } : {}),
        }
      : null;
    return {
      id: candidate.id,
      decision: reviewedTagDecision(candidate.decision),
      retracted: typeof row.retracted === 'number' && Number.isSafeInteger(row.retracted) ? row.retracted : null,
      rank: reviewedTagRank(candidate.rank),
      head: typeof candidate.head === 'number' && Number.isSafeInteger(candidate.head) ? candidate.head : null,
      source,
    };
  });
  const adoption = normalized.adoption
    ? {
        head: normalized.adoption.head ?? null,
        selection: normalized.adoption.selection ?? [],
      }
    : null;
  return {
    candidates,
    next: normalized.next as string | null,
    adoption,
  };
}

function readReviewedTagAdoptionReceipt(value: unknown): ReviewedTagAdoption | null {
  const adoption = isRecord(value) && isRecord(value.adoption) ? value.adoption : null;
  if (
    !adoption ||
    adoption.mode !== 'replace' ||
    !Number.isSafeInteger(adoption.head) ||
    (adoption.head as number) < 1 ||
    !Array.isArray(adoption.selection)
  )
    return null;
  return {
    head: adoption.head as number,
    selection: adoption.selection.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.candidate !== 'string' || !reviewedTagUuid.test(entry.candidate)) return [];
      const rank = reviewedTagRank(entry.rank);
      return rank ? [{ candidate: entry.candidate, rank }] : [];
    }),
  };
}

/** Pending acceptance excludes rejected, retracted and already accepted rows. */
export function openReviewedTagCandidates(page: ReviewedTagCandidatePage) {
  const pending = page.candidates.filter(
    (candidate) => !candidate.retracted && candidate.decision !== 'accepted' && candidate.decision !== 'rejected',
  );
  const accepted = page.candidates.filter((candidate) => !candidate.retracted && candidate.decision === 'accepted');
  const rejected = page.candidates.filter((candidate) => candidate.decision === 'rejected' || !!candidate.retracted);
  return { pending, accepted, rejected, adoption: page.adoption };
}

function pageKey(subjectId: string, property: string): string {
  return `${subjectId}:${property}`;
}

type ReviewedTagAdoptChoice =
  | { kind: 'resume'; action: string; body: NonNullable<ReturnType<typeof sealedReviewedTagAdoptBody>> }
  | { kind: 'acknowledged' }
  | { kind: 'fresh'; action: string; body: NonNullable<ReturnType<typeof sealedReviewedTagAdoptBody>> }
  | { kind: 'bound' }
  | { kind: 'refused' };

function chooseReviewedTagAdoptAction(
  journal: ShowcaseJournal,
  subjectId: string,
  property: string,
  intent: string,
  planned: NonNullable<ReturnType<typeof sealedReviewedTagAdoptBody>>,
  current: { selection: readonly { candidate: string; rank: string }[] } | null,
): ReviewedTagAdoptChoice {
  const keys = adoptResumeKeys(journal, subjectId, property, intent, planned);
  for (const action of keys) {
    const prior = journal.action(action);
    if (prior?.state !== 'prepared') continue;
    const sealed = sealedReviewedTagAdoptBody(JSON.parse(prior.body_json));
    if (!sealed) throw new TypeError('Prepared reviewed-tag adopt body is invalid');
    return { kind: 'resume', action, body: sealed };
  }
  for (const action of keys) {
    const prior = journal.action(action);
    if (prior?.state === 'refused' && reviewedTagPermanentRefusal(prior.error_code)) return { kind: 'refused' };
    if (prior?.state !== 'acknowledged') continue;
    const sealed = sealedReviewedTagAdoptBody(JSON.parse(prior.body_json));
    if (
      sealed &&
      sameAdoptionSelection(sealed.selection, planned.selection) &&
      current &&
      sameAdoptionSelection(current.selection, planned.selection)
    )
      return { kind: 'acknowledged' };
  }
  for (let generation = 0; generation < showcaseAdoptInvocationBound; generation += 1) {
    const action = showcaseAdoptGenerationKey(subjectId, property, intent, generation);
    const prior = journal.action(action);
    if (!prior) return { kind: 'fresh', action, body: planned };
    if (prior.state === 'refused' && reviewedTagStaleHead(prior.error_code))
      return { kind: 'fresh', action, body: planned };
  }
  const identity = showcaseAdoptIdentity(subjectId, property, intent);
  let generation = Math.max(showcaseAdoptInvocationBound, journal.adoptGeneration(identity));
  for (let step = 0; step < showcaseAdoptInvocationBound; step += 1) {
    const action = showcaseAdoptGenerationKey(subjectId, property, intent, generation);
    const prior = journal.action(action);
    if (prior?.state === 'prepared') {
      const sealed = sealedReviewedTagAdoptBody(JSON.parse(prior.body_json));
      if (!sealed) throw new TypeError('Prepared reviewed-tag adopt body is invalid');
      return { kind: 'resume', action, body: sealed };
    }
    if (!prior || (prior.state === 'refused' && reviewedTagStaleHead(prior.error_code))) {
      journal.advanceAdoptGeneration(identity, generation + 1);
      return { kind: 'fresh', action, body: planned };
    }
    generation += 1;
  }
  return { kind: 'bound' };
}

function sealedReviewedTagAdoptBody(value: unknown): {
  context: string;
  property: string;
  mode: 'replace';
  expected_head: number | null;
  selection: { candidate: string; rank: ReviewedTagRank }[];
} | null {
  if (!isRecord(value) || value.mode !== 'replace' || typeof value.property !== 'string') return null;
  if (typeof value.context !== 'string' || !Array.isArray(value.selection)) return null;
  const expected_head =
    typeof value.expected_head === 'number' && Number.isSafeInteger(value.expected_head) ? value.expected_head : null;
  const selection = value.selection.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.candidate !== 'string') return [];
    const rank = reviewedTagRank(entry.rank);
    return rank ? [{ candidate: entry.candidate, rank }] : [];
  });
  return { context: value.context, property: value.property, mode: 'replace', expected_head, selection };
}

function reviewedTagPermanentRefusal(code: string | null | undefined): boolean {
  return ['review-http-401', 'review-http-403', 'review-http-423'].includes(code ?? '');
}

function reviewedTagStaleHead(code: string | null | undefined): boolean {
  return code === 'review-http-409' || code === 'review-http-412';
}

function reviewedTagAbsentSubject(error: unknown): boolean {
  return error instanceof ImportTransportError && error.status === 404;
}

export type ReviewedTagCandidatePages = Readonly<{
  pages: readonly ReviewedTagCandidatePage[];
  candidates: readonly ReviewedTagCandidate[];
  adoption: ReviewedTagAdoption | null;
  complete: boolean;
}>;

function candidateQuery(property: string, cursor?: string) {
  return {
    property,
    context: GLOBAL_CONTEXT,
    limit: showcaseLimits.reviewPage,
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** Walk every candidate page until the listing ends or the candidate bound is reached. */
export async function loadReviewedTagCandidatePages(
  review: Pick<ShowcaseReviewPort, 'reviewedCandidates'>,
  subjectId: string,
  property: string,
): Promise<ReviewedTagCandidatePages> {
  const pages: ReviewedTagCandidatePage[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const maxPages = Math.max(1, Math.ceil(showcaseLimits.candidates / showcaseLimits.reviewPage));
  for (let index = 0; index < maxPages; index += 1) {
    const page = readReviewedTagCandidatePage(
      await review.reviewedCandidates(subjectId, candidateQuery(property, cursor)),
    );
    for (const candidate of page.candidates) {
      if (seen.has(candidate.id)) throw new TypeError('Reviewed-tag candidate page repeated an identity');
      seen.add(candidate.id);
    }
    pages.push(page);
    if (page.next === null) {
      const candidates = pages.flatMap((item) => item.candidates);
      const current = page.adoption ?? pages[0]?.adoption ?? null;
      return {
        pages,
        candidates,
        adoption: current ? { head: current.head, selection: currentCandidateSelection(candidates) } : null,
        complete: true,
      };
    }
    if (seen.size > showcaseLimits.candidates) break;
    cursor = page.next;
  }
  return {
    pages,
    candidates: pages.flatMap((item) => item.candidates),
    adoption: null,
    complete: false,
  };
}

export async function loadReviewedTagCandidatePage(
  review: Pick<ShowcaseReviewPort, 'reviewedCandidates'>,
  subjectId: string,
  property: string,
): Promise<ReviewedTagCandidatePage> {
  const loaded = await loadReviewedTagCandidatePages(review, subjectId, property);
  return {
    candidates: loaded.candidates,
    next: loaded.complete ? null : (loaded.pages.at(-1)?.next ?? null),
    adoption: loaded.adoption,
  };
}

async function sendReviewedTagAction<T>(
  journal: ShowcaseJournal,
  action: string,
  body: unknown,
  send: (sealedBody: unknown, sealedKey: string) => Promise<T>,
): Promise<T | 'skipped' | 'stale'> {
  const result = await sendSealedShowcaseAction({
    journal,
    action,
    body,
    send,
    refusalDisposition: (code) =>
      reviewedTagStaleHead(code) ? 'stale' : reviewedTagPermanentRefusal(code) ? 'refused' : 'retry',
  });
  if (result.status === 'sent') return result.receipt;
  if (result.status === 'acknowledged') return 'skipped';
  if (result.status === 'stale') return 'stale';
  if ('error' in result) throw result.error;
  return 'skipped';
}

export async function acceptPendingReviewedTagCandidates(
  review: Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'acceptReviewedCandidate'>,
  subjectId: string,
  property: string,
  journal: ShowcaseJournal,
): Promise<ReviewedTagCandidatePages> {
  const accepted = new Set<string>();
  let staleCandidate: string | null = null;
  for (;;) {
    const loaded = await loadReviewedTagCandidatePages(review, subjectId, property);
    const pending = loaded.candidates.filter(
      (candidate) =>
        !candidate.retracted &&
        candidate.decision !== 'accepted' &&
        candidate.decision !== 'rejected' &&
        !accepted.has(candidate.id),
    );
    const next = pending[0];
    if (!next) return loaded;
    const body = { context: GLOBAL_CONTEXT, expected_head: next.head };
    const action = showcaseReviewActionKey('accept', next.id, showcaseDigest({ subjectId, candidate: next.id }));
    const result = await sendReviewedTagAction(journal, action, body, (sealedBody, sealedKey) =>
      review.acceptReviewedCandidate(
        subjectId,
        next.id,
        sealedBody as { context: string; expected_head: number | null },
        sealedKey,
      ),
    );
    if (result === 'stale') {
      if (staleCandidate === next.id) throw new ImportTransportError(409);
      staleCandidate = next.id;
      continue;
    }
    staleCandidate = null;
    accepted.add(next.id);
  }
}

function adoptSelectionBody(
  loaded: ReviewedTagCandidatePages,
  property: string,
  keepExternalIds: ReadonlySet<string> | undefined,
): {
  opened: ReturnType<typeof openReviewedTagCandidates>;
  retired: string[];
  body: {
    context: string;
    property: string;
    mode: 'replace';
    expected_head: number | null;
    selection: { candidate: string; rank: ReviewedTagRank }[];
  };
} {
  const opened = openReviewedTagCandidates({
    candidates: loaded.candidates,
    next: null,
    adoption: loaded.adoption,
  });
  const retired = keepExternalIds
    ? importerOwnedReviewedTagRetirements(
        { candidates: loaded.candidates, next: null, adoption: loaded.adoption },
        keepExternalIds,
      )
    : [];
  const retiredIds = new Set(retired);
  const selections = new Map<string, ReviewedTagRank>();
  for (const item of opened.adoption?.selection ?? []) {
    if (retiredIds.has(item.candidate)) continue;
    selections.set(item.candidate, item.rank);
  }
  for (const candidate of opened.accepted) {
    if (retiredIds.has(candidate.id)) continue;
    selections.set(candidate.id, candidate.rank ?? selections.get(candidate.id) ?? 'normal');
  }
  return {
    opened,
    retired,
    body: {
      context: GLOBAL_CONTEXT,
      property,
      mode: 'replace',
      expected_head: loaded.adoption?.head ?? null,
      selection: [...selections]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidate, rank]) => ({ candidate, rank })),
    },
  };
}

export async function adoptAcceptedReviewedTagSelection(
  review: Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'adoptReviewedCandidates'>,
  subjectId: string,
  property: string,
  journal: ShowcaseJournal,
  input: { keepExternalIds?: ReadonlySet<string>; intent: string } = { intent: 'current' },
): Promise<{ adoption: ReviewedTagAdoption | null; retiredCandidateIds: readonly string[]; complete: boolean }> {
  let staleOnce = false;
  const identity = showcaseAdoptIdentity(subjectId, property, input.intent);
  for (let step = 0; step < showcaseAdoptInvocationBound; step += 1) {
    const loaded = await loadReviewedTagCandidatePages(review, subjectId, property);
    if (!loaded.complete) return { adoption: loaded.adoption, retiredCandidateIds: [], complete: false };
    const planned = adoptSelectionBody(loaded, property, input.keepExternalIds);
    if (!planned.body.selection.length && !planned.opened.adoption && !planned.retired.length)
      return { adoption: planned.opened.adoption, retiredCandidateIds: [], complete: true };

    const choice = chooseReviewedTagAdoptAction(
      journal,
      subjectId,
      property,
      input.intent,
      planned.body,
      planned.opened.adoption,
    );
    if (choice.kind === 'refused' || choice.kind === 'acknowledged')
      return { adoption: planned.opened.adoption, retiredCandidateIds: planned.retired, complete: true };
    if (choice.kind === 'bound') throw new TypeError('Reviewed-tag adopt generation bound exceeded');
    const { action, body } = choice;
    const alreadyCurrent =
      planned.opened.adoption && sameAdoptionSelection(planned.opened.adoption.selection, planned.body.selection);
    if (choice.kind === 'fresh' && alreadyCurrent)
      return { adoption: planned.opened.adoption, retiredCandidateIds: planned.retired, complete: true };
    journal.recordPendingAdopt(identity, action);
    const receipt = await sendReviewedTagAction(journal, action, body, (sealedBody, sealedKey) =>
      review.adoptReviewedCandidates(
        subjectId,
        sealedBody as {
          context: string;
          property: string;
          mode: 'replace';
          expected_head: number | null;
          selection: { candidate: string; rank: ReviewedTagRank }[];
        },
        sealedKey,
      ),
    );
    if (receipt === 'skipped') {
      if (!sameAdoptionSelection(body.selection, planned.body.selection)) continue;
      return { adoption: planned.opened.adoption, retiredCandidateIds: planned.retired, complete: true };
    }
    if (receipt === 'stale') {
      if (staleOnce) throw new ImportTransportError(409);
      staleOnce = true;
      continue;
    }
    const adoption = readReviewedTagAdoptionReceipt(receipt) ?? planned.opened.adoption;
    if (!sameAdoptionSelection(body.selection, planned.body.selection)) continue;
    return { adoption, retiredCandidateIds: planned.retired, complete: true };
  }
  throw new TypeError('Reviewed-tag adopt generation bound exceeded');
}

/** Journaled accept/adopt for one subject property, preserving editorial ranks and applying managed retirement. */
export async function reviewReviewedTagProperty(
  review: Pick<ShowcaseReviewPort, 'reviewedCandidates' | 'acceptReviewedCandidate' | 'adoptReviewedCandidates'>,
  journal: ShowcaseJournal,
  subjectId: string,
  property: string,
  input: { keepExternalIds?: ReadonlySet<string>; intent?: string } = {},
): Promise<{
  page: ReviewedTagCandidatePage;
  accepted: readonly string[];
  rejected: readonly string[];
  adoption: ReviewedTagAdoption | null;
  retiredCandidateIds: readonly string[];
  complete: boolean;
}> {
  const acceptedPages = await acceptPendingReviewedTagCandidates(review, subjectId, property, journal);
  const opened = openReviewedTagCandidates({
    candidates: acceptedPages.candidates,
    next: acceptedPages.complete ? null : (acceptedPages.pages.at(-1)?.next ?? null),
    adoption: acceptedPages.adoption,
  });
  const adopted = await adoptAcceptedReviewedTagSelection(review, subjectId, property, journal, {
    intent: input.intent ?? 'current',
    ...(input.keepExternalIds ? { keepExternalIds: input.keepExternalIds } : {}),
  });
  return {
    page: {
      candidates: acceptedPages.candidates,
      next: acceptedPages.complete ? null : (acceptedPages.pages.at(-1)?.next ?? null),
      adoption: adopted.adoption,
    },
    accepted: opened.accepted.map((candidate) => candidate.id),
    rejected: opened.rejected.map((candidate) => candidate.id),
    adoption: adopted.adoption,
    retiredCandidateIds: adopted.retiredCandidateIds,
    complete: acceptedPages.complete && adopted.complete,
  };
}

function subjectIdentity(read: ReviewedSubjectRead | null | undefined): ReviewedTagCurrentSubject['type'] {
  const type = (read?.subject as { type?: unknown } | undefined)?.type;
  return typeof type === 'string' ? type : null;
}

function subjectCanonicalId(requestedId: string, read: ReviewedSubjectRead | null | undefined): string {
  const id = (read?.subject as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' && reviewedTagUuid.test(id) ? id : requestedId;
}

/** Independent current Scheme/Concept reread; canonical redirects replace the requested id for membership. */
export async function resolveCurrentReviewedTagSubjects(
  review: Pick<ShowcaseReviewPort, 'readReviewedSubject'>,
  ids: readonly string[],
): Promise<ReviewedTagCurrentSubject[]> {
  const seen = new Set<string>();
  const resolved: ReviewedTagCurrentSubject[] = [];
  for (const requestedId of ids) {
    if (!reviewedTagUuid.test(requestedId) || seen.has(requestedId)) continue;
    seen.add(requestedId);
    try {
      const read = await review.readReviewedSubject(requestedId);
      const currentId = subjectCanonicalId(requestedId, read);
      resolved.push({
        requestedId,
        currentId,
        type: subjectIdentity(read),
        available: true,
        inScheme: statementValues(read, 'skos:inScheme'),
        broader: statementValues(read, 'skos:broader'),
      });
    } catch (error) {
      if (!reviewedTagAbsentSubject(error)) throw error;
      resolved.push({
        requestedId,
        currentId: requestedId,
        type: null,
        available: false,
        inScheme: [],
        broader: [],
      });
    }
  }
  return resolved;
}

function statementValues(read: ReviewedSubjectRead, property: string): string[] {
  const statements = (read.subject as { statements?: Record<string, unknown[]> }).statements?.[property] ?? [];
  return statements.flatMap((row) => {
    if (!isRecord(row) || !isRecord(row.value) || row.value.type !== 'value' || typeof row.value.content !== 'string')
      return [];
    return [row.value.content];
  });
}

function statementWeights(
  read: ReviewedSubjectRead,
  property: string,
): { target: string; amount: string; metric: string }[] {
  const statements = (read.subject as { statements?: Record<string, unknown[]> }).statements?.[property] ?? [];
  return statements.flatMap((row) => {
    if (!isRecord(row) || !isRecord(row.value) || row.value.type !== 'value' || typeof row.value.content !== 'string')
      return [];
    const target = row.value.content;
    const qualifiers = Array.isArray(row.qualifiers) ? row.qualifiers : [];
    const weights = qualifiers.filter(
      (part) => isRecord(part) && isRecord(part.property) && part.property.id === 'rezics:sourceTagWeight',
    );
    const metrics = qualifiers.filter(
      (part) => isRecord(part) && isRecord(part.property) && part.property.id === 'rezics:sourceTagWeightMetric',
    );
    if (weights.length !== 1 || metrics.length !== 1) return [];
    const weight = weights[0]!;
    const metric = metrics[0]!;
    if (
      !isRecord(weight) ||
      !isRecord(metric) ||
      !isRecord(weight.value) ||
      !isRecord(metric.value) ||
      weight.value.type !== 'value' ||
      metric.value.type !== 'value' ||
      typeof metric.value.content !== 'string' ||
      metric.value.content !== kanaWeightMetric ||
      !isRecord(weight.value.content) ||
      typeof weight.value.content.amount !== 'string' ||
      !kanaWeightAmount.test(weight.value.content.amount)
    )
      return [];
    const amount = weight.value.content.amount;
    const [integer, fraction = ''] = amount.replace(/^\+/u, '').split('.');
    if (
      !['0', '1', '2', '3'].includes(integer!) ||
      (integer === '0' && !/[1-9]/u.test(fraction)) ||
      (integer === '3' && /[1-9]/u.test(fraction))
    )
      return [];
    return [{ target, amount, metric: kanaWeightMetric }];
  });
}

/** Public membership of selected works after current Concept identities are known. */
export async function readCurrentReviewedTagMembership(
  review: Pick<ShowcaseReviewPort, 'readReviewedSubject'>,
  works: readonly string[],
  properties: readonly string[] = ['schema:genre', 'schema:keywords'],
): Promise<ReviewedTagMembershipRead[]> {
  const readings: ReviewedTagMembershipRead[] = [];
  for (const workId of works) {
    if (!reviewedTagUuid.test(workId)) continue;
    let read: ReviewedSubjectRead | null = null;
    try {
      read = await review.readReviewedSubject(workId);
    } catch {
      read = null;
    }
    const currentId = subjectCanonicalId(workId, read);
    for (const property of properties) {
      readings.push({
        workId,
        property,
        currentId,
        available: !!read,
        values: read ? statementValues(read, property) : [],
        weights: read ? statementWeights(read, property) : [],
      });
    }
  }
  return readings;
}

/** Refresh retires importer-owned candidates whose source key is no longer in the current inventory. */
export function importerOwnedReviewedTagRetirements(
  page: ReviewedTagCandidatePage,
  keepExternalIds: ReadonlySet<string>,
  importerSources: readonly string[] = ['vndb', 'vndb_cross_media', 'bangumi', 'bangumi_cross_media'],
): string[] {
  const owned = new Set(importerSources);
  return page.candidates.flatMap((candidate) => {
    if (candidate.retracted || candidate.decision === 'rejected') return [];
    const source = candidate.source?.source;
    const externalId = candidate.source?.external_id;
    if (!source || !owned.has(source) || !externalId) return [];
    return keepExternalIds.has(externalId) ? [] : [candidate.id];
  });
}

const schemeReviewProperties = ['schema:url'] as const;
const conceptReviewProperties = ['schema:url', 'skos:inScheme', 'skos:broader'] as const;
const workReviewProperties = ['schema:genre', 'schema:keywords'] as const;

function allCurrent(rows: readonly ReviewedTagCurrentSubject[], requested: readonly string[]): boolean {
  if (!requested.length) return true;
  if (rows.length !== requested.length) return false;
  return rows.every((row) => row.available);
}

function reviewedTagSchemesReady(rows: readonly ReviewedTagCurrentSubject[], requested: readonly string[]): boolean {
  return allCurrent(rows, requested) && rows.every((row) => row.type === 'skos:ConceptScheme');
}

function reviewedTagParentById(
  rows: readonly ReviewedTagCurrentSubject[],
  parents: readonly ReviewedTagCurrentSubject[],
): Map<string, ReviewedTagCurrentSubject> {
  const byId = new Map<string, ReviewedTagCurrentSubject>();
  for (const row of [...rows, ...parents]) {
    byId.set(row.requestedId, row);
    byId.set(row.currentId, row);
  }
  return byId;
}

function reviewedTagSharedSchemes(
  child: readonly string[],
  parent: readonly string[],
  schemeIds: ReadonlySet<string>,
): boolean {
  return child.some((id) => schemeIds.has(id) && parent.includes(id));
}

function reviewedTagConceptsReady(
  rows: readonly ReviewedTagCurrentSubject[],
  requested: readonly string[],
  schemeIds: ReadonlySet<string>,
  parents: readonly ReviewedTagCurrentSubject[],
): boolean {
  if (!allCurrent(rows, requested)) return false;
  const byId = reviewedTagParentById(rows, parents);
  for (const row of rows) {
    if (row.type !== 'skos:Concept' || !row.inScheme.some((id) => schemeIds.has(id))) return false;
    for (const parentId of row.broader) {
      const parent = byId.get(parentId);
      if (
        !parent?.available ||
        parent.type !== 'skos:Concept' ||
        !reviewedTagSharedSchemes(row.inScheme, parent.inScheme, schemeIds)
      )
        return false;
    }
  }
  return true;
}

async function reviewProperties(
  review: ShowcaseReviewPort,
  journal: ShowcaseJournal,
  subjectIds: readonly string[],
  properties: readonly string[],
  intent: string,
  keepExternalIds: ReadonlySet<string> | undefined,
  pages: Record<string, ReviewedTagCandidatePage>,
  accepted: string[],
  rejected: string[],
  adopted: Record<string, ReviewedTagAdoption | null>,
  retiredCandidateIds: string[],
): Promise<void> {
  for (const subjectId of subjectIds) {
    for (const property of properties) {
      const reviewed = await reviewReviewedTagProperty(review, journal, subjectId, property, {
        intent,
        ...(keepExternalIds ? { keepExternalIds } : {}),
      });
      pages[pageKey(subjectId, property)] = reviewed.page;
      accepted.push(...reviewed.accepted);
      rejected.push(...reviewed.rejected);
      adopted[pageKey(subjectId, property)] = reviewed.adoption;
      retiredCandidateIds.push(...reviewed.retiredCandidateIds);
    }
  }
}

export async function completeReviewedSharedTagFlow(input: {
  review: ShowcaseReviewPort;
  journal: ShowcaseJournal;
  schemes: readonly string[];
  concepts: readonly string[];
  works: readonly string[];
  properties?: readonly string[];
  keepExternalIds?: ReadonlySet<string>;
  intent?: string;
}): Promise<ReviewedTagFlowResult> {
  const workProperties = input.properties ?? [...workReviewProperties];
  const intent = input.intent ?? showcaseDigest({ keep: [...(input.keepExternalIds ?? [])].sort() });
  const pages: Record<string, ReviewedTagCandidatePage> = {};
  const accepted: string[] = [];
  const rejected: string[] = [];
  const adopted: Record<string, ReviewedTagAdoption | null> = {};
  const retiredCandidateIds: string[] = [];
  const reviewAll = (subjectIds: readonly string[], properties: readonly string[]) =>
    reviewProperties(
      input.review,
      input.journal,
      subjectIds,
      properties,
      intent,
      input.keepExternalIds,
      pages,
      accepted,
      rejected,
      adopted,
      retiredCandidateIds,
    );

  await reviewAll(input.schemes, schemeReviewProperties);
  const schemes = await resolveCurrentReviewedTagSubjects(input.review, input.schemes);
  if (!reviewedTagSchemesReady(schemes, input.schemes)) {
    return {
      pages,
      accepted: [...new Set(accepted)],
      rejected: [...new Set(rejected)],
      adopted,
      schemes,
      concepts: [],
      membership: [],
      retiredCandidateIds: [...new Set(retiredCandidateIds)],
    };
  }

  await reviewAll(input.concepts, conceptReviewProperties);
  const concepts = await resolveCurrentReviewedTagSubjects(input.review, input.concepts);
  const schemeIds = new Set(schemes.map((row) => row.currentId));
  const knownConcepts = new Set(concepts.flatMap((row) => [row.requestedId, row.currentId]));
  const citedParents = [...new Set(concepts.flatMap((row) => row.broader).filter((id) => !knownConcepts.has(id)))];
  const parents = citedParents.length ? await resolveCurrentReviewedTagSubjects(input.review, citedParents) : [];
  if (!reviewedTagConceptsReady(concepts, input.concepts, schemeIds, parents)) {
    return {
      pages,
      accepted: [...new Set(accepted)],
      rejected: [...new Set(rejected)],
      adopted,
      schemes,
      concepts,
      membership: [],
      retiredCandidateIds: [...new Set(retiredCandidateIds)],
    };
  }

  await reviewAll(input.works, workProperties);
  const membership = await readCurrentReviewedTagMembership(input.review, input.works, workProperties);
  return {
    pages,
    accepted: [...new Set(accepted)],
    rejected: [...new Set(rejected)],
    adopted,
    schemes,
    concepts,
    membership,
    retiredCandidateIds: [...new Set(retiredCandidateIds)],
  };
}
