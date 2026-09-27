import { AccountAssertionDenied } from '../account/verify-assertion.ts';
import { decodeReadCursor, encodeReadCursor, pageResult, WorkReadInvalid, WorkReadLimit, WorkReadUnavailable,
  type WorkReadSession } from '../work/read-session.ts';
import type { Static } from 'typebox';
import { discoveryItem, type DiscoveryQuery, type OwnedDiscoveryBasis, type DiscoveryPayload } from './contract.ts';
import { MAX_SUMMARY_BATCH, type ResourceSummary } from '../media/summary.ts';
import { admitDiscoveryBasis } from './source.ts';
import type { DiscoveryProjection } from './store.ts';

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
  const cursor = decodeReadCursor(query.cursor, binding, session.position);
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
  const ids = page.map(row => row.work);
  // Projection freshness fences graph publication, types, decisions and ratings;
  // summaries recheck current title/cover disclosure without copying stored names.
  const summaries = await session.summaries(ids);
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
  const fenced = await session.summaries(ids);
  const items: Static<typeof discoveryItem>[] = page.flatMap((row, index) => {
    const summary = summaries[index];
    if (summary?.status !== 'available' || summary.type !== 'work' || fenced[index]?.status !== 'available') return [];
    const payload = row.payload;
    if (query.term && payload.classification?.sense !== query.term) {
      throw new WorkReadUnavailable('Discovery match basis is unavailable');
    }
    const classification = payload.classification ? named(payload.classification) : null;
    if (query.term && !classification) return [];
    return [{ id: row.work, revision: payload.revision, mainVersion: payload.mainVersion,
      types: payload.types, title: summary.name, cover: summary.avatar, rating: payload.rating,
      primaryCredits: payload.primaryCredits ?? [],
      classifications: (payload.classifications ?? []).flatMap(tag => { const item = named(tag); return item ? [item] : []; }),
      match: { publication: 'public-main' as const, type: query.type ?? null, classification } }];
  });
  await projection.active(basis, session.position, active.generation_id);
  const seen = (after?.seen ?? 0) + items.length;
  if (!Number.isSafeInteger(seen)) throw new WorkReadLimit('Discovery count exceeds its integer domain');
  const last = page.at(-1);
  const next = rows.length > limit && last ? encodeReadCursor(binding, session.position, last.work,
    JSON.stringify({ generation: active.generation_id, key: last.order_key, seen })) : null;
  return { profile: 'discovery-works-v1' as const, order: sort,
    scope: { kind: basis.scope, realm: basis.realm }, context: basis.context,
    matchedTerm: query.term ? items[0]?.match.classification ?? null : null,
    ...pageResult(session, items, next), matches: { value: seen, kind: next ? 'lower-bound' as const : 'exact' as const } };
}
