import { CompositionCorrupt, CompositionUnavailable, compositionForMainVersion,
  readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage, type CompositionPage } from '../structure/read.ts';
import { divisionOf as divisionFromIri } from '../structure/book-group.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkBasis, fenceWorkBasis } from '../work/read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadExpired, WorkReadInvalid,
  unerased, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { WORK_CONTENTS_COST } from './read-contract.ts';

const contentPrefix = 'urn:rezics:content:revision:';
const missing = () => new WorkReadMissing('Chapter is unavailable');
const localizedLabel = (labels: readonly { value: string; language: string }[], language: string) =>
  labels.find(label => label.language.toLowerCase() === language.toLowerCase())
  ?? labels.find(label => label.language.toLowerCase().split('-')[0] === language.toLowerCase().split('-')[0])
  ?? labels[0] ?? null;
const missingTitle = (label: { value: string; language: string } | null) =>
  !label || /^(?:untitled chapter|未命名章节)$/iu.test(label.value.trim());

/** Legacy imports put a chapter heading in the body but saved a placeholder label. */
export function firstChapterHeading(body: Record<string, unknown>): string | null {
  if (typeof body.body !== 'string') return null;
  for (const line of body.body.split(/\r?\n/u).slice(0, 12)) {
    const text = line.trim();
    if (!text) continue;
    const heading = /^(?:#{1,6}\s+(.+)|((?:第[一二三四五六七八九十百千万零〇两0-9]+[章节回卷部]|Chapter\s+[0-9IVXLCDM]+\b).*))$/iu.exec(text);
    return heading && (heading[1] ?? heading[2])!.trim().slice(0, 200) || null;
  }
  return null;
}

async function legacyChapterLabels(session: WorkReadSession,
  candidates: Array<{ target: string; revision: string; variant: string; language: string }>) {
  const labels = new Map<string, { value: string; language: string }>();
  const unique = [...new Map(candidates.map(item => [item.revision, item])).values()];
  if (unique.length !== new Set(candidates.map(item => `${item.revision}\0${item.target}\0${item.variant}`)).size) {
    throw new WorkReadUnavailable('Chapter publication is ambiguous');
  }
  const content = session.deps.content;
  if (!content) {
    if (!candidates.length) return labels;
    throw new WorkReadUnavailable('Content owner is unavailable');
  }
  // The Content owner caps a batch at 4 MiB; four bodies fit its per-body ceiling.
  for (let offset = 0; offset < unique.length; offset += WORK_CONTENTS_COST.legacyTitleBatch) {
    const batch = unique.slice(offset, offset + WORK_CONTENTS_COST.legacyTitleBatch);
    const revisions = batch.map(item => item.revision.slice(contentPrefix.length));
    const exacts = await content.readExactBatch(revisions, async ids => new Set(ids))
      .catch(() => { throw new WorkReadUnavailable('Content owner is unavailable'); });
    for (const [index, exact] of exacts.entries()) {
      const item = batch[index]!;
      if (exact?.status !== 'available' || exact.reference.resourceId !== item.target
        || exact.reference.variantId !== item.variant || exact.reference.language.kind !== 'tag'
        || exact.reference.language.tag.toLowerCase() !== item.language) {
        throw new WorkReadUnavailable('Chapter publication differs from its Content');
      }
      const value = firstChapterHeading(exact.body);
      if (value) labels.set(item.revision, { value, language: item.language });
    }
  }
  return labels;
}

function structureError(error: unknown): never {
  if (error instanceof CompositionUnavailable) throw missing();
  if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
    || error instanceof StructureObjectUnavailable || error instanceof ObjectIntegrityError
    || error instanceof ObjectUnavailable) throw new WorkReadUnavailable('Composition is unavailable');
  throw error;
}

async function canReadTarget(session: WorkReadSession, target: string): Promise<boolean> {
  if (session.principal && session.options.actingSubject
    && await session.deps.access.canReadWork(session.principal, session.options.actingSubject, target)) {
    const rows = await session.query(`SELECT ?target WHERE { GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(target)} AS ?target) ?target a schema:CreativeWork . }
      ${unerased('?target')} } LIMIT 2`, 1);
    if (rows.length === 1) return true;
  }
  const rows = await session.query(`SELECT DISTINCT ?target WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(target)} AS ?target) ?target a schema:CreativeWork .
      ?variant a rv:ContentVariant ; rv:resource ?target ; rv:contentPublicationHead ?decision ;
        rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
      rv:publicationDecision ?decision ; rv:disclosure rv:Public .
      ?decision rv:contentRevision ?revision .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    ${unerased('?target')}
  } LIMIT 2`, 1);
  return rows.length === 1;
}

