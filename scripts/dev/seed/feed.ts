import { SeedApiError, type SeedApi } from './api.ts';
import { homeFeedTargets, type FeedItem } from './home-feed-targets.ts';
import { seedKey } from './plan.ts';

interface Session { id: string; token: string; actingSubject: string }

/** Follow a Realm, Agent or Work unless the person already does. */
export async function follow(api: SeedApi, session: Session, target: string, kind: string, key: string) {
  const state = await api.get<{ following: boolean | null; revision: string | null }>(
    `/v1/follows/${target.slice(-36)}?kind=${kind}&actingSubject=${encodeURIComponent(session.actingSubject)}`,
    session.token);
  if (state.following) return;
  await api.post('/v1/follows', { profile: 'follow-command-v1', target, kind,
    following: true, expectedRevision: state.revision, actingSubject: session.actingSubject },
  session.token, key);
}

/** Ordinary person-Agent APIs: the projection comes from publications,
 * adoptions and collections already authored by the seed, never direct SQL. */
export async function seedFeed(api: SeedApi, sessions: Session[], realms: { id: string; receipt: { realm: string } }[],
  planWorks: ReadonlySet<string>, refresh: () => Promise<void> = async () => {}) {
  let followed = 0;
  for (const [index, session] of sessions.entries()) {
    await refresh();
    const targets = realms.map(realm => ({ id: realm.receipt.realm, kind: 'realm', key: realm.id }));
    const peer = sessions[(index + 1) % sessions.length];
    if (peer) targets.push({ id: peer.actingSubject, kind: 'agent', key: peer.id });
    for (const target of targets) {
      await follow(api, session, target.id, target.kind,
        seedKey('follow', `${session.id}:${target.kind}:${target.key}:${target.id.slice(-36)}`));
      followed++;
    }
  }
  // The whole feed is read, a page of hidden activity at a time, since the plan's activity is not the newest.
  let items: FeedItem[] = [];
  let lastProjection = 'unavailable';
  for (let attempt = 0; attempt < 30; attempt++) {
    const found: FeedItem[] = [];
    let cursor: string | null = null, ready = false;
    for (let pageNumber = 0; pageNumber < 400; pageNumber++) {
      const response = await fetch(`${api.endpoints.main}/v1/feed?sort=new&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!response.ok && response.status !== 503 && response.status !== 409) {
        throw new SeedApiError('Home feed', response.status, (await response.text()).slice(0, 500));
      }
      if (!response.ok) { await response.body?.cancel(); ready = false; break; }
      const page = await response.json() as { items: FeedItem[]; nextCursor: string | null; projection: { status: string } };
      lastProjection = page.projection.status;
      found.push(...page.items); cursor = page.nextCursor;
      ready = page.projection.status === 'current';
      if (!ready || !cursor) break;
    }
    const targets = ready ? homeFeedTargets(found, planWorks) : [];
    if (targets.length) { items = targets; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!items.length) throw new Error(`Home feed has no public activity of the plan's Works after its bounded relay wait (${lastProjection})`);
  // Work follows make the signed-in New view useful even before a Realm has
  // reviewed an adoption. Only already public API results become follow targets.
  const works = [...new Set(items.flatMap(item => item.target.work ? [item.target.work] : []))];
  for (const session of sessions) for (const work of works) {
    await refresh();
    await follow(api, session, work, 'work', seedKey('follow', `${session.id}:work:${work.slice(-36)}`));
    followed++;
  }
  let votes = 0;
  for (const [index, session] of sessions.entries()) {
    await refresh();
    for (const item of items) {
      if (!/^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/.test(item.id)) continue;
      const signal = index + Number.parseInt(item.id.slice(-4), 16);
      if (signal % 4 === 0) continue;
      await api.post(`/v1/feed/${item.id.slice(-36)}/vote`, { profile: 'feed-vote-command-v1',
        value: signal % 7 === 0 ? -1 : 1, expectedRevision: null, actingSubject: session.actingSubject },
      session.token, seedKey('feed-vote', `${session.id}:${item.id.slice(-36)}`));
      votes++;
    }
  }
  return { followed, votes, activities: items.length };
}
