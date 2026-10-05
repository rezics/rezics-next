import { expect, test } from 'bun:test';
import { demoSessions } from './library-people.ts';
import { seedLibrary } from './library-step.ts';
import type { SeedState, Session } from './state.ts';

const session = (id: string): Session => ({ id, accountId: id, cookie: '', token: `token-${id}`, issuedAt: 0,
  actingSubject: `https://rezics.com/id/00000000-0000-4000-a000-${id.length.toString().padStart(12, '0')}` });

test('only the plan\'s people get a shelf; helper accounts that later steps sign in do not', async () => {
  const posts: { path: string; body: { name: string }; key: string }[] = [];
  const state = { sessions: [session('mei'), session('scoped-rater-1'), session('wei'), session('scoped-rater-50')],
    api: { post: async (path: string, body: { name: string }, _token: string, key: string) => { posts.push({ path, body, key }); return {}; } },
    optional: async <T>(_label: string, operation: () => Promise<T>) => operation() } as unknown as SeedState;
  await seedLibrary(state);
  expect(posts.map(post => post.body.name)).toEqual(['林梅 · Reading shelf', '周伟 · Reading shelf']);
  expect(posts.map(post => post.key)).toEqual(['dev-seed:v1:collection:mei', 'dev-seed:v1:collection:wei']);
  expect(demoSessions(state.sessions).map(item => item.id)).toEqual(['mei', 'wei']);
});
