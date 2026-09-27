import type { Static } from 'typebox';
import { GRAPHS, iri, lit } from '../work/activate.ts';
import { readCompositionHeader } from '../structure/graph.ts';
import { readCompositionPage } from '../structure/read.ts';
import { WorkReadMissing, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import type { feedAction, feedCard, FeedItem } from './contract.ts';
import type { FeedSource } from './source.ts';
import { interestSources, workKinds, workSemanticTypes } from '../work/work-kinds.ts';

type Card = { card: Static<typeof feedCard>; primaryAction: Static<typeof feedAction> };
/** Use owner data only. There is no current release semver/level/changelog,
 * recipe totalTime/yield, persisted chapter word count or timed-media owner.
 * Optional fields in the card contract deliberately stay absent in those cases. */
export async function feedCardData(session: WorkReadSession, source: FeedSource,
  target: FeedItem['target'], href: string): Promise<Card> {
  const workEvent = source.kind === 'work' || source.kind === 'added';
  const fallback: Card = { card: { kind: workEvent ? 'work' : 'activity' },
    primaryAction: workEvent && source.work ? { kind: 'want-to-read', work: source.work } : { kind: 'open', href } };
  if (source.kind === 'review' && source.readerReview) {
    const row = source.readerReview;
    return { card: { kind: 'review', review: row.id, rating: row.rating,
      scale: row.realm ? 10 : 5, spoiler: row.spoiler, helpfulCount: row.helpful_count,
      opening: row.spoiler ? null : row.body.slice(0, 400) },
    primaryAction: { kind: 'read-review', review: row.id, href } };
  }
  if (!source.work || !['work', 'added', 'contribution'].includes(source.kind)) return fallback;
  if (source.occurrence) return chapterCard(session, source, source.occurrence);
  const types = await session.query(`SELECT ?type WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(source.work)} a ?type . VALUES ?type { ${workSemanticTypes.map(type => `<${type}>`).join(' ')} }
  } } LIMIT ${workSemanticTypes.length + 1}`, workSemanticTypes.length + 1);
  const kinds = types.map(row => row.type?.value);
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
    const selected = await session.query(`SELECT ?variant ?publication ?revision ?model WHERE {
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
    const exact = (await session.deps.content.readExactBatch([id], async ids => new Set(ids)))[0];
    if (!exact || ['missing', 'erased', 'denied'].includes(exact.status)) throw new WorkReadMissing('Card content unavailable');
    if (exact.status !== 'available' || exact.reference.resourceId !== source.work
      || exact.reference.variantId !== row.variant?.value || exact.reference.model !== row.model?.value) {
      throw new WorkReadUnavailable('Card publication differs');
    }
    const fence = await session.query(`SELECT ?variant WHERE { GRAPH ${iri(GRAPHS.current)} {
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

async function chapterCard(session: WorkReadSession, source: FeedSource, occurrence: string): Promise<Card> {
  const links = await session.query(`SELECT ?structure WHERE { GRAPH ${iri(GRAPHS.current)} {
    ${iri(occurrence)} rv:structure ?structure } } LIMIT 2`, 2);
  if (links.length !== 1 || !links[0]?.structure || !source.contentTarget) throw new WorkReadMissing('Chapter placement unavailable');
  const header = await readCompositionHeader(session.deps.environment, links[0].structure.value);
  if (!header || header.profile !== 'book-composition' || header.work !== source.work) throw new WorkReadMissing('Chapter composition unavailable');
  const page = await readCompositionPage(session.deps.environment, { structure: header.structure, occurrence,
    limit: 1, canReadTarget: async target => target === source.contentTarget });
  const record = page.occurrences[0];
  if (page.revision !== header.head) throw new WorkReadMoved('Chapter composition changed');
  if (!record || record.state !== 'active' || record.role !== 'chapter' || record.target !== source.contentTarget
    || !page.occurrenceContext || !record.selection || record.selection.mode === 'fixed-revision'
      && record.selection.revision !== source.contentRevision) throw new WorkReadMissing('Chapter placement unavailable');
  const after = await readCompositionHeader(session.deps.environment, header.structure);
  if (after?.head !== header.head) throw new WorkReadMoved('Chapter composition changed');
  const label = record.labels.find(label => label.language.toLowerCase() === source.language?.toLowerCase()) ?? record.labels[0];
  return { card: { kind: 'chapter', occurrence, parent: record.parent, number: page.occurrenceContext.ordinal,
    ...(label ? { title: label.value } : {}), ...(source.excerpt ? { excerpt: source.excerpt } : {}) },
  primaryAction: { kind: 'read-chapter', work: header.work, occurrence,
    href: `/w/${header.work.slice(-36)}/read/${occurrence.slice(-36)}${source.language ? `?language=${encodeURIComponent(source.language.toLowerCase())}` : ''}` } };
}
