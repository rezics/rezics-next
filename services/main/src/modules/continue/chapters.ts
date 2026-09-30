import type { VerifiedPrincipal } from '../access/admission.ts';
import { readCompositionPage } from '../structure/read.ts';
import { CompositionCorrupt, CompositionUnavailable } from '../structure/graph.ts';
import { nextChapter } from '../structure/reading-order.ts';
import type { OccurrenceRecord } from '../structure/format.ts';
import { StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { firstChapterHeading } from '../work-contents/read.ts';
import { unerased, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { chooseMainLanguage, MAIN_LANGUAGE_LIMIT } from '../work/selection-heads.ts';
import type { WorkProgress } from '../library/status.ts';
import { CONTINUE_COST } from './contract.ts';

type Chapter = { occurrence: string; title: string | null; language: string;
  unreadCount: { value: number; kind: 'exact' | 'lower-bound' } };
type Candidate = { work: string; structure: string; language: string; record: OccurrenceRecord;
  pageCount: number; ordinal: number };
const chapterLabel = (record: OccurrenceRecord, language: string) =>
  record.labels.find(label => label.language.toLowerCase() === language)
  ?? record.labels.find(label => label.language.toLowerCase().split('-')[0] === language.split('-')[0])
  ?? record.labels[0];

/** Seek by order key; the number of object pages and graph rows is bounded by Works,
 * even when one Book has thousands of placements. The next chapter follows
 * reading order, so a finished volume continues into the next one. */
async function nextRecord(session: WorkReadSession, structure: string, progress?: WorkProgress) {
  const env = session.deps.environment;
  const visible = async () => true; // Publication is checked in one batch below.
  if (!progress) {
    const first = await nextChapter(env, { structure, canReadTarget: visible });
    return first ? { record: first.record, pageCount: first.page.placementCount, ordinal: 1 } : null;
  }
  const current = await readCompositionPage(env, { structure, occurrence: progress.occurrence,
    limit: 1, canReadTarget: visible });
  const record = current.occurrences[0];
  if (!record || record.state !== 'active' || record.role !== 'chapter'
    || !record.segmentKey || !record.orderKey) return null;
  if (!progress.completed) return { record, pageCount: current.placementCount,
    ordinal: current.occurrenceContext?.ordinal ?? 1 };
  const next = await nextChapter(env, { structure, revision: current.revision, from: record,
    canReadTarget: visible });
  if (!next) return null;
  // A chapter inside a group means a grouped Book, whose unread count is a lower bound anyway.
  const ordinal = next.record.parent !== structure ? 1 : (await readCompositionPage(env, { structure,
    revision: current.revision, occurrence: next.record.occurrence, limit: 1, canReadTarget: visible }))
    .occurrenceContext?.ordinal ?? 1;
  return { record: next.record, pageCount: next.page.placementCount, ordinal };
}

export async function continueChapters(session: WorkReadSession, principal: VerifiedPrincipal,
  works: readonly string[]): Promise<{ chapters: ReadonlyMap<string, Chapter>;
    progress: ReadonlyMap<string, WorkProgress> }> {
  const status = session.deps.libraryStatus;
  if (!status || !works.length) return { chapters: new Map(), progress: new Map() };
  const rows = await session.query(`SELECT ?work ?main ?structure ?language WHERE {
    VALUES ?work { ${works.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      ?work rv:mainVersion ?main .
      ?structure a rv:Structure ; rv:structureOf ?main ; rv:structureProfile rv:BookComposition ;
        rv:selectedGeneration ?generation .
      ?generation rv:generationState rv:Active .
      OPTIONAL { ?main rv:selectionHead ?selection }
    }
    OPTIONAL { GRAPH ${iri(GRAPHS.revisions)} {
      ?selection a rv:PublicationSelection ; rv:mainVersion ?main ; rv:language ?language ;
        rv:contribution ?contribution ; rv:publicationDecision ?decision ; rv:selectedDraft ?draft .
      ?decision rv:disclosure rv:Public . FILTER NOT EXISTS { ?draft a rv:ErasedRevision }
    } GRAPH ${iri(GRAPHS.current)} { ?contribution rv:publicationHead ?decision } }
  } LIMIT ${works.length * (MAIN_LANGUAGE_LIMIT + 1) + 1}`,
  works.length * (MAIN_LANGUAGE_LIMIT + 1));
  const byWork = new Map<string, { structure: string; main: string; languages: string[] }>();
  for (const row of rows) {
    if (!row.work || !row.main || !row.structure) throw new WorkReadUnavailable('Book composition is ambiguous');
    const work = row.work.value;
    const prior = byWork.get(work);
    if (prior && (prior.structure !== row.structure.value || prior.main !== row.main.value)) {
      throw new WorkReadUnavailable('Book composition is ambiguous');
    }
    const entry = prior ?? { structure: row.structure.value, main: row.main.value, languages: [] };
    if (row.language && !entry.languages.includes(row.language.value)) entry.languages.push(row.language.value);
    if (entry.languages.length > MAIN_LANGUAGE_LIMIT) throw new WorkReadUnavailable('Book languages exceed budget');
    byWork.set(work, entry);
  }
  const byStructure = await status.progress(principal, [...new Set([...byWork.values()].map(item => item.structure))]);
  const progress = new Map([...byWork].flatMap(([work, item]) => {
    const saved = byStructure.get(item.structure);
    return saved ? [[work, saved] as const] : [];
  }));
  const selected: Candidate[] = [];
  await Promise.all(works.map(async work => {
    const entry = byWork.get(work);
    if (!entry) return;
    const language = chooseMainLanguage(entry.languages.map(value => ({ language: value, selection: '' })))?.language;
    if (!language) return;
    let next: Awaited<ReturnType<typeof nextRecord>>;
    try { next = await nextRecord(session, entry.structure, progress.get(work)); }
    catch (error) {
      if (error instanceof CompositionUnavailable) return;
      if (error instanceof CompositionCorrupt || error instanceof StructureObjectCorrupt
        || error instanceof StructureObjectUnavailable) {
        throw new WorkReadUnavailable('Book composition is unavailable');
      }
      throw error;
    }
    if (next?.record.target) selected.push({ work, structure: entry.structure, language: language.toLowerCase(),
      record: next.record, pageCount: next.pageCount, ordinal: next.ordinal });
  }));
  if (!selected.length) return { chapters: new Map(), progress };
  const shortStructures = [...new Set(selected.filter(item => item.pageCount <= CONTINUE_COST.exactCountPlacements)
    .map(item => item.structure))];
  const groups = shortStructures.length ? await session.query(`SELECT DISTINCT ?structure WHERE {
    VALUES ?structure { ${shortStructures.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      ?structure rv:selectedGeneration ?generation .
      ?placement a rv:OccurrencePlacement ; rv:generation ?generation ; rv:occurrenceRole rv:GroupRole .
      FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
    }
  } LIMIT ${shortStructures.length + 1}`, shortStructures.length) : [];
  const grouped = new Set(groups.flatMap(row => row.structure ? [row.structure.value] : []));
  const pairs = [...new Set(selected.map(item => `${item.record.target}\0${item.language}`))]
    .map(pair => pair.split('\0') as [string, string]);
  const publications = await session.query(`SELECT ?target ?language ?revision ?variant WHERE {
    VALUES (?target ?language) { ${pairs.map(([target, language]) => `(${iri(target)} ${lit(language)})`).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} {
      ?target a schema:CreativeWork .
      ?variant a rv:ContentVariant ; rv:resource ?target ; rv:contentPublicationHead ?decision ;
        rv:publicSearchEligibilityHead ?eligibility .
    }
    GRAPH ${iri(GRAPHS.revisions)} {
      ?decision a rv:ContentPublicationDecision ; rv:resource ?target ; rv:component ?variant ;
        rv:contentRevision ?revision ; rv:contentLanguage ?publishedLanguage .
      ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?decision ;
        rv:disclosure rv:Public .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision }
    }
    FILTER(LCASE(STR(?publishedLanguage)) = ?language)
    ${unerased('?target')}
  } LIMIT ${pairs.length * 2 + 1}`, pairs.length * 2);
  const byTarget = new Map<string, { revision: string; variant: string }[]>();
  for (const row of publications) {
    if (!row.target || !row.language || !row.revision || !row.variant) {
      throw new WorkReadUnavailable('Chapter publication is incomplete');
    }
    const key = `${row.target.value}\0${row.language.value}`;
    byTarget.set(key, [...byTarget.get(key) ?? [], { revision: row.revision.value, variant: row.variant.value }]);
  }
  const titles = new Map<string, string>();
  const legacy = selected.flatMap(item => {
    const records = byTarget.get(`${item.record.target}\0${item.language}`) ?? [];
    if (records.length > 1) throw new WorkReadUnavailable('Chapter publication is ambiguous');
    const publication = records[0];
    if (!publication || item.record.selection?.mode === 'fixed-revision'
      && item.record.selection.revision !== publication.revision) return [];
    const label = chapterLabel(item.record, item.language);
    return label ? []
      : [{ item, publication }];
  });
  if (legacy.length) {
    if (!session.deps.content) throw new WorkReadUnavailable('Content owner is unavailable');
    for (let start = 0; start < legacy.length; start += 4) {
      const batch = legacy.slice(start, start + 4);
      const exact = await session.deps.content.readExactBatch(batch.map(({ publication }) =>
        publication.revision.slice('urn:rezics:content:revision:'.length)), async ids => new Set(ids));
      for (const [index, result] of exact.entries()) {
        const { item, publication } = batch[index]!;
        if (result?.status !== 'available' || result.reference.resourceId !== item.record.target
          || result.reference.variantId !== publication.variant || result.reference.language.kind !== 'tag'
          || result.reference.language.tag.toLowerCase() !== item.language) {
          throw new WorkReadUnavailable('Chapter publication differs from Content');
        }
        const heading = firstChapterHeading(result.body);
        if (heading) titles.set(item.work, heading);
      }
    }
  }
  const chapters = new Map<string, Chapter>();
  for (const item of selected) {
    const records = byTarget.get(`${item.record.target}\0${item.language}`) ?? [];
    const publication = records[0];
    if (!publication || item.record.selection?.mode === 'fixed-revision'
      && item.record.selection.revision !== publication.revision) continue;
    const label = chapterLabel(item.record, item.language);
    const title = titles.get(item.work) ?? label?.value ?? null;
    const exact = item.pageCount <= CONTINUE_COST.exactCountPlacements && !grouped.has(item.structure);
    chapters.set(item.work, { occurrence: item.record.occurrence, title, language: item.language,
      unreadCount: { value: exact ? Math.max(1, item.pageCount - item.ordinal + 1) : 1,
        kind: exact ? 'exact' : 'lower-bound' } });
  }
  return { chapters, progress };
}
