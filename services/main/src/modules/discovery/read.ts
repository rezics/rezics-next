import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadLimit, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import type { Static } from 'typebox';
import { DISCOVERY_COST, discoveryItem, discoveryRating, type DiscoveryCredit, type DiscoveryQuery, type OwnedDiscoveryBasis,
  type DiscoveryPayload, type DiscoveryRow, type PopularTermsQuery } from './contract.ts';
import { MAX_SUMMARY_BATCH, type ResourceSummary } from '../media/summary.ts';
import { admitDiscoveryBasis } from './source.ts';
import { EMPTY_SERIAL_SUMMARY, readSerialSummaries } from '../work/summary-serial.ts';
import { canonicalChapterWorks } from '../structure/chapter-work.ts';
import { namedDiscoveryCredits } from './credits.ts';
import { readAuthorNames } from '../source/author-name-read.ts';
import type { DiscoveryProjection } from './store.ts';
import { READ_BASIS_RETENTION_MS } from '../read-basis/retention.ts';
import { optionalPreview } from '../query/optional-preview.ts';
import { Value } from 'typebox/value';
import { resourceProjectedCard } from '../query/resource-contract.ts';

export async function readDiscovery(session: WorkReadSession, projection: DiscoveryProjection, query: DiscoveryQuery) {
  const basis: OwnedDiscoveryBasis = { scope: query.scope ?? 'global', realm: query.realm ?? null,
    context: query.context ?? null, owner: null };
  const sort = query.sort ?? 'recent';
  if (sort === 'top-rated' && !basis.context) throw new WorkReadInvalid('Top-rated requires a standing rating Context');
  if (basis.scope === 'mine' && query.term) throw new WorkReadInvalid('Personal classification decisions are not defined');
  await admitDiscoveryBasis(session, basis);
  if (basis.scope === 'mine') {
    basis.owner = session.principal ? await session.deps.access.activePrincipalId(session.principal) : null;
    if (!basis.owner) throw new AccountAssertionDenied('Mine requires an active principal');
  }
  const binding = ['discovery-works-v1', basis, sort, query.type ?? '', query.term ?? '',
    query.language?.toLowerCase() ?? null];
  const cursor = decodeReadCursor(query.cursor, binding, session.position, true);
  let after: { generation: string; key: string; seen: number } | undefined;
  if (cursor) {
    try {
      after = JSON.parse(cursor.order) as typeof after;
      if (!after || !/^[0-9a-f-]{36}$/.test(after.generation) || !/^-?\d+(\.\d+)?$/.test(after.key)
        || !Number.isSafeInteger(after.seen) || after.seen < 0) throw new Error('cursor');
    } catch { throw new WorkReadInvalid('Discovery cursor is invalid'); }
  }
  const active = await projection.active(basis, session.position, after?.generation);
  const limit = query.limit ?? 20;
  const rows = await projection.page(active, sort, query.type ?? '', query.term ?? '', limit,
    after && cursor ? { key: after.key, work: cursor.after } : undefined);
  const page = rows.slice(0, limit);
  const items = await discoveryCards(session, page, query.type ?? null, query.term ? new Set([query.term]) : null);
  const final = await projection.active(basis, session.position, active.generation_id);
  const stale = active.stale || final.stale;
  const visible = stale ? query.term ? [] : items.map(item => ({ ...item,
    primaryCredits: [], rating: null,
    unavailablePreviews: [...new Set<NonNullable<Static<typeof discoveryItem>['unavailablePreviews']>[number]>([
      ...(item.unavailablePreviews ?? []), 'credits', ...(basis.context ? ['rating' as const] : [])])],
    classifications: [], match: { ...item.match, classification: null } })) : items;
  const seen = (after?.seen ?? 0) + visible.length;
  if (!Number.isSafeInteger(seen)) throw new WorkReadLimit('Discovery count exceeds its integer domain');
  const last = page.at(-1);
  const next = rows.length > limit && last ? encodeReadCursor(binding, session.position, last.work,
    JSON.stringify({ generation: active.generation_id, key: last.order_key, seen }),
    cursor?.expiresAt ?? Date.now() + READ_BASIS_RETENTION_MS) : null;
  return { profile: 'discovery-works-v1' as const, order: sort,
    scope: { kind: basis.scope, realm: basis.realm }, context: basis.context,
    matchedTerm: query.term ? visible[0]?.match.classification ?? null : null,
    generation: active.generation_id, stale,
    projectionPosition: { dataEpoch: active.source_epoch, sequence: active.source_sequence },
    ...pageResult(session, visible, next), matches: { value: seen, kind: next || stale ? 'lower-bound' as const : 'exact' as const } };
}

/**
 * Cards for projected rows, in their order. Works no longer public, and chapter
 * Works shown through their book, are left out. With `terms`, each row was
 * reached by one of those Senses: its match must carry one, and a Work whose
 * matched Concept can no longer be named is left out.
 */
