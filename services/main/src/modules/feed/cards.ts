import type { Static } from 'typebox';
import { GRAPHS, iri, lit, MAX_WORK_SEMANTIC_TYPES } from '../work/activate.ts';
import type { ResourceSummary } from '../media/summary.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { chapterStoryNumber, firstChapterHeading } from '../work-contents/read.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { publicWork } from '../work/public-patterns.ts';
import { FEED_COST, type feedAction, type feedCard, type FeedItem } from './contract.ts';
import type { FeedSource } from './source.ts';
import { interestSources, workKinds, workSemanticTypes } from '../work/work-kinds.ts';
import type { FeedComposition } from './compositions.ts';
import { WORK_CONTENTS_COST } from '../work-contents/read-contract.ts';

type Card = { card: Static<typeof feedCard>; primaryAction: Static<typeof feedAction> };

export interface FeedCardParts { lists: ReadonlyMap<string, Card>; hubs: ReadonlyMap<string, {
  variant: string; publication: string; revision: string; model: string;
  exact: Extract<import('../../../../content/src/core.ts').ExactReadResult,{ status: 'available' }> }>;
  chapterNumbers: ReadonlyMap<string,number | null> }

/** All list previews and hub bodies on a page use set-based owner reads.
 * Four 1 MiB Content bodies per batch retain the owner's existing byte bound. */
