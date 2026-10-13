import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { personaSessions } from '../support/personas.ts';
import { createClosureCreditEvidence, publishClosureOriginals, type ClosureOriginal }
  from './outcomes/realm/closure-original-credit-setup.ts';

test('local feed and ranking original setups consume creation author credit publicly', async () => {
  type Credit = { id: string; agent: string; role: string };
  let previousRealm: string | undefined;
  let previousAuthor: string | null | undefined;
  for (const row of ['realm/closure-feed', 'realm/closure-rankings'] as const) {
    const started = performance.now();
    const evidence = createClosureCreditEvidence(row, 'regression', import.meta.path);
    const sessions = await evidence.phase('persona-preparation', () => personaSessions('public'));
    try {
      await evidence.phase('path', async () => {
        evidence.observe(sessions);
        expect(sessions.realm).not.toBe(previousRealm);
        expect(sessions.owner.actingSubject).not.toBe(previousAuthor);
        previousRealm = sessions.realm;
        previousAuthor = sessions.owner.actingSubject;
        const originals: ClosureOriginal[] = [];
        // Both outcome files consume this actual setup; each path has its own Realm and author.
        await evidence.phase('original-publication', () => publishClosureOriginals(sessions, originals,
          `Closuregarden${randomUUID().replaceAll('-', '')}`));
        expect(originals).toHaveLength(3);
        await evidence.phase('public-credit', async () => {
          for (const original of originals) {
            const root = `/v1/works/${original.work.slice(-36)}`;
            const supplied = evidence.requests.find(request => request.method === 'GET'
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
            const inventory = await credits.json() as { items: Credit[]; nextCursor: string | null };
            expect(inventory.items).toEqual(initial.items);
            expect(inventory.nextCursor).toBeNull();
            expect(evidence.requests.filter(request => request.method === 'POST'
              && request.path === `${root}/agent-credits`)).toHaveLength(0);
          }
        });
      });
    } finally {
      try {
        evidence.record({ kind: 'path-timing', preparationSeconds: sessions.elapsedSeconds,
          pathSeconds: (performance.now() - started) / 1000 - sessions.elapsedSeconds });
      } finally {
        await sessions.close();
      }
    }
  }
}, 360_000);
