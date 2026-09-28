import { readCompositionHeader, readPlacements } from '../structure/graph.ts';
import { readContents } from '../work-contents/read.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  unerased, type WorkReadSession } from '../work/read-session.ts';

/** One contents page, one placement batch, two Access owner batches, at most
 * twenty indexed Content variant reads, and fixed graph enrichment batches. */
export const STUDIO_CHAPTER_COST = { pageSize: 20, contentCalls: 20, graphBatches: 4,
  accessCalls: 44, graphStatements: 64 } as const;

export async function readStudioChapters(session: WorkReadSession, agent: string, book: string,
  options: { cursor?: string; language?: string }) {
  const access = session.deps.studioAccess;
  const principal = session.principal;
  if (!principal || !access || session.options.actingSubject !== agent) {
    throw new WorkReadUnavailable('Studio authority is unavailable');
  }
  const first = await access.studioWork(principal, agent, book);
  if (!first.row) throw new WorkReadMissing('Studio Book is unavailable');
  const page = await readContents(session, book, options);
  const header = await readCompositionHeader(session.deps.environment, page.composition);
  if (!header || header.head !== page.compositionRevision || header.work !== book) {
    throw new WorkReadMoved('Studio composition changed');
  }
  const chapters = page.items.filter(item => item.role === 'chapter');
  const placements = await readPlacements(session.deps.environment, header.generation,
    { occurrences: chapters.map(item => item.occurrence) });
  const byOccurrence = new Map(placements.filter(item => item.active && item.role === 'chapter')
    .map(item => [item.occurrence, item]));
  if (byOccurrence.size !== chapters.length) throw new WorkReadMoved('Studio chapters changed');
  const targets = [...new Set(placements.map(item => item.target).filter((value): value is string => !!value))];
  if (targets.length > STUDIO_CHAPTER_COST.pageSize) throw new WorkReadLimit('Studio chapter page exceeds its bound');
  const writers = await access.chapterWriters(principal, agent, targets);
  const liveRows = targets.length ? await session.query(`SELECT ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?target a schema:CreativeWork .
      FILTER NOT EXISTS { ?target rv:protectionHead ?protection } }
    ${unerased('?target')}
  } LIMIT ${targets.length + 1}`, targets.length + 1) : [];
  const liveTargets = new Set(liveRows.map(row => row.target?.value));
  const publicRows = targets.length ? await session.query(`SELECT DISTINCT ?target WHERE {
    VALUES ?target { ${targets.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?target ;
      rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
      rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      ?publication rv:contentRevision ?revision .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } LIMIT ${targets.length + 1}`, targets.length + 1) : [];
  const publicTargets = new Set(publicRows.map(row => row.target?.value));
  const content = session.deps.contentAuthoring;
  if (!content) throw new WorkReadUnavailable('Content owner is unavailable');
  const controlled = new Map<string, Awaited<ReturnType<typeof content.listVariantHeads>>>();
  for (const target of targets) {
    if (!liveTargets.has(target) || !writers.get(target)?.controlled) continue;
    if (!await access.canReadContentVariants(principal, writers.get(target)!.writer, target)) continue;
    const listed = await content.listVariantHeads(target, '', 20);
    if (listed.nextCursor) throw new WorkReadLimit('Chapter variants exceed the page budget');
    controlled.set(target, listed);
  }
  const variants = [...new Set([...controlled.values()].flatMap(list => list.items.map(item => item.id)))];
  const published = variants.length ? await session.query(`SELECT ?variant ?publication ?eligibility WHERE {
    VALUES ?variant { ${variants.map(iri).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ;
      rv:contentPublicationHead ?publication ; rv:publicSearchEligibilityHead ?eligibility . }
    GRAPH ${iri(GRAPHS.revisions)} { ?eligibility a rv:ContentSearchEligibilityDecision ;
      rv:publicationDecision ?publication ; rv:disclosure rv:Public .
      ?publication rv:contentRevision ?revision .
      FILTER NOT EXISTS { ?revision a rv:ErasedRevision } }
  } LIMIT ${variants.length + 1}`, variants.length + 1) : [];
  const publicVariants = new Set(published.map(row => row.variant?.value));
  const before = [...controlled.values()][0]?.position;
  const after = await content.ownerPosition();
  if (before && (before.dataEpoch !== after.dataEpoch || before.sequence !== after.sequence)
    || [...controlled.values()].some(list => list.position.dataEpoch !== after.dataEpoch
      || list.position.sequence !== after.sequence)) throw new WorkReadMoved('Content variants changed');
  const facts = chapters.map(item => {
    const placement = byOccurrence.get(item.occurrence)!;
    const target = placement.target ?? null;
    const owner = target ? writers.get(target) : undefined;
    if (!target || !owner?.controlled || !controlled.has(target)) {
      const disclosed = !!target && liveTargets.has(target) && publicTargets.has(target) && !!item.target;
      return { occurrence: item.occurrence, writer: disclosed ? owner?.writer ?? null : null,
        otherIdentity: false, state: disclosed ? 'published' as const : null,
        target: disclosed ? item.target : null, label: disclosed ? item.label : null,
        language: disclosed ? item.label?.language ?? null : null };
    }
    const variants = controlled.get(target)!.items;
    const selected = item.selectedRevision?.slice('urn:rezics:content:revision:'.length) ?? null;
    const selectedVariant = variants.find(variant => variant.languageTag?.toLowerCase()
      === (options.language ?? page.language ?? '').toLowerCase());
    const state = !variants.length ? 'empty' : selected && selectedVariant?.draftHead
      ? selectedVariant.draftHead === selected ? 'published' : 'changed'
      : variants.some(variant => publicVariants.has(variant.id)) ? 'published' : 'draft';
    return { occurrence: item.occurrence, writer: owner!.writer, otherIdentity: owner!.writer !== agent,
      state, target, label: item.label ?? placement.label ?? null,
      language: selectedVariant?.languageTag ?? placement.label?.language ?? null };
  });
  const again = await access.studioWork(principal, agent, book);
  if (again.stamp !== first.stamp) throw new WorkReadMoved('Studio Book authority changed');
  const finalWriters = await access.chapterWriters(principal, agent, targets);
  if (JSON.stringify([...finalWriters]) !== JSON.stringify([...writers])) {
    throw new WorkReadMoved('Studio chapter control changed');
  }
  for (const target of controlled.keys()) {
    if (!await access.canReadContentVariants(principal, writers.get(target)!.writer, target)) {
      throw new WorkReadMoved('Studio chapter access changed');
    }
  }
  const byFact = new Map(facts.map(fact => [fact.occurrence, fact]));
  const disclosedPage = { ...page, items: page.items.map(item => {
    const fact = byFact.get(item.occurrence);
    return fact && !fact.target ? { ...item, target: null, label: null,
      selectedRevision: null, progress: null, availability: 'unavailable' as const } : item;
  }) };
  return { profile: 'studio-chapters-v1' as const, page: disclosedPage, facts };
}