export async function feedCardParts(session: WorkReadSession, sources: readonly FeedSource[],
  compositions: ReadonlyMap<string, FeedComposition>, types: ReadonlyMap<string, readonly string[]>): Promise<FeedCardParts> {
  const lists = new Map<string,Card>();
  const placements = new Map<string,{ source: FeedSource; snapshot: FeedComposition; works: string[] }>();
  for (const source of sources.filter(source => source.kind === 'collection')) {
    const snapshot = compositions.get(source.target);
    if (!snapshot) continue;
    const rows = await snapshot.page(snapshot.header.structure,undefined,FEED_COST.listPlacements);
    placements.set(source.id,{ source,snapshot,works: [...new Set(rows.flatMap(row => row.role === 'member' && row.target ? [row.target] : []))] });
  }
  const all = [...new Set([...placements.values()].flatMap(row => row.works))];
  const visibleRows = all.length ? await session.query(`SELECT DISTINCT ?work WHERE {
    VALUES ?work { ${all.map(iri).join(' ')} } ${publicWork('?work','?main')}
  } LIMIT ${all.length + 1}`,all.length) : [];
  const visible = new Set(visibleRows.map(row => row.work!.value));
  const previews = [...new Set([...placements.values()].flatMap(row => row.works.filter(work => visible.has(work)).slice(0,FEED_COST.listPreview)))];
  const [summaries,previewTypes] = await Promise.all([session.summaries(previews),feedWorkTypes(session,previews)]);
  const byWork = new Map(summaries.map(row => [row.reference,row]));
  for (const [id,row] of placements) {
    const works = row.works.filter(work => visible.has(work));
    const card: Extract<FeedItem['card'],{ kind: 'list' }> = { kind: 'list',
      count: { value: works.length,kind: row.snapshot.header.placementCount > FEED_COST.listPlacements ? 'lower-bound' : 'exact' },
      works: works.slice(0,FEED_COST.listPreview).flatMap(work => {
        const summary = byWork.get(work);
        return summary?.status === 'available' && summary.type === 'work' && summary.disclosure === 'public'
          ? [{ id: work,title: summary.name,cover: summary.avatar,types: [...previewTypes.get(work) ?? []].sort() }] : [];
      }) };
    listReads.set(card,{ structure: row.snapshot.header.structure,revision: row.snapshot.header.head });
    lists.set(id,{ card,primaryAction: { kind: 'open',href: `/collections/${row.source.target.slice(-36)}` } });
  }
  const hubSources = new Map(sources.filter(source => source.work && !source.occurrence &&
    (types.get(source.work)?.some(type => type.endsWith('/PromptTemplate') || type.endsWith('/SkillPackage'))))
    .map(source => [source.work!,source]));
  const hubRows = hubSources.size ? await session.query(`SELECT * WHERE { ${[...hubSources].map(([work,source]) => `{
    { SELECT ?variant ?publication ?revision ?model WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ${iri(work)} ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility }
      GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?publication ; rv:disclosure rv:Public .
        ?publication a rv:ContentPublicationDecision ; rv:resource ${iri(work)} ; rv:component ?variant ; rv:contentRevision ?revision ; rv:contentModel ?model .
        FILTER(?model IN ("rezics-prompt-v1","rezics-skill-package-v1"))
        ${source.language ? `?publication rv:contentLanguage ${lit(source.language)} .` : ''}
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    } ORDER BY STR(?variant) LIMIT 1 } BIND(${iri(work)} AS ?work)
  }`).join(' UNION ')} }`,hubSources.size) : [];
  const hubs = new Map<string,FeedCardParts['hubs'] extends ReadonlyMap<string,infer V> ? V : never>();
  if (hubRows.length) {
    if (!session.deps.content) throw new WorkReadUnavailable('Hub Content is unavailable');
    const ids = hubRows.map(row => row.revision!.value.replace('urn:rezics:content:revision:',''));
    const prior = new Map(sources.flatMap(source => source.publishedContent ? [[source.publishedContent.revisionId,source.publishedContent] as const] : []));
    const missing = ids.filter(id => !prior.has(id));
    const fetched = (await Promise.all(Array.from({ length: Math.ceil(missing.length/4) },(_,batch) =>
      session.deps.content!.readExactBatch(missing.slice(batch*4,batch*4+4),async keys => new Set(keys))))).flat();
    const byId = new Map([...prior,...fetched.map(row => [row.revisionId,row] as const)]);
    const exacts = ids.map(id => byId.get(id));
    hubRows.forEach((row,index) => {
      const exact = exacts[index];
      if (exact?.status !== 'available' || exact.reference.resourceId !== row.work!.value
        || exact.reference.variantId !== row.variant!.value || exact.reference.model !== row.model!.value)
        throw new WorkReadUnavailable('Hub publication differs');
      hubs.set(row.work!.value,{ variant: row.variant!.value,publication: row.publication!.value,
        revision: row.revision!.value,model: row.model!.value,exact });
    });
  }
  const chapterNumbers = new Map<string,number | null>();
  const numbered: { occurrence: string; snapshot: FeedComposition; top: string; topOrdinal: number; ordinal: number }[] = [];
  for (const source of sources.filter(source => source.occurrence && source.work)) {
    const snapshot = compositions.get(source.work!);
    if (!snapshot) continue;
    const record = (await snapshot.lookup([source.occurrence!])).get(source.occurrence!);
    if (!record || record.state !== 'active') continue;
    const ordinal = await snapshot.ordinal(record);
    if (record.parent === snapshot.header.structure) { chapterNumbers.set(record.occurrence,ordinal); continue; }
    const parent = (await snapshot.lookup([record.parent])).get(record.parent);
    if (!parent || parent.state !== 'active') continue;
    if (parent.qualifier?.type === 'book-group' && parent.qualifier.division === 'extras') { chapterNumbers.set(record.occurrence,null); continue; }
    numbered.push({ occurrence: record.occurrence,snapshot,ordinal,topOrdinal: await snapshot.ordinal(parent),
      top: `${parent.segmentKey}\u0001${parent.orderKey}` });
  }
  if (numbered.length) {
    const rows = await session.query(`SELECT * WHERE { ${numbered.map(item => `{
      { SELECT (COUNT(?group) AS ?groups) (SUM(IF(?position < ${lit(item.top)} && ?division != rv:ExtrasDivision,?chapters,0)) AS ?priorChapters)
          (SUM(IF(?position < ${lit(item.top)},1,0)) AS ?priorGroups) WHERE {
        { SELECT ?group ?division (CONCAT(STR(?segment),"\\u0001",STR(?key)) AS ?position) (SUM(?members) AS ?chapters) WHERE {
          GRAPH ${iri(GRAPHS.current)} { ?placement a rv:OccurrencePlacement ; rv:generation ${iri(item.snapshot.header.generation)} ;
            rv:occurrence ?group ; rv:occurrenceRole rv:GroupRole ; rv:orderSegment ?part ; rv:orderKey ?key .
            ?part rv:parent ${iri(item.snapshot.header.structure)} ; rv:segmentKey ?segment .
            FILTER NOT EXISTS { ?placement rv:removedBy ?removal }
            OPTIONAL { ?placement rv:qualifier ?qualifier . ?qualifier rv:bookDivision ?recordedDivision }
            BIND(COALESCE(?recordedDivision,rv:PartDivision) AS ?division)
            OPTIONAL { ?children a rv:OrderSegment ; rv:generation ${iri(item.snapshot.header.generation)} ; rv:parent ?group ; rv:memberCount ?members . }
          } } GROUP BY ?group ?division ?segment ?key LIMIT ${WORK_CONTENTS_COST.topGroups + 1} }
      } } BIND(${iri(item.occurrence)} AS ?occurrence)
    }`).join(' UNION ')} }`,numbered.length);
    for (const item of numbered) {
      const row = rows.find(row => row.occurrence?.value === item.occurrence);
      if (!row || Number(row.groups?.value) > WORK_CONTENTS_COST.topGroups) chapterNumbers.set(item.occurrence,null);
      else chapterNumbers.set(item.occurrence,item.topOrdinal - 1 - Number(row.priorGroups?.value ?? 0)
        + Number(row.priorChapters?.value ?? 0) + item.ordinal);
    }
  }
  return { lists,hubs,chapterNumbers };
}
/** Use owner data only. There is no current release semver/level/changelog,
 * recipe totalTime/yield, persisted chapter word count or timed-media owner.
 * Optional fields in the card contract deliberately stay absent in those cases. */
