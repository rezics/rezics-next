import { expect, test } from 'bun:test';
import { readAdmittedDiscoveryPage } from '../../src/search/default-discovery.ts';
import { admitDiscoveryPage } from '../../src/search/discovery-http.ts';
import type { DiscoveryPage } from '../../src/search/discovery.ts';
import { routeOf } from '../../src/route/route.ts';

const id = '018f0000-0000-7000-8000-00a000000001';
const route = routeOf(id)!;
function page(empty: boolean, reason?: 'identity' | 'response_limit'): DiscoveryPage {
  const value = {
    hits: empty
      ? []
      : [
          {
            key: { owner: 'semantic', kind: 'schema:Person', route, id },
            summary: {
              kind: 'subject',
              value: {
                id,
                type: 'schema:Person',
                types: ['schema:Person'],
                label: null,
                creativeWork: false,
                cover: null,
              },
            },
          },
        ],
    kinds: { values: [], next: null },
    next: empty ? null : 'retained-cursor',
    as_of: '2026-11-01T00:00:00Z',
    viewerFacts: reason
      ? { state: 'unavailable', reason, retryable: reason !== 'response_limit' }
      : {
          state: 'current',
          question: null,
          rows: empty
            ? []
            : [
                {
                  rowKey: JSON.stringify(['semantic', 'schema:Person', route, id]),
                  subjectId: id,
                  entry: { state: 'absent' },
                  vote: { state: 'unavailable', reason: 'question' },
                },
              ],
        },
  };
  admitDiscoveryPage(value);
  return value;
}
function reader(value: DiscoveryPage, events: string[], failure?: 'search' | 'finish') {
  return {
    async search() {
      events.push('read');
      if (failure === 'search') throw new Error('search refused');
      return value;
    },
    async finish() {
      events.push('finish');
      if (failure === 'finish') throw new Error('finish refused');
    },
    async close() {
      events.push('close');
    },
  };
}

test.each([
  [false, undefined],
  [true, undefined],
  [false, 'identity'],
  [true, 'response_limit'],
] as const)('late viewer authority change discards the whole page (empty=%s, producer=%s)', async (empty, reason) => {
  const events: string[] = [];
  const started = Promise.withResolvers<void>(),
    current = Promise.withResolvers<boolean>();
  const result = readAdmittedDiscoveryPage(reader(page(empty, reason), events), async (value) => {
    events.push('assemble');
    started.resolve();
    return { page: value, viewerCurrent: await current.promise };
  });
  await started.promise;
  expect(events).toEqual(['read', 'assemble']);
  current.resolve(false);
  await expect(result).rejects.toMatchObject({ code: 'search_restart_required' });
  expect(events).toEqual(['read', 'assemble', 'close']);
});

test.each([
  [false, undefined],
  [true, undefined],
  [false, 'identity'],
  [true, 'response_limit'],
] as const)('current page retains producer outcome (empty=%s, producer=%s)', async (empty, reason) => {
  const events: string[] = [],
    value = page(empty, reason);
  const result = await readAdmittedDiscoveryPage(reader(value, events), async (page) => ({
    page,
    viewerCurrent: true,
  }));
  expect(result).toBe(value);
  expect(events).toEqual(['read', 'finish', 'close']);
  expect(result.next).toBe(empty ? null : 'retained-cursor');
});

test.each(['search', 'assembly', 'finish'] as const)(
  'a %s refusal closes the retained read without publishing',
  async (failure) => {
    const events: string[] = [];
    const read = reader(page(true), events, failure === 'assembly' ? undefined : failure);
    const result = readAdmittedDiscoveryPage(read, async (page) => {
      if (failure === 'assembly') throw new Error('assembly refused');
      return { page, viewerCurrent: true };
    });
    await expect(result).rejects.toThrow(`${failure} refused`);
    expect(events).toEqual(failure === 'finish' ? ['read', 'finish', 'close'] : ['read', 'close']);
  },
);
