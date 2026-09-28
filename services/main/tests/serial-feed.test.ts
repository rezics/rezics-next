import { expect, test } from 'bun:test';
import { feedSources } from '../src/modules/feed/source.ts';
import type { WorkReadSession } from '../src/modules/work/read-session.ts';

const id = (tail: string) => `https://rezics.com/id/00000000-0000-4000-8000-${tail}`;

test('G-327 feed imports use the source binding, independent of author-credit presence', async () => {
  const work = id('000000000001'), actor = id('000000000002'), event = id('000000000003');
  const rows = [{ id: { value: event }, sequence: { value: '9' }, kind: { value: 'work' },
    target: { value: work }, work: { value: work }, actor: { value: actor } }];
  const session = (bound: boolean) => ({ query: async () => rows, deps: { sourceAdoptions: {
    boundWorks: async () => bound ? new Set([work]) : new Set<string>(),
  } } }) as unknown as WorkReadSession;
  expect((await feedSources(session(false), { ids: [event] }))[0]?.kind).toBe('work');
  expect((await feedSources(session(true), { ids: [event] }))[0]?.kind).toBe('added');
});