/** Current public Content publication is the only body source, including for a private reader. */
async function selectedContent(session: WorkReadSession, target: string, language: string,
  fixed: string | null): Promise<{ revision: string; variant: string } | null> {
  const rows = await session.query(`SELECT DISTINCT ?variant ?revision WHERE {
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ${iri(target)} ;
      rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?decision a rv:ContentPublicationDecision ;
      rv:resource ${iri(target)} ; rv:component ?variant ; rv:contentRevision ?revision ;
      rv:contentLanguage ?language . }
    GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
      rv:publicationDecision ?decision ; rv:disclosure rv:Public . }
    FILTER(LCASE(STR(?language)) = ${lit(language.toLowerCase())})
    ${fixed ? `FILTER(?revision = ${iri(fixed)})` : ''}
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
  } LIMIT 2`, 2);
  if (rows.length > 1) throw new WorkReadUnavailable('Chapter language has ambiguous publications');
  const row = rows[0];
  return row?.revision && row.variant ? { revision: row.revision.value, variant: row.variant.value } : null;
}

async function composition(session: WorkReadSession, work: string, version?: string) {
  const basis = await readWorkBasis(session, work);
  if (version && version !== basis.card.mainVersion) throw missing();
  const selected = await compositionForMainVersion(session.deps.environment, basis.card.mainVersion)
    .catch(structureError);
  if (!selected) throw missing();
  const header = await readCompositionHeader(session.deps.environment, selected).catch(structureError);
  if (!header || header.profile !== 'book-composition' || header.work !== work
    || header.mainVersion !== basis.card.mainVersion) throw new WorkReadUnavailable('Composition mapping differs');
  return { basis, header };
}

type Division = 'volume' | 'part' | 'extras';
/** A group without a stated division reads as a titled part. */
const recordDivision = (record: Pick<OccurrenceRecord, 'role' | 'qualifier'>): Division | null =>
  record.role !== 'group' ? null : record.qualifier?.type === 'book-group' ? record.qualifier.division : 'part';
const position = (segment: string, key: string) => `${segment}\u0001${key}`;

/**
 * The Book's top-level groups in reading order, with their divisions and
 * chapter counts (from their order segments' member counts): enough to number
 * volumes and chapters without reading any chapter. One bounded query; a Book
 * with more groups than the budget gets no numbers.
 */
async function topGroups(session: WorkReadSession, header: { structure: string; generation: string }) {
  const rows = await session.query(`SELECT ?occurrence ?segment ?key ?division (SUM(?members) AS ?chapters) WHERE {
    GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
        rv:occurrence ?occurrence ; rv:occurrenceRole rv:GroupRole ;
        rv:orderSegment ?part ; rv:orderKey ?key .
      ?part rv:parent ${iri(header.structure)} ; rv:segmentKey ?segment .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
      OPTIONAL { ?placement rv:qualifier ?qualifier . ?qualifier a rv:BookGroup ; rv:bookDivision ?division . }
      OPTIONAL { ?children a rv:OrderSegment ; rv:generation ${iri(header.generation)} ;
        rv:parent ?occurrence ; rv:memberCount ?members . }
    } } GROUP BY ?occurrence ?segment ?key ?division LIMIT ${WORK_CONTENTS_COST.topGroups + 1}`,
  WORK_CONTENTS_COST.topGroups + 1);
  if (rows.length > WORK_CONTENTS_COST.topGroups) return null;
  return rows.map(row => ({ occurrence: row.occurrence!.value,
    position: position(row.segment!.value, row.key!.value),
    division: divisionFromIri(row.division?.value) ?? 'part' as Division,
    chapters: Number(row.chapters?.value ?? 0) }))
    .sort((a, b) => a.position < b.position ? -1 : 1);
}
type TopGroups = NonNullable<Awaited<ReturnType<typeof topGroups>>>;

/** Volume number of a top-level volume group, among the volumes before it. */
const volumeNumber = (groups: TopGroups, occurrence: string) => {
  const index = groups.filter(group => group.division === 'volume')
    .findIndex(group => group.occurrence === occurrence);
  return index < 0 ? null : index + 1;
};

/**
 * Story chapters are numbered continuously through the Book, across volumes and
 * parts, as web fiction numbers them; extras (番外) stay unnumbered. `top` is the
 * top-level item the chapter stands in: the chapter itself, or its group, with
 * its 0-based index among the top level. `inner` places the chapter in its group.
 */
