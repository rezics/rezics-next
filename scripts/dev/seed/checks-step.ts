import type { SeedState } from './state.ts';
import { communityRealms } from './community-plan.ts';
import { publicWork } from './community-step.ts';
import { works } from './plan.ts';
import { checkModsDiscovery } from './official-zones-step.ts';
import { missingCoReaders, seedCoReaders } from './reading-lives-coreaders.ts';
import { coReaderWorks } from './reading-lives-plan.ts';
import { reviews } from './reviews-plan.ts';

/** The lively demo's invariants: community Realms listed, reviews on Work pages, community posts on Home and
 * co-readers behind "Readers also enjoyed". Each failure is a finding, so the seed exits non-zero. */
async function checkCommunity(state: SeedState) {
  const { api, findings } = state;
  const listed = await api.getPublic<{ items: { id: string }[] }>('/v1/realms?limit=20');
  const community = [...state.communityRealms.values()].filter(item => listed.items.some(realm => realm.id === item.realm));
  if (community.length !== communityRealms.length) {
    findings.add(`Community Realms: ${community.length}/${communityRealms.length} listed in the Realm directory`);
  }
  const context = state.ratingContext;
  const planned = new Map<string, number>();
  for (const review of reviews) planned.set(review.work, (planned.get(review.work) ?? 0) + 1);
  let shown = 0;
  for (const [id, count] of context ? planned : []) {
    const work = publicWork(state, id)?.work.work ?? state.created.get(id)?.work;
    const page = work ? await api.getPublic<{ items: unknown[] }>(`/v1/resources/${work.slice(-36)}/reviews?context=${
      encodeURIComponent(context!)}&limit=20`) : { items: [] };
    shown += page.items.length;
    if (page.items.length < count) findings.add(`Reviews: ${id} shows ${page.items.length} of ${count} planned`);
  }
  let posts = 0, cursor: string | null = null;
  const realms = new Set([...state.communityRealms.values()].map(item => item.realm));
  // A filtered New page can be empty with a cursor: Main filters a bounded candidate page.
  for (let page = 0; page < 12 && !posts; page++) {
    const feed: { items: { realm: { id: string } | null }[]; nextCursor: string | null } = await api.getPublic(
      `/v1/feed?sort=new&kinds=discussion&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    posts += feed.items.filter(item => item.realm && realms.has(item.realm.id)).length;
    cursor = feed.nextCursor;
    if (!cursor) break;
  }
  if (!posts) findings.add('Home feed: no community Realm discussions');
  const missing = await missingCoReaders(state);
  if (missing.length) findings.add(`Readers also enjoyed: no co-readers for ${missing.join(', ')}`);
  console.log(`Checks: ${community.length} community Realms listed, ${shown} reviews shown, ${posts}+ community posts on Home, co-readers for ${coReaderWorks.length - missing.length}/${coReaderWorks.length} Works.`);
}

export async function checkPublicReads(state: SeedState) {
  const { endpoints, findings } = state;
  const search = await state.optional('Public search', () => fetch(`${endpoints.main}/v1/queries`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      profile: 'public-main-phrase-v1', phrase: 'Pride and Prejudice', language: null }) }));
  if (search && !search.ok) findings.add(`Public search: HTTP ${search.status} ${
    (await search.json() as { code?: string }).code ?? 'unknown'}`);
  const recent = await state.optional('Public Work list', () => fetch(`${endpoints.main}/v1/works?limit=5`));
  if (recent && !recent.ok) {
    const body = await recent.json() as { code?: string; title?: string };
    findings.add(`Public Work list: GET /v1/works?limit=5 HTTP ${recent.status} ${body.code ?? ''}: ${body.title ?? ''}`);
  } else if (recent && (await recent.json() as { items?: unknown[] }).items?.length === 0) {
    findings.add('Public Work list: zero visible Works; metadata-only records need a selected publication');
  }
  for (const [id, receipt] of state.created) {
    await state.optional(`Work author check ${id}`, async () => {
      const author = works.find(work => work.id === id)?.author;
      const reader = author === 'moonlight' && state.penAgents.get('moonlight')
        ? { ...state.sessions[0]!, actingSubject: state.penAgents.get('moonlight')! }
        : state.sessions.find(session => session.id === author) ?? state.sessions[0]!;
      const path = `/v1/works/${receipt.work.slice(-36)}`;
      const read = (session: typeof reader) => {
        const query = `?actingSubject=${encodeURIComponent(session.actingSubject)}`;
        return Promise.all([
          state.api.get<{ items: { role: string }[] }>(`${path}/agent-credits${query}`, session.token),
          state.api.get<{ items: { role: string }[] }>(`${path}/credits${query}`, session.token),
        ]);
      };
      const [agents, sources] = await read(reader).catch(error => {
        if (reader === state.sessions[0]) throw error;
        return read(state.sessions[0]!);
      });
      if (![...agents.items, ...sources.items].some(credit => credit.role === 'author')) {
        findings.add(`Work ${id} has no credited author`);
      }
    });
  }
  await state.optional('Mods discovery refresh', () => checkModsDiscovery(state));
  // Discovery's refresh writes while the check waits. A co-reader generation pinned
  // before that wait is stale by the time Home is read, so build again once the
  // catalogue is quiet.
  await seedCoReaders(state);
  await state.optional('Community, reviews and co-readers', () => checkCommunity(state));
}
