import { expect, test } from 'bun:test';
import { SeedApiError } from './api.ts';
import { seedContributions } from './contributions-step.ts';
import type { DemoWork } from './plan.ts';
import type { SeedState, Session, WorkReceipt } from './state.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const session = (id: string, suffix: string): Session => ({ id, accountId: id, cookie: '', token: `token-${id}`, issuedAt: 0,
  actingSubject: native(suffix) });
const receipt = (suffix: string, replayed = true): WorkReceipt => ({ work: native(suffix), mainVersion: native(`${suffix}v`),
  workRevision: native(`${suffix}r`), mainRevision: native(`${suffix}m`), replayed });
const plan: DemoWork[] = [{ id: 'camp-lanterns', title: 'Camp Lanterns', type: 'mod', language: 'en', author: 'sophie',
  excerpt: 'Hang warm lanterns around a campsite.' }];
const conflict = new SeedApiError('Main /v1/contributions', 409, '{"code":"idempotency_conflict"}');

function fixture(heldBy: string) {
  const posts: { path: string; token: string; key: string; work?: unknown }[] = [];
  const created = new Map([['camp-lanterns', receipt('b')]]);
  const state = { sessions: [session('mei', '1'), session('daniel', '2'), session('an', '3'), session('sophie', '4')],
    penAgents: new Map(), created, publicForRealm: new Map(), publishedCount: 0, selectedCount: 0, commentCount: 0, replyCount: 0,
    optional: async <T>(_label: string, operation: () => Promise<T>) => { try { return await operation(); } catch { return null; } },
    api: { post: async (path: string, body: { work?: string }, token: string, key: string) => {
      posts.push({ path, token, key, work: body.work });
      if (path === '/v1/works') return receipt('a');
      if (path === '/v1/contributions') {
        if (body.work !== heldBy) throw conflict;
        return { contribution: native('c'), draftRevision: native('d'), replayed: true };
      }
      if (path === '/v1/contribution-publications') return { publicationDecision: native('e'), replayed: true };
      if (path === '/v1/member-reply-drafts') return { revisionId: native('f') };
      return { replayed: true };
    } } } as unknown as SeedState;
  return { state, posts, created };
}

test('a Contribution whose key an earlier Work holds moves to that Work, replayed under its author\'s own keys', async () => {
  const { state, posts, created } = fixture(native('a'));
  await seedContributions(state, plan);
  const attempts = posts.filter(post => post.path === '/v1/contributions');
  expect(attempts.map(post => post.work)).toEqual([native('b'), native('a')]);
  expect(attempts.every(post => post.key === 'dev-seed:v1:contribution:camp-lanterns' && post.token === 'token-sophie')).toBe(true);
  // The creation key replays with the author's token, never the administrator's.
  expect(posts.find(post => post.path === '/v1/works')).toMatchObject({ token: 'token-sophie', key: 'dev-seed:v1:work:camp-lanterns' });
  expect(created.get('camp-lanterns')?.work).toBe(native('a'));
  expect(state.publishedCount).toBe(1);
});

test('a Work that holds its Contribution key looks for no other Work', async () => {
  const { state, posts, created } = fixture(native('b'));
  await seedContributions(state, plan);
  expect(posts.some(post => post.path === '/v1/works')).toBe(false);
  expect(created.get('camp-lanterns')?.work).toBe(native('b'));
});

test('a conflict no earlier Work explains stays a finding, and nothing else is written for it', async () => {
  const { state, posts } = fixture(native('z'));
  await seedContributions(state, plan);
  expect(posts.map(post => post.path)).toEqual(['/v1/contributions', '/v1/works', '/v1/contributions']);
  expect(state.publishedCount).toBe(0);
});