function storyNumber(groups: TopGroups | null, top: { index: number; position: string },
  inner?: { index: number; division: Division }): number | null {
  if (!groups || inner?.division === 'extras') return null;
  const before = groups.filter(group => group.position < top.position);
  return top.index - before.length + before.filter(group => group.division !== 'extras')
    .reduce((total, group) => total + group.chapters, 0) + (inner?.index ?? 0) + 1;
}

/** A chapter's story number from its exact record and reading context, given the Book's top-level groups. */
function chapterNumber(groups: TopGroups | null, structure: string, record: OccurrenceRecord,
  context: NonNullable<CompositionPage['occurrenceContext']>): number | null {
  if (record.parent === structure) {
    return storyNumber(groups, { index: context.ordinal - 1, position: position(record.segmentKey!, record.orderKey!) });
  }
  const group = context.path.length === 1 ? groups?.find(item => item.occurrence === record.parent) : null;
  return group ? storyNumber(groups, { index: context.path[0]!.ordinal - 1, position: group.position },
    { index: context.ordinal - 1, division: group.division }) : null;
}

/** The story number of an exact chapter read elsewhere (a feed card), at one bounded query. */
export async function chapterStoryNumber(session: WorkReadSession, header: { structure: string; generation: string },
  record: OccurrenceRecord, context: NonNullable<CompositionPage['occurrenceContext']>): Promise<number | null> {
  return chapterNumber(await topGroups(session, header), header.structure, record, context);
}

function contentLanguage(requested: string | undefined, selected: string | null): string {
  const language = requested ?? selected;
  if (!language) throw new WorkReadInvalid('A content language is required');
  return language.toLowerCase();
}

export async function readContents(session: WorkReadSession, work: string,
  options: { version?: string; language?: string; parent?: string }) {
  try {
    const { basis, header } = await composition(session, work, options.version);
    const language = options.language ? contentLanguage(options.language, null)
      : basis.selectedLanguage?.toLowerCase() ?? null;
    const parent = options.parent ?? header.structure;
    const binding = ['contents', work, header.component, parent, language,
      session.options.actingSubject ?? null];
    const cursor = decodeReadCursor(session.options.cursor, binding, session.position);
    if (cursor && cursor.order !== header.head) throw new WorkReadMoved('Composition changed');
    const page = await readCompositionPage(session.deps.environment, {
      structure: header.structure, parent, limit: session.options.limit ?? WORK_CONTENTS_COST.pageSize,
      ...(cursor ? { after: cursor.after } : {}), outline: true,
      canReadTarget: target => canReadTarget(session, target),
    });
    if (page.revision !== header.head) throw new WorkReadMoved('Composition changed');
    const groups = await topGroups(session, header);
    const group = parent === header.structure ? null : groups?.find(item => item.occurrence === parent);
    const numbered = new Map<string, number | null>();
    for (const [index, record] of page.occurrences.entries()) {
      const at = (page.offset ?? 0) + index;
      numbered.set(record.occurrence, record.role === 'group' ? groups && volumeNumber(groups, record.occurrence)
        : !group ? parent === header.structure
          ? storyNumber(groups, { index: at, position: position(record.segmentKey!, record.orderKey!) }) : null
          : storyNumber(groups, { index: (page.parentOrdinal ?? 1) - 1, position: group.position },
            { index: at, division: group.division }));
    }

    const legacy: Array<{ target: string; revision: string; variant: string; language: string }> = [];
    const items = await Promise.all(page.occurrences.map(async record => {
      const selected = record.role === 'chapter' && record.target && language
        ? await selectedContent(session, record.target, language,
          record.selection?.mode === 'fixed-revision' ? record.selection.revision : null) : null;
      const label = localizedLabel(record.labels, language ?? '');
      if (record.target && selected && language && missingTitle(label)) {
        legacy.push({ target: record.target, revision: selected.revision,
          variant: selected.variant, language });
      }
      return { occurrence: record.occurrence, parent: record.parent,
        role: record.role as 'group' | 'chapter', label, division: recordDivision(record),
        number: numbered.get(record.occurrence) ?? null,
        childCount: record.role === 'group' ? page.childCounts?.[record.occurrence] ?? null : null,
        target: record.target?.startsWith('https://rezics.com/id/') ? record.target : null,
        selectedRevision: selected?.revision ?? null,
        progress: selected ? { composition: header.structure, occurrence: record.occurrence,
          selectedRevision: selected.revision } : null,
        availability: record.role === 'group' || selected ? 'available' as const : 'unavailable' as const };
    }));
    const derived = await legacyChapterLabels(session, legacy);
    for (const item of items) if (item.selectedRevision && missingTitle(item.label)) {
      item.label = derived.get(item.selectedRevision) ?? item.label;
    }
    await fenceWorkBasis(session, basis);
    return { profile: 'work-contents-v1' as const, work, version: header.component,
      composition: header.structure, compositionRevision: header.head, language,
      ...pageResult(session, items, page.next
        ? encodeReadCursor(binding, session.position, page.next, header.head) : null) };
  } catch (error) { structureError(error); }
}