export async function discoveryCards(session: WorkReadSession, page: readonly DiscoveryRow[], type: string | null,
  terms: ReadonlySet<string> | null): Promise<Static<typeof discoveryItem>[]> {
  const ids = page.map(row => row.work);
  const chapterParents = await canonicalChapterWorks(session, ids);
  // Retained ordering is independent of live title/cover disclosure. Stale
  // classification/credit payloads lack a current protection/erasure proof and
  // are withheld below, including term matches, until a fresh build is active.
  const summaries = await session.summaries(ids, true);
  const serial = await optionalPreview(session, () => readSerialSummaries(session, ids.filter((id, index) =>
    summaries[index]?.status === 'available' && summaries[index]?.disclosure === 'public'
    && summaries[index]?.type === 'work'), true));
  const credits = new Map(page.map(row => [row.work, row.payload.primaryCredits]));
  for (const [work, preview] of credits) {
    if (!Value.Check(resourceProjectedCard.properties.primaryCredits, preview)
      || new Set(preview.map(credit => credit.id)).size !== preview.length) credits.delete(work);
  }
  const creditNames = await optionalPreview(session, () => namedDiscoveryCredits(session,
    [...credits.values()].flat(), DISCOVERY_COST.pageSize, true));
  const sourceNames = await optionalPreview(session, () => readAuthorNames(session, [...credits.values()].flat()
    .flatMap(credit => credit.participantKind === 'external-reference' ? [credit.key] : []), true));
  const concepts = [...new Set(page.flatMap(row => [
    ...(row.payload.classifications ?? []).map(tag => tag.concept),
    ...(row.payload.classification ? [row.payload.classification.concept] : []),
  ]))];
  const names = new Map<string, ResourceSummary>();
  for (let offset = 0; offset < concepts.length; offset += MAX_SUMMARY_BATCH) {
    for (const summary of await session.summaries(concepts.slice(offset, offset + MAX_SUMMARY_BATCH))) {
      names.set(summary.reference, summary);
    }
  }
  const named = (tag: NonNullable<DiscoveryPayload['classification']>) => {
    const summary = names.get(tag.concept);
    return summary?.status === 'available' && summary.type === 'concept' ? { ...tag, name: summary.name } : null;
  };
  const fenced = await session.summaries(ids, true);
  return page.flatMap((row, index): Static<typeof discoveryItem>[] => {
    if (chapterParents.has(row.work)) return [];
    const summary = summaries[index];
    const current = fenced[index];
    if (summary?.status !== 'available' || summary.type !== 'work' || summary.disclosure !== 'public'
      || current?.status !== 'available' || current.disclosure !== 'public') return [];
    const payload = row.payload;
    if (terms && !terms.has(payload.classification?.sense ?? '')) {
      throw new WorkReadUnavailable('Discovery match basis is unavailable');
    }
    const classification = payload.classification ? named(payload.classification) : null;
    if (terms && !classification) return [];
    const cardCredits = credits.get(row.work);
    const ratingAvailable = Value.Check(discoveryRating, payload.rating)
      && payload.rating.sum >= payload.rating.count && payload.rating.sum <= payload.rating.count * payload.rating.scale.max
      && payload.rating.mean === payload.rating.sum / payload.rating.count;
    const serialValue = serial?.get(row.work);
    const unavailablePreviews: NonNullable<Static<typeof discoveryItem>['unavailablePreviews']> = [...(!serialValue ? ['serial' as const] : serialValue.unavailablePreviews ?? []),
      ...(!cardCredits || cardCredits.some(credit => credit.agent && !creditNames?.has(credit.agent))
        || !sourceNames && cardCredits.some(credit => credit.key) ? ['credits' as const] : []),
      ...(payload.rating !== null && !ratingAvailable ? ['rating' as const] : [])];
    return [{ id: row.work, revision: payload.revision, mainVersion: payload.mainVersion,
      types: payload.types, title: summary.name, cover: current.avatar, rating: ratingAvailable ? payload.rating : null,
      ...(serialValue ?? EMPTY_SERIAL_SUMMARY),
      ...(unavailablePreviews.length ? { unavailablePreviews } : {}),
      primaryCredits: (cardCredits ?? []).flatMap((credit): DiscoveryCredit[] => {
        if (credit.participantKind === 'external-reference') return [{ ...credit,
          displayName: null, nameSource: undefined, ...sourceNames?.get(credit.key) }];
        const name = creditNames?.get(credit.agent);
        return name ? [{ ...credit, ...name }] : [];
      }),
      classifications: (payload.classifications ?? []).flatMap(tag => { const item = named(tag); return item ? [item] : []; }),
      match: { publication: 'public-main' as const, type, classification } }];
  });
}

/** The build caches Work counts by accepted Sense; this read seeks at most 20
 * rows and names their current Concepts in the requested language. */
export async function readPopularTerms(session: WorkReadSession, projection: DiscoveryProjection,
  query: PopularTermsQuery) {
  const basis: OwnedDiscoveryBasis = { scope: query.scope ?? 'global', realm: query.realm ?? null,
    context: query.context ?? null, owner: null };
  await admitDiscoveryBasis(session, basis);
  const active = await projection.active(basis, session.position);
  const rows = await projection.popular(active, query.limit ?? DISCOVERY_COST.pageSize);
  const summaries = await session.summaries(rows.map(row => row.concept));
  const items = rows.flatMap((row, index) => {
    const summary = summaries[index];
    if (summary?.status !== 'available' || summary.type !== 'concept') return [];
    const count = Number(row.work_count);
    if (!Number.isSafeInteger(count) || count < 1) throw new WorkReadUnavailable('Popular term count is invalid');
    return [{ sense: row.term, concept: row.concept, name: summary.name, workCount: count }];
  });
  const final = await projection.active(basis, session.position, active.generation_id);
  const stale = active.stale || final.stale;
  return { profile: 'discovery-popular-terms-v1' as const,
    scope: { kind: basis.scope, realm: basis.realm }, sourcePosition: session.position,
    generation: active.generation_id, stale,
    projectionPosition: { dataEpoch: active.source_epoch, sequence: active.source_sequence },
    items: stale ? [] : items };
}
