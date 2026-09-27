import { SeedApiError, type SeedApi } from './api.ts';
import { seedKey } from './plan.ts';

interface Session { id: string; token: string; actingSubject: string }
interface Item { id: string; kind: string; target: { work: string | null } }

/** Ordinary person-Agent APIs: the projection comes from publications,
 * adoptions and collections already authored by the seed, never direct SQL. */
export async function seedFeed(api: SeedApi, sessions: Session[], realms: { id: string; receipt: { realm: string } }[]) {
  let followed = 0;
  for (const [index, session] of sessions.entries()) {
    const targets = realms.map(realm => ({ id: realm.receipt.realm, kind: 'realm', key: realm.id }));
    const peer = sessions[(index + 1) % sessions.length];
    if (peer) targets.push({ id: peer.actingSubject, kind: 'agent', key: peer.id });
    for (const target of targets) {
      await api.post('/v1/follows', { profile: 'follow-command-v1', target: target.id, kind: target.kind,
        following: true, expectedRevision: null, actingSubject: session.actingSubject },
      session.token, seedKey('follow', `${session.id}:${target.kind}:${target.key}`));
      followed++;
    }
  }
  let items: Item[] = [];
  for (let attempt = 0; attempt < 30; attempt++) {
    const found: Item[] = [];
    let cursor: string | null = null, ready = false;
    for (let pageNumber = 0; pageNumber < 6 && found.length < 24; pageNumber++) {
      const response = await fetch(`${api.endpoints.main}/v1/feed?sort=new&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!response.ok && response.status !== 503 && response.status !== 409) {
        throw new SeedApiError('Home feed', response.status, (await response.text()).slice(0, 500));
      }
      if (!response.ok) { await response.body?.cancel(); ready = false; break; }
      const page = await response.json() as { items: Item[]; nextCursor: string | null; projection: { status: string } };
      found.push(...page.items); cursor = page.nextCursor;
      ready = page.projection.status === 'current';
      if (!ready || !cursor) break;
    }
    if (ready && found.length) { items = found.slice(0, 24); break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!items.length) throw new Error('Home feed has no public activity after its bounded relay wait');
  // Work follows make the signed-in New view useful even before a Realm has
  // reviewed an adoption. Only already public API results become follow targets.
  const works = [...new Set(items.flatMap(item => item.target.work ? [item.target.work] : []))];
  for (const session of sessions) for (const work of works) {
    await api.post('/v1/follows', { profile: 'follow-command-v1', target: work, kind: 'work',
      following: true, expectedRevision: null, actingSubject: session.actingSubject },
    session.token, seedKey('follow', `${session.id}:work:${work.slice(-36)}`));
    followed++;
  }
  let votes = 0;
  for (const [index, session] of sessions.entries()) {
    for (const item of items) {
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