export async function feedCardData(session: WorkReadSession, source: FeedSource,
  target: FeedItem['target'], href: string, knownTypes?: ReadonlyMap<string, readonly string[]>,
  showSpoilers = false, compositions?: ReadonlyMap<string, FeedComposition>, parts?: FeedCardParts): Promise<Card> {
  const workEvent = source.kind === 'work' || source.kind === 'added';
  const fallback: Card = { card: { kind: workEvent ? 'work' : 'activity' },
    primaryAction: workEvent && source.work ? { kind: 'want-to-read', work: source.work } : { kind: 'open', href } };
  if (source.kind === 'review' && source.readerReview) {
    const row = source.readerReview;
    return { card: { kind: 'review', review: row.id, rating: row.rating,
      scale: row.realm ? 10 : 5, spoiler: row.spoiler, helpfulCount: row.helpful_count,
      opening: row.spoiler && !showSpoilers ? null : row.body.slice(0, 400) },
    primaryAction: { kind: 'read-review', review: row.id, href } };
  }
  if (source.kind === 'collection') {
    if (parts) { const prepared = parts.lists.get(source.id); if (!prepared) throw new WorkReadMissing('List unavailable'); return prepared; }
    return listCard(session, source, href, compositions?.get(source.target));
  }
  if (!source.work || !['work', 'added', 'contribution'].includes(source.kind)) return fallback;
  if (source.occurrence) return chapterCard(session, source, source.occurrence, source.work ? compositions?.get(source.work) : undefined,parts?.chapterNumbers);
  const kinds = knownTypes?.get(source.work) ?? (await session.query(`SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(source.work)} a ?type . VALUES ?type { ${workSemanticTypes.map(type => `<${type}>`).join(' ')} }
  } } LIMIT ${workSemanticTypes.length + 1}`, workSemanticTypes.length + 1)).map(row => row.type?.value);
  // A metadata-only package, prompt or film has no playable/installable
  // revision yet. Its page remains the safe action until an owner supplies one.
  if (kinds.some(kind => kind && workKinds[kind as keyof typeof workKinds]?.primaryAction !== 'read')) {
    fallback.primaryAction = { kind: 'open', href };
  }
  if (kinds.includes('https://schema.org/Recipe')) return { ...fallback,
    card: { kind: 'recipe', ...(target.cover.kind !== 'fallback' ? { heroImage: target.cover } : {}) } };
  if (kinds.some(kind => kind && interestSources.media.workTypes.includes(kind))) {
    return { ...fallback, card: { kind: 'media' } };
  }
  if (kinds.some(kind => kind?.endsWith('/PromptTemplate') || kind?.endsWith('/SkillPackage'))) {
    const prepared = parts?.hubs.get(source.work);
    const selected = parts ? prepared ? [{ variant: { value: prepared.variant },publication: { value: prepared.publication },
      revision: { value: prepared.revision },model: { value: prepared.model } }] : [] : await session.query(`SELECT ?variant ?publication ?revision ?model WHERE {
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ${iri(source.work)} ;
        rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility }
      GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
        rv:publicationDecision ?publication ; rv:disclosure rv:Public .
        ?publication a rv:ContentPublicationDecision ; rv:resource ${iri(source.work)} ;
          rv:component ?variant ; rv:contentRevision ?revision ; rv:contentModel ?model .
        FILTER(?model IN ("rezics-prompt-v1", "rezics-skill-package-v1"))
        ${source.language ? `?publication rv:contentLanguage ${lit(source.language)} .` : ''}
        FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
    } ORDER BY STR(?variant) LIMIT 1`, 1);
    const row = selected[0];
    if (!row?.revision) return fallback;
    if (!session.deps.content) throw new WorkReadUnavailable('Content owner is unavailable');
    const id = row.revision.value.slice('urn:rezics:content:revision:'.length);
    const exact = prepared?.exact ?? (await session.deps.content.readExactBatch([id], async ids => new Set(ids)))[0];
    if (!exact || ['missing', 'erased', 'denied'].includes(exact.status)) throw new WorkReadMissing('Card content unavailable');
    if (exact.status !== 'available' || exact.reference.resourceId !== source.work
      || exact.reference.variantId !== row.variant?.value || exact.reference.model !== row.model?.value) {
      throw new WorkReadUnavailable('Card publication differs');
    }
    const fence = session.graphSnapshotFenced ? [{ variant: { value: row.variant!.value } }] : await session.query(`SELECT ?variant WHERE { GRAPH ${iri(GRAPHS.current)} {
      BIND(${iri(row.variant!.value)} AS ?variant) ?variant rv:contentPublicationHead ${iri(row.publication!.value)} ;
        rv:publicSearchEligibilityHead ?eligibility }
      GRAPH ${iri(GRAPHS.revisions)} { ?eligibility rv:publicationDecision ${iri(row.publication!.value)} ; rv:disclosure rv:Public .
        FILTER NOT EXISTS { ${iri(row.revision.value)} a rv:ErasedRevision } }
    } LIMIT 2`, 1);
    if (!fence.length) throw new WorkReadMoved('Card publication changed');
    if (exact.reference.model === 'rezics-prompt-v1' && typeof exact.body.content === 'string') return {
      card: { kind: 'prompt', preview: exact.body.content.slice(0, 400) },
      primaryAction: { kind: 'copy-prompt', work: source.work, revision: row.revision.value,
        href } };
    if (exact.reference.model === 'rezics-skill-package-v1') {
      const requirements = exact.body.packageRequirements;
      if (!Array.isArray(requirements) || requirements.length > 256) throw new WorkReadUnavailable('Skill requirements unavailable');
      const compatibilityTargets = requirements.map((entry: unknown) => {
        const value = entry as { ecosystem?: unknown; nativeSelector?: unknown; target?: unknown };
        if (typeof value?.ecosystem !== 'string' || typeof value.nativeSelector !== 'string'
          || !value.target || typeof value.target !== 'object' || Array.isArray(value.target)) {
          throw new WorkReadUnavailable('Skill requirement differs');
        }
        return { ecosystem: value.ecosystem, selector: value.nativeSelector, target: value.target as Record<string, unknown> };
      });
      return { card: { kind: 'release' }, primaryAction: { kind: 'install', work: source.work,
        revision: row.revision.value, href, compatibilityTargets } };
    }
    throw new WorkReadUnavailable('Hub publication has an invalid body');
  }
  return fallback;
}

