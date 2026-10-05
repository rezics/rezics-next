import { expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { seedScopedSubjects } from './scoped-subjects-step.ts';
import type { ScopedSubjectManifest, ScopedSubjectPort } from './scoped-subjects.ts';
import { refreshSeedTokens, type SeedState, type Session } from './state.ts';

const native = (suffix: string) => `https://rezics.com/id/00000000-0000-4000-a000-${suffix.padStart(12, '0')}`;
const session = (id: string): Session => ({ id, accountId: id, cookie: '', token: `token-${id}`,
  issuedAt: Date.now(), actingSubject: native(id) });
const manifest = { subjects: { misaka: native('misaka') },
  projections: { 'misaka-railgun': native('projection') } } as unknown as ScopedSubjectManifest;
const index = '.temp/seed/scoped-subjects.json';

test('ranking accounts stay off the plan\'s people and still make fifty distinct raters', async () => {
  const signIns: { email: string; password: string; name: string }[] = [];
  const agents: { token: string; key: string; displayName: string }[] = [];
  const mei = session('mei');
  mei.cookie = 'mei-cookie';
  mei.token = 'stale-mei';
  mei.issuedAt = Date.now() - 121_000;
  const wei = session('wei');
  const people = [mei, wei];
  let seenOwnerToken = '';
  const state = { sessions: people,
    operatorInput: { accessDatabaseUrl: 'postgres://seed@127.0.0.1:1/none' },
    api: {
      token: async (cookie: string) => `renewed-${cookie}`,
      signInOrUp: async (user: { email: string; password: string; name: string }) => {
        signIns.push(user);
        return { cookie: `cookie-${user.email}`, id: `account-${user.email}` };
      },
      post: async (path: string, body: { displayName: string }, token: string, key: string) => {
        expect(path).toBe('/v1/agents');
        agents.push({ token, key, displayName: body.displayName });
        return { agent: native(key) };
      },
      get: async (_path: string, token: string) => token,
    } } as unknown as SeedState;
  try {
    await seedScopedSubjects(state, async (port: ScopedSubjectPort) => {
      seenOwnerToken = await port.api.get('/owner');
      expect(port.raters).toHaveLength(50);
      expect(new Set(port.raters.map(rater => rater.actor)).size).toBe(50);
      expect(port.raters.slice(0, 2).map(rater => rater.actor)).toEqual([mei.actingSubject, wei.actingSubject]);
      expect(port.raters.slice(2).map(rater => rater.actor)).toEqual(agents.map(agent => native(agent.key)));
      return manifest;
    });
    expect(state.sessions).toBe(people);
    expect(state.sessions.map(item => item.id)).toEqual(['mei', 'wei']);
    expect(mei.token).toBe('renewed-mei-cookie');
    expect(seenOwnerToken).toBe('renewed-mei-cookie');
    expect(signIns).toHaveLength(48);
    expect(signIns[0]).toEqual({ email: 'scoped-rater-3@demo.rezics.local', password: 'Rezics-demo-scoped-2026!',
      name: 'Map reader 3' });
    expect(signIns.at(-1)).toEqual({ email: 'scoped-rater-50@demo.rezics.local', password: 'Rezics-demo-scoped-2026!',
      name: 'Map reader 50' });
    expect(agents.map(agent => agent.key)).toEqual(Array.from({ length: 48 }, (_, index) => `demo-scoped:agent:${index + 2}`));
    expect(agents[0]).toMatchObject({ token: 'renewed-cookie-scoped-rater-3@demo.rezics.local', displayName: 'Map reader 3' });
  } finally { await rm(index, { force: true }); }
});

test('a plan that already has fifty people signs in no ranking account', async () => {
  const people = Array.from({ length: 51 }, (_, index) => session(`person-${index}`));
  const ids = people.map(item => item.id);
  let signIns = 0;
  const state = { sessions: people,
    operatorInput: { accessDatabaseUrl: 'postgres://seed@127.0.0.1:1/none' },
    api: { signInOrUp: async () => { signIns++; return { cookie: '', id: '' }; },
      token: async () => '', post: async () => ({ agent: '' }) } } as unknown as SeedState;
  try {
    await seedScopedSubjects(state, async (port: ScopedSubjectPort) => {
      expect(port.raters.map(rater => rater.actor)).toEqual(people.slice(0, 50).map(item => item.actingSubject));
      return manifest;
    });
    expect(signIns).toBe(0);
    expect(state.sessions.map(item => item.id)).toEqual(ids);
  } finally { await rm(index, { force: true }); }
});

test('a ranking rater renews with the plan while staying off its people list', async () => {
  const calls: string[] = [];
  const person = session('mei');
  const rater = session('scoped-rater-14');
  rater.cookie = 'rater-cookie';
  rater.token = 'stale-rater';
  rater.issuedAt = Date.now() - 121_000;
  const state = { sessions: [person], operatorSession: null,
    api: { token: async (cookie: string) => { calls.push(cookie); return `renewed-${cookie}`; } } } as unknown as SeedState;
  await refreshSeedTokens(state, [rater]);
  expect(calls).toEqual(['rater-cookie']);
  expect(state.sessions.map(item => item.id)).toEqual(['mei']);
  expect(person.token).toBe('token-mei');
  expect(rater.token).toBe('renewed-rater-cookie');
});