/**
 * A chapter's place in reading order across the whole Book: a top-level
 * chapter's own position, or its group's position followed by its own, so a
 * volume's chapters sort where the volume stands. A Book nests one group level.
 */
const readingPosition = (row: { segment: string; key: string; groupSegment?: string; groupKey?: string },
  occurrence: string) => row.groupSegment !== undefined && row.groupKey !== undefined
  ? `${row.groupSegment}\u0001${row.groupKey}\u0003${row.segment}\u0001${row.key}\u0002${occurrence}`
  : `${row.segment}\u0001${row.key}\u0002${occurrence}`;
const readingPositionSparql = `IF(BOUND(?groupKey),
  CONCAT(STR(?groupSegment), "\\u0001", STR(?groupKey), "\\u0003", STR(?segment), "\\u0001", STR(?key),
    "\\u0002", STR(?occurrence)),
  CONCAT(STR(?segment), "\\u0001", STR(?key), "\\u0002", STR(?occurrence)))`;
/** The group placement, when a chapter's parent is a group of the same generation. */
const groupPosition = (generation: string) => `OPTIONAL {
    ?groupPlacement a rv:OccurrencePlacement ; rv:generation ${iri(generation)} ; rv:occurrence ?parent ;
      rv:occurrenceRole rv:GroupRole ; rv:orderSegment ?groupPart ; rv:orderKey ?groupKey .
    ?groupPart rv:segmentKey ?groupSegment .
    FILTER NOT EXISTS { ?groupPlacement rv:removedBy ?groupRemoval } }`;

async function neighbor(session: WorkReadSession, header: { structure: string; generation: string },
  current: string, direction: 'previous' | 'next', language: string): Promise<string | null> {
  const rows = await session.query(`SELECT ?occurrence ?target ?pinned WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
      rv:occurrence ?occurrence ; rv:occurrenceRole rv:ChapterRole ;
      rv:orderSegment ?part ; rv:orderKey ?key ; schema:item ?target .
    ?part rv:parent ?parent ; rv:segmentKey ?segment .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    ${groupPosition(header.generation)}
    OPTIONAL { ?placement rv:selectionMode rv:FixedRevision ; rv:pinnedRevision ?pinned }
    BIND(${readingPositionSparql} AS ?position)
    FILTER(?position ${direction === 'previous' ? '<' : '>'} ${lit(current)})
  } } ORDER BY ${direction === 'previous' ? 'DESC' : 'ASC'}(?position) LIMIT ${WORK_CONTENTS_COST.navigationCandidates + 1}`,
  WORK_CONTENTS_COST.navigationCandidates + 1);
  for (const row of rows.slice(0, WORK_CONTENTS_COST.navigationCandidates)) {
    if (row.target && await canReadTarget(session, row.target.value)
      && await selectedContent(session, row.target.value, language, row.pinned?.value ?? null)) {
      return row.occurrence!.value;
    }
  }
  if (rows.length > WORK_CONTENTS_COST.navigationCandidates) throw new WorkReadLimit('Navigation exceeds its candidate budget');
  return null;
}