/** What each list card was read from, so the page's final fence can check it without reading it again. */
const listReads = new WeakMap<object, { structure: string; revision: string }>();

/**
 * A public list's first page of placements: one Collection lookup, one
 * composition page, one batch naming which placed Works are public and their
 * types, and one summary batch for the first three. Only public Works leave
 * here, in the list's order; the count is exact when the page held every
 * placement and a lower bound otherwise.
 */
async function listCard(session: WorkReadSession, source: FeedSource, href: string, snapshot?: FeedComposition): Promise<Card> {
  const open: Card['primaryAction'] = { kind: 'open', href };
  const structures = snapshot ? [{ structure: { value: snapshot.header.structure } }] : await session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(source.target)} a rv:Collection ; rv:collectionState rv:Active ; rv:disclosure rv:Public ;
      rv:structure ?structure } } LIMIT 2`, 2);
  if (structures.length !== 1 || !structures[0]?.structure) throw new WorkReadMissing('List unavailable');
  const structure = structures[0].structure.value;
  // Every target is filtered by the public Work batch below before anything about it is returned.
  const page = snapshot ? { occurrences: await snapshot.page(structure, undefined, FEED_COST.listPlacements),
    revision: snapshot.header.head, next: snapshot.header.placementCount > FEED_COST.listPlacements } : await readCompositionPage(session.deps.environment, { structure,
    limit: FEED_COST.listPlacements, canReadTarget: async () => true });
  const placed = [...new Set(page.occurrences.flatMap(item => item.role === 'member' && item.target
    ? [item.target] : []))];
  const rows = placed.length ? await session.query(`SELECT DISTINCT ?work ?type WHERE {
    VALUES ?work { ${placed.map(iri).join(' ')} } ${publicWork('?work', '?main')}
    OPTIONAL { GRAPH ${iri(GRAPHS.current)} { ?work a ?type .
      VALUES ?type { ${workSemanticTypes.map(type => `<${type}>`).join(' ')} } } }
  } LIMIT ${placed.length * MAX_WORK_SEMANTIC_TYPES + 1}`, placed.length * MAX_WORK_SEMANTIC_TYPES) : [];
  const types = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.work) continue;
    const own = types.get(row.work.value) ?? [];
    if (row.type) own.push(row.type.value);
    types.set(row.work.value, own);
  }
  const works = placed.filter(work => types.has(work));
  const first = works.slice(0, FEED_COST.listPreview);
  const summaries = first.length ? await session.summaries(first) : [];
  const card = { kind: 'list' as const, count: { value: works.length, kind: page.next ? 'lower-bound' as const
    : 'exact' as const }, works: summaries.flatMap(summary => summary.status === 'available' && summary.type === 'work'
    && summary.disclosure === 'public' ? [{ id: summary.reference, title: summary.name, cover: summary.avatar,
      types: (types.get(summary.reference) ?? []).sort() }] : []) };
  listReads.set(card, { structure, revision: page.revision });
  return { card, primaryAction: open };
}

/**
 * The final fence for a list card: its composition has the head it was read
 * at, and each Work it shows still has the summary it shows, from the page's
 * final summary batch. One graph call per card; nothing is hydrated again.
 */
export async function fenceListCard(session: WorkReadSession, card: Extract<FeedItem['card'], { kind: 'list' }>,
  summaries: ReadonlyMap<string, ResourceSummary>) {
  const read = listReads.get(card);
  if (!read) throw new WorkReadMoved('List card was not read on this page');
  if (!session.graphSnapshotFenced && (await readCompositionHeader(session.deps.environment, read.structure))?.head !== read.revision) {
    throw new WorkReadMoved('List changed');
  }
  for (const work of card.works) {
    const summary = summaries.get(work.id);
    if (summary?.status !== 'available' || summary.disclosure !== 'public'
      || JSON.stringify([summary.name, summary.avatar]) !== JSON.stringify([work.title, work.cover])) {
      throw new WorkReadMoved('List Work changed');
    }
  }
}

/** One semantic-type batch for the page's Works, the relation feedCardData reads per Work. */
export async function feedWorkTypes(session: WorkReadSession, works: readonly string[]) {
  const ids = [...new Set(works)];
  const types = new Map<string, string[]>(ids.map(work => [work, []]));
  if (!ids.length) return types;
  const rows = await session.query(`SELECT ?work ?type WHERE { VALUES ?work { ${ids.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?work a ?type . VALUES ?type { ${workSemanticTypes.map(type => `<${type}>`).join(' ')} } }
  } LIMIT ${ids.length * workSemanticTypes.length + 1}`, ids.length * workSemanticTypes.length);
  for (const row of rows) if (row.work && row.type) types.get(row.work.value)?.push(row.type.value);
  return types;
}

async function chapterCard(session: WorkReadSession, source: FeedSource, occurrence: string, snapshot?: FeedComposition,
  numbers?: ReadonlyMap<string,number | null>): Promise<Card> {
  if (snapshot) {
    const record = (await snapshot.lookup([occurrence])).get(occurrence);
    const header = snapshot.header;
    if (header.profile !== 'book-composition' || header.work !== source.work || !record || record.state !== 'active'
      || record.role !== 'chapter' || record.target !== source.contentTarget || !record.selection
      || record.selection.mode === 'fixed-revision' && record.selection.revision !== source.contentRevision)
      throw new WorkReadMissing('Chapter placement unavailable');
    const label = record.labels.find(label => label.language.toLowerCase() === source.language?.toLowerCase()) ?? record.labels[0];
    const title = label && !/^(?:untitled chapter|未命名章节)$/iu.test(label.value.trim())
      ? label.value : source.excerpt ? firstChapterHeading({ body: source.excerpt }) : null;
    const ordinal = await snapshot.ordinal(record);
    const number = numbers?.has(occurrence) ? numbers.get(occurrence) : record.parent === header.structure ? ordinal
      : await chapterStoryNumber(session, header, record, { ordinal, path: [] });
    return { card: { kind: 'chapter', occurrence, parent: record.parent, ...(number ? { number } : {}),
      ...(title ? { title } : {}), ...(source.excerpt ? { excerpt: source.excerpt } : {}) },
      primaryAction: { kind: 'read-chapter', work: header.work, occurrence,
        href: `/w/${header.work.slice(-36)}/read/${occurrence.slice(-36)}${source.language ? `?language=${encodeURIComponent(source.language.toLowerCase())}` : ''}` } };
  }
  const links = await session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(occurrence)} rv:structure ?structure } } LIMIT 2`, 2);
  if (links.length !== 1 || !links[0]?.structure || !source.contentTarget) throw new WorkReadMissing('Chapter placement unavailable');
  const header = await readCompositionHeader(session.deps.environment, links[0].structure.value);
  if (!header || header.profile !== 'book-composition' || header.work !== source.work) throw new WorkReadMissing('Chapter composition unavailable');
  const page = await readCompositionPage(session.deps.environment, { structure: header.structure, header, occurrence,
    limit: 1, canReadTarget: async target => target === source.contentTarget });
  const record = page.occurrences[0];
  if (page.revision !== header.head) throw new WorkReadMoved('Chapter composition changed');
  if (!record || record.state !== 'active' || record.role !== 'chapter' || record.target !== source.contentTarget
    || !page.occurrenceContext || !record.selection || record.selection.mode === 'fixed-revision'
      && record.selection.revision !== source.contentRevision) throw new WorkReadMissing('Chapter placement unavailable');
  const after = await readCompositionHeader(session.deps.environment, header.structure);
  if (after?.head !== header.head) throw new WorkReadMoved('Chapter composition changed');
  const label = record.labels.find(label => label.language.toLowerCase() === source.language?.toLowerCase()) ?? record.labels[0];
  const title = label && !/^(?:untitled chapter|未命名章节)$/iu.test(label.value.trim())
    ? label.value : source.excerpt ? firstChapterHeading({ body: source.excerpt }) : null;
  // A chapter in a volume is numbered through the Book, as Contents numbers it; extras are not.
  const number = record.parent === header.structure ? page.occurrenceContext.ordinal
    : await chapterStoryNumber(session, header, record, page.occurrenceContext);
  return { card: { kind: 'chapter', occurrence, parent: record.parent, ...(number ? { number } : {}),
    ...(title ? { title } : {}), ...(source.excerpt ? { excerpt: source.excerpt } : {}) },
  primaryAction: { kind: 'read-chapter', work: header.work, occurrence,
    href: `/w/${header.work.slice(-36)}/read/${occurrence.slice(-36)}${source.language ? `?language=${encodeURIComponent(source.language.toLowerCase())}` : ''}` } };
}
