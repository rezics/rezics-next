import { readCompositionHeader, readPlacements } from '../structure/graph.ts';
import { countSerialWords } from '../work/serial-projection.ts';
import { readContents } from '../work-contents/read.ts';
import { fenceStudioVariantHeads } from './variant-heads.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadLimit, WorkReadMissing, WorkReadMoved, WorkReadUnavailable,
  unerased, type WorkReadSession } from '../work/read-session.ts';

/** One contents page of one level, one placement batch, two Access owner batches, at
 * most forty indexed Content variant reads, five four-body batches for lengths,
 * and fixed graph enrichment batches. */
export const STUDIO_CHAPTER_COST = { pageSize: 20, contentCalls: 40, graphBatches: 4,
  accessCalls: 44, graphStatements: 64, bodyBatch: 4, bodyBatches: 5 } as const;

// Scripts written without spaces between words: their writers measure a manuscript in
// characters (中文“字数”, 日本語「文字数」); elsewhere writers count words.
const UNSPACED = new Set(['zh', 'ja', 'yue', 'wuu', 'lzh', 'hak', 'nan', 'cmn', 'gan', 'hsn']);

/** How long one chapter text is, in the unit its language's writers use; null for a body that is not text. */
export function manuscriptLength(body: Record<string, unknown>, language: string):
  { unit: 'characters' | 'words'; value: number } | null {
  if (typeof body.body !== 'string') return null;
  try {
    if (!UNSPACED.has(language.split('-')[0]!.toLowerCase())) return { unit: 'words', value: countSerialWords(body.body) };
    let value = 0;
    for (const { segment } of new Intl.Segmenter(language, { granularity: 'grapheme' }).segment(body.body)) {
      if (!/^\s+$/u.test(segment)) value++;
    }
    return { unit: 'characters', value };
  } catch { return null; }
}

export async function readStudioChapters(session: WorkReadSession, agent: string, book: string,
  options: { cursor?: string; language?: string; parent?: string }) {
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
    GRAPH ${iri(GRAPHS.current)} { ?target a ?targetKind . VALUES ?targetKind { schema:CreativeWork rv:Post }
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
    if (!await access.canReadContentVariants(principal, writers.get(target)!.authoritySubject!, target)) continue;
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
  const facts = chapters.map(item => {
    const placement = byOccurrence.get(item.occurrence)!;
    const target = placement.target ?? null;
    const owner = target ? writers.get(target) : undefined;
    if (!target || !owner?.controlled || !controlled.has(target)) {
      const disclosed = !!target && liveTargets.has(target) && publicTargets.has(target) && !!item.target;
      return { occurrence: item.occurrence, writer: disclosed ? owner?.writer ?? null : null,
        authoringSubject: null,
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
    return { occurrence: item.occurrence, writer: owner!.writer,
      authoringSubject: owner!.authoringSubject,
      otherIdentity: owner!.authoringSubject !== null && owner!.authoringSubject !== agent,
      state, target, label: item.label ?? placement.label ?? null,
      language: selectedVariant?.languageTag ?? placement.label?.language ?? null,
      text: selectedVariant?.draftHead ?? null };
  });
  // Words of the text the writer works on: the draft they control, else what readers get.
  const texts = facts.flatMap(fact => {
    const revision = fact.state === null ? null : 'text' in fact && fact.text ? fact.text
      : page.items.find(item => item.occurrence === fact.occurrence)?.selectedRevision
        ?.slice('urn:rezics:content:revision:'.length) ?? null;
    return revision ? [{ occurrence: fact.occurrence, revision }] : [];
  });
  const lengths = new Map<string, ReturnType<typeof manuscriptLength>>();
  for (let start = 0; start < texts.length; start += STUDIO_CHAPTER_COST.bodyBatch) {
    const batch = texts.slice(start, start + STUDIO_CHAPTER_COST.bodyBatch);
    const exact = await content.readExactBatch(batch.map(item => item.revision), async ids => new Set(ids));
    for (const [index, result] of exact.entries()) {
      const fact = facts.find(item => item.occurrence === batch[index]!.occurrence);
      lengths.set(batch[index]!.occurrence, result?.status === 'available'
        ? manuscriptLength(result.body, fact?.language ?? options.language ?? page.language ?? 'und') : null);
    }
  }
  const again = await access.studioWork(principal, agent, book);
  if (again.stamp !== first.stamp) throw new WorkReadMoved('Studio Book authority changed');
  const finalWriters = await access.chapterWriters(principal, agent, targets);
  if (JSON.stringify([...finalWriters]) !== JSON.stringify([...writers])) {
    throw new WorkReadMoved('Studio chapter control changed');
  }
  for (const target of controlled.keys()) {
    if (!await access.canReadContentVariants(principal, writers.get(target)!.authoritySubject!, target)) {
      throw new WorkReadMoved('Studio chapter access changed');
    }
    await fenceStudioVariantHeads(content, target, '', 20, controlled.get(target)!);
  }
  const byFact = new Map(facts.map(fact => [fact.occurrence, fact]));
  const counted = facts.map(({ text: _text, ...fact }: typeof facts[number] & { text?: string | null }) =>
    ({ ...fact, length: lengths.get(fact.occurrence) ?? null }));
  const disclosedPage = { ...page, items: page.items.map(item => {
    const fact = byFact.get(item.occurrence);
    return fact && !fact.target ? { ...item, target: null, label: null,
      selectedRevision: null, progress: null, availability: 'unavailable' as const } : item;
  }) };
  return { profile: 'studio-chapters-v1' as const, page: disclosedPage, facts: counted };
}
