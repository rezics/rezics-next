import { CompositionCorrupt, CompositionUnavailable, compositionForMainVersion,
  readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { ObjectIntegrityError, ObjectUnavailable } from '../../infrastructure/immutable-objects.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readWorkBasis, fenceWorkBasis } from '../work/read-header.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid,
  unerased, WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import { WORK_CONTENTS_COST } from './read-contract.ts';

const contentPrefix = 'urn:rezics:content:revision:';
const missing = () => new WorkReadMissing('Chapter is unavailable');

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
      ...(cursor ? { after: cursor.after } : {}),
      canReadTarget: target => canReadTarget(session, target),
    });
    if (page.revision !== header.head) throw new WorkReadMoved('Composition changed');
    const items = await Promise.all(page.occurrences.map(async record => {
      const selected = record.role === 'chapter' && record.target && language
        ? await selectedContent(session, record.target, language,
          record.selection?.mode === 'fixed-revision' ? record.selection.revision : null) : null;
      return { occurrence: record.occurrence, parent: record.parent,
        role: record.role as 'group' | 'chapter', label: record.labels[0] ?? null,
        target: record.target?.startsWith('https://rezics.com/id/') ? record.target : null,
        selectedRevision: selected?.revision ?? null,
        progress: selected ? { composition: header.structure, occurrence: record.occurrence,
          selectedRevision: selected.revision } : null,
        availability: record.role === 'group' || selected ? 'available' as const : 'unavailable' as const };
    }));
    await fenceWorkBasis(session, basis);
    return { profile: 'work-contents-v1' as const, work, version: header.component,
      composition: header.structure, compositionRevision: header.head, language,
      ...pageResult(session, items, page.next
        ? encodeReadCursor(binding, session.position, page.next, header.head) : null) };
  } catch (error) { structureError(error); }
}

async function neighbor(session: WorkReadSession, header: { structure: string; generation: string },
  parent: string, segment: string, order: string, occurrence: string, direction: 'previous' | 'next',
  language: string): Promise<string | null> {
  const current = `${segment}\u0001${order}\u0001${occurrence}`;
  const rows = await session.query(`SELECT ?occurrence ?target ?pinned WHERE { GRAPH ${iri(GRAPHS.current)} {
    ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
      rv:occurrence ?occurrence ; rv:occurrenceRole rv:ChapterRole ;
      rv:orderSegment ?part ; rv:orderKey ?key ; schema:item ?target .
    ?part rv:parent ${iri(parent)} ; rv:segmentKey ?segment .
    FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    OPTIONAL { ?placement rv:selectionMode rv:FixedRevision ; rv:pinnedRevision ?pinned }
    FILTER(CONCAT(STR(?segment), "\\u0001", STR(?key), "\\u0001", STR(?occurrence)) ${direction === 'previous' ? '<' : '>'} ${lit(current)})
  } } ORDER BY ${direction === 'previous' ? 'DESC' : 'ASC'}(CONCAT(STR(?segment), "\\u0001", STR(?key), "\\u0001", STR(?occurrence))) LIMIT ${WORK_CONTENTS_COST.navigationCandidates + 1}`,
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
    if (options.revision && options.revision !== header.head) throw new WorkReadMoved('Composition revision changed');
    const language = contentLanguage(options.language, basis.selectedLanguage);
    const page = await readCompositionPage(session.deps.environment, { structure: header.structure,
      occurrence, limit: 1, canReadTarget: target => canReadTarget(session, target) });
    const record = page.occurrences[0];
    if (page.revision !== header.head) throw new WorkReadMoved('Composition changed');
    if (!record || record.state !== 'active' || record.role !== 'chapter' || !record.target
      || !record.selection) throw missing();
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
    const position = await session.query(`SELECT ?segment ?key WHERE { GRAPH ${iri(GRAPHS.current)} {
      ?placement a rv:OccurrencePlacement ; rv:generation ${iri(header.generation)} ;
        rv:occurrence ${iri(occurrence)} ; rv:orderSegment ?part ; rv:orderKey ?key .
      ?part rv:parent ${iri(record.parent)} ; rv:segmentKey ?segment . } } LIMIT 2`, 2);
    if (position.length !== 1 || !position[0]?.segment || !position[0]?.key) {
      throw new WorkReadUnavailable('Chapter order is ambiguous');
    }
    const key = position[0];
    const previous = await neighbor(session, header, record.parent, key.segment!.value,
      key.key!.value, occurrence, 'previous', language);
    const next = await neighbor(session, header, record.parent, key.segment!.value,
      key.key!.value, occurrence, 'next', language);
    await fenceWorkBasis(session, basis);
    const again = await selectedContent(session, record.target, language,
      record.selection.mode === 'fixed-revision' ? record.selection.revision : null);
    if (!await canReadTarget(session, record.target) || again?.revision !== selected.revision) throw missing();
    return { profile: 'work-chapter-v1' as const, work: header.work, version: header.component,
      composition: header.structure, compositionRevision: header.head, occurrence,
      parent: record.parent, language, selectedRevision: selected.revision,
      progress: { composition: header.structure, occurrence, selectedRevision: selected.revision },
      previous, next, content: { reference: exact.reference, serializedJson: exact.serializedJson,
        body: exact.body }, sourcePosition: session.position };
  } catch (error) { structureError(error); }
}
