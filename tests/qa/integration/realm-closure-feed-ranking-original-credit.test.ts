import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions } from '../support/personas.ts';
import { publishFeedOriginals } from './outcomes/realm/closure-feed.test.ts';
import { publishRankingOriginals } from './outcomes/realm/closure-rankings.test.ts';

test('local feed and ranking original setups consume creation author credit publicly', async () => {
  const started = performance.now();
  const sessions = await personaSessions('public');
  type Credit = { id: string; agent: string; role: string };
  const requests: { method: string; path: string; body?: unknown; idempotencyKey?: string;
    caller: string | null; actingSubject: string | null; elapsedMs: number; sinceStartMs: number;
    answer: { status: number; body: string } }[] = [];
  for (const person of [sessions.owner, sessions.visitor]) {
    const call = person.main;
    person.main = async (method, path, body, key, options) => {
      const idempotencyKey = key ?? (method === 'POST' ? randomUUID() : undefined);
      const at = performance.now();
      const response = await call(method, path, body, idempotencyKey, options);
      requests.push({ method, path, body, idempotencyKey, caller: person.accountId,
        actingSubject: person.actingSubject, elapsedMs: performance.now() - at,
        sinceStartMs: performance.now() - started,
        answer: { status: response.status, body: await response.clone().text() } });
      return response;
    };
  }
  try {
    for (const publish of [publishFeedOriginals, publishRankingOriginals]) {
      const originals: Parameters<typeof publish>[1] = [];
      // Call the actual local setup functions used by the whole journeys.
      await publish(sessions, originals);
      expect(originals).toHaveLength(3);
      for (const original of originals) {
        const root = `/v1/works/${original.work.slice(-36)}`;
        const supplied = requests.find(request => request.method === 'GET'
          && request.path.startsWith(`${root}/agent-credits?`))!;
        expect(supplied.caller).toBe(sessions.owner.accountId);
        expect(supplied.answer.status).toBe(200);
        const initial = JSON.parse(supplied.answer.body) as { items: Credit[]; nextCursor: string | null };
        expect(initial.items).toHaveLength(1);
        expect(initial.items[0]).toMatchObject({ agent: sessions.owner.actingSubject, role: 'author' });
        const work = await sessions.visitor.main('GET', root);
        expect(work.status).toBe(200);
        expect(await work.json()).toMatchObject({ disclosure: 'public', mainVersion: original.mainVersion });
        const credits = await sessions.visitor.main('GET', `${root}/agent-credits`);
        expect(credits.status).toBe(200);
        expect(await credits.json()).toMatchObject({ items: initial.items, nextCursor: null });
        expect(requests.filter(request => request.method === 'POST'
          && request.path === `${root}/agent-credits`)).toHaveLength(0);
      }
    }
  } finally {
    console.log('Local original credit regression', JSON.stringify({ preparationSeconds: sessions.elapsedSeconds,
      journeySeconds: (performance.now() - started) / 1000 - sessions.elapsedSeconds, requests }));
    await sessions.close();
  }
}, 360_000);
