import { expect, test } from 'bun:test';
import { profileSteps } from './profiles.ts';
import type { SeedApi } from './api.ts';

test('G-543/G-508: profile credits use the authorized writer while preserving each credited participant', async () => {
  const writes: Array<{ body: Record<string, unknown>; token: string }> = [];
  const authorized: string[] = [];
  const api = {
    get: async (path: string, token: string) => {
      expect(token).toBe('authorized-operator');
      expect(path).toContain('?actingSubject=operator-agent');
      return path.includes('/agent-credits?') ? { items: [] } : { revision: 'current-head' };
    },
    post: async (_path: string, body: Record<string, unknown>, token: string) => { writes.push({ body, token }); },
  } as unknown as SeedApi;
  const owner = { id: 'mei', token: 'ordinary-owner', actingSubject: 'mei-agent' };
  const profiles = profileSteps(api, owner, [owner], new Map([['northstar', 'northstar-agent']]),
    new Map([['serial', 'serial-work'], ['pride', 'pride-work']]), async work => {
      authorized.push(work);
      return { id: 'operator', token: 'authorized-operator', actingSubject: 'operator-agent' };
    });
  expect(await profiles.credits()).toBe(2);
  expect(authorized).toEqual(['serial-work', 'pride-work']);
  expect(writes.map(item => item.token)).toEqual(['authorized-operator', 'authorized-operator']);
  expect(writes.map(item => item.body)).toEqual([
    expect.objectContaining({ agent: 'mei-agent', role: 'author', actingSubject: 'operator-agent', expectedWorkHead: 'current-head' }),
    expect.objectContaining({ agent: 'northstar-agent', role: 'editor', actingSubject: 'operator-agent', expectedWorkHead: 'current-head' }),
  ]);
});

test('G-543/G-508: failed editor authorization performs no credit write', async () => {
  let writes = 0;
  const api = { getPublic: async () => ({ items: [] }), post: async () => { writes++; } } as unknown as SeedApi;
  const owner = { id: 'mei', token: 'ordinary-owner', actingSubject: 'mei-agent' };
  const profiles = profileSteps(api, owner, [owner], new Map(), new Map([['serial', 'serial-work']]),
    async () => { throw new Error('editor mandate unavailable'); });
  await expect(profiles.credits()).rejects.toThrow('editor mandate unavailable');
  expect(writes).toBe(0);
});

test('G-543/G-508: authorized reads preserve an existing credit on a Work that is not public yet', async () => {
  const owner = { id: 'mei', token: 'ordinary-owner', actingSubject: 'mei-agent' };
  let authorized = false;
  const api = {
    get: async (path: string, token: string) => {
      expect(authorized).toBe(true);
      expect(token).toBe('authorized-operator');
      expect(path).toContain('?actingSubject=operator-agent');
      return { items: [{ agent: 'mei-agent', role: 'author' }] };
    },
    getPublic: async () => { throw new Error('Work is not public'); },
    post: async () => { throw new Error('Existing credit must not be replaced'); },
  } as unknown as SeedApi;
  const profiles = profileSteps(api, owner, [owner], new Map(), new Map([['serial', 'private-work']]), async () => {
    authorized = true;
    return { id: 'operator', token: 'authorized-operator', actingSubject: 'operator-agent' };
  });
  expect(await profiles.credits()).toBe(1);
});