export async function readChapter(session: WorkReadSession, occurrence: string,
  options: { revision?: string; language?: string }) {
  try {
    const links = await session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
      ${iri(occurrence)} rv:structure ?structure . } } LIMIT 2`, 2);
    if (!links.length) throw missing();
    if (links.length !== 1 || !links[0]?.structure) throw new WorkReadUnavailable('Chapter mapping is ambiguous');
    const header = await readCompositionHeader(session.deps.environment, links[0].structure.value)
      .catch(structureError);
    if (!header || header.profile !== 'book-composition') throw missing();
    const current = await composition(session, header.work, header.component);
    const { basis } = current;
    if (current.header.structure !== header.structure) throw missing();
    // A pinned revision that is no longer the head will not come back on a retry.
    if (options.revision && options.revision !== header.head) throw new WorkReadExpired('Composition revision changed');
    const language = contentLanguage(options.language, basis.selectedLanguage);
    const page = await readCompositionPage(session.deps.environment, { structure: header.structure,
      occurrence, limit: 1, canReadTarget: target => canReadTarget(session, target) });
    const record = page.occurrences[0];
    if (page.revision !== header.head) throw new WorkReadMoved('Composition changed');
    if (!record || record.state !== 'active' || record.role !== 'chapter' || !record.target
      || !record.selection) throw missing();
    if (!page.occurrenceContext) throw new WorkReadUnavailable('Chapter position is unavailable');
    const selected = await selectedContent(session, record.target, language,
      record.selection.mode === 'fixed-revision' ? record.selection.revision : null);
    if (!selected) throw missing();
    if (!session.deps.content) throw new WorkReadUnavailable('Content owner is unavailable');
    const revisionId = selected.revision.slice(contentPrefix.length);
    const [exact] = await session.deps.content.readExactBatch([revisionId], async ids =>
      new Set(ids.filter(id => id === revisionId)))
      .catch(() => { throw new WorkReadUnavailable('Content owner is unavailable'); });
    if (exact?.status === 'corrupt' || exact?.status === 'unavailable') {
      throw new WorkReadUnavailable('Chapter bytes are unavailable');
    }
    if (exact?.status !== 'available') throw missing();
    if (exact.reference.resourceId !== record.target || exact.reference.variantId !== selected.variant
      || exact.reference.language.kind !== 'tag'
      || exact.reference.language.tag.toLowerCase() !== language) {
      throw new WorkReadUnavailable('Content and publication disagree');
    }
    if (exact.reference.byteLength > WORK_CONTENTS_COST.bodyBytes
      || Buffer.byteLength(exact.serializedJson) > WORK_CONTENTS_COST.bodyBytes) {
      throw new WorkReadLimit('Chapter body exceeds its byte budget');
    }
    const placed = await session.query(`SELECT ?segment ?key ?groupSegment ?groupKey WHERE {
      GRAPH ${iri(GRAPHS.current)} {
        ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
          rv:occurrence ${iri(occurrence)} ; rv:orderSegment ?part ; rv:orderKey ?key .
        ?part rv:parent ?parent ; rv:segmentKey ?segment .
        FILTER(?parent = ${iri(record.parent)})
        ${groupPosition(header.generation)} } } LIMIT 2`, 2);
    const key = placed[0];
    if (placed.length !== 1 || !key?.segment || !key.key
      || record.parent !== header.structure && (!key.groupSegment || !key.groupKey)) {
      throw new WorkReadUnavailable('Chapter order is ambiguous');
    }
    const reading = readingPosition({ segment: key.segment.value, key: key.key.value,
      ...(key.groupSegment && key.groupKey ? { groupSegment: key.groupSegment.value,
        groupKey: key.groupKey.value } : {}) }, occurrence);
    const previous = await neighbor(session, header, reading, 'previous', language);
    const next = await neighbor(session, header, reading, 'next', language);
    // "Volume 2 · Chapter 3": volumes count among the Book's volumes, chapters through the Book.
    const groups = await topGroups(session, header);
    const number = chapterNumber(groups, header.structure, record, page.occurrenceContext);
    await fenceWorkBasis(session, basis);
    const again = await selectedContent(session, record.target, language,
      record.selection.mode === 'fixed-revision' ? record.selection.revision : null);
    if (!await canReadTarget(session, record.target) || again?.revision !== selected.revision) throw missing();
    const savedLabel = localizedLabel(record.labels, language);
    const heading = missingTitle(savedLabel) ? firstChapterHeading(exact.body) : null;
    return { profile: 'work-chapter-v1' as const, work: header.work, version: header.component,
      composition: header.structure, compositionRevision: header.head, occurrence,
      parent: record.parent, parentPath: page.occurrenceContext.path.map(item => ({
        occurrence: item.occurrence, label: localizedLabel(item.labels, language),
        division: recordDivision({ role: 'group', qualifier: item.qualifier }),
        number: groups ? volumeNumber(groups, item.occurrence) : null })),
      ordinal: page.occurrenceContext.ordinal, number,
      label: heading ? { value: heading, language } : savedLabel,
      language, selectedRevision: selected.revision,
      progress: { composition: header.structure, occurrence, selectedRevision: selected.revision },
      previous, next, content: { reference: exact.reference, serializedJson: exact.serializedJson,
        body: exact.body }, sourcePosition: session.position };
  } catch (error) { structureError(error); }
}
