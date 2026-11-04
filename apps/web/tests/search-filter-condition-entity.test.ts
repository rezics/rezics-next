import { afterEach, expect, test } from 'bun:test';
import {
  appendConditionEntity,
  conditionEntityFilter,
  conditionEntityRequestIdentity,
  ConditionEntityLookupError,
  resolveConditionEntityLabels,
  searchConditionEntities,
  type ConditionEntityContext,
} from '../src/search/condition-entity';
import { suggestionResponse, type SuggestionResult } from '../src/search/suggestions';

const first = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const second = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
const target = 'ex:Work';
const scope = { kind: 'realm' as const, id: '0192f3a0-6c1e-7b2a-9d4e-000000000010' };
const context: ConditionEntityContext = { locale: 'ja', reader: 'reader-a', release: 'release-a', resourceScope: scope, available: true };
const page: SuggestionResult = {
  as_of: '2026-11-04T00:00:00.000Z',
  types: { [target]: { ja: '作品', 'zh-Hant': '作品' } },
  subjects: [
    { id: first, type: target, labels: { en: 'Same', ja: '同名', 'zh-Hant': '同名' }, summary: null },
    { id: second, type: target, labels: { en: 'Same', ja: '同名', 'zh-Hant': '同名' }, summary: null },
  ],
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('native candidates retain localized labels and distinct identities; only selected IDs enter the filter', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://rezics.test');
    calls.push({ url, init });
    return Response.json(page);
  }) as typeof fetch;
  const signal = new AbortController().signal;

  const candidates = await searchConditionEntities('同', [target], context, signal);
  expect(candidates.map(({ id }) => id)).toEqual([first, second]);
  expect(candidates.map(({ title }) => title[0])).toEqual(['同', '同']);
  expect(candidates[0]!.title).toContain(first);
  expect(candidates[1]!.title).toContain(second);
  expect(candidates[0]!.typeLabel).toBe('作品');
  expect(calls[0]!.url.searchParams.get('filter')).toBe(
    conditionEntityFilter([target], scope),
  );
  expect(calls[0]!.url.searchParams.get('release')).toBe('release-a');
  expect(calls[0]!.init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', signal });
  expect(appendConditionEntity([''], first)).toEqual([first]);
  expect(appendConditionEntity(['typed text'], first)).toEqual([first]);
  expect(() => appendConditionEntity([''], '同名')).toThrow(ConditionEntityLookupError);
  let refusedReads = 0;
  globalThis.fetch = (async () => {
    refusedReads++;
    return Response.json(page);
  }) as typeof fetch;
  await expect(
    searchConditionEntities('同', [target], { ...context, available: false }, signal),
  ).rejects.toThrow(ConditionEntityLookupError);
  expect(refusedReads).toBe(0);
});

test('reopening resolves exact native IDs, keeps withheld operands, and never substitutes a matching name', async () => {
  const calls: URL[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'https://rezics.test');
    calls.push(url);
    const id = url.searchParams.get('id')!;
    return Response.json(
      id === first
        ? { state: 'ready', id, labels: { ja: '同名', 'zh-Hant': '同名' }, type: target, typeLabels: { ja: '作品' } }
        : { state: 'withheld', id },
    );
  }) as typeof fetch;
  const resolved = await resolveConditionEntityLabels([first, second], [target], context, new AbortController().signal);

  expect(calls.map((url) => url.searchParams.get('id')).sort()).toEqual([first, second]);
  expect(calls.every((url) => !url.searchParams.has('q'))).toBe(true);
  expect(resolved).toEqual({ labels: { [first]: { label: '同名', type: '作品' } }, withheld: [second] });
  expect(conditionEntityRequestIdentity('statement-1', 'ex:related', [target], context)).not.toBe(
    conditionEntityRequestIdentity('statement-1', 'ex:related', [target], { ...context, reader: 'reader-b' }),
  );

  const request = new Request(
    `https://rezics.test/api/search/suggestions?id=${first}&locale=ja&release=release-a&filter=${encodeURIComponent(conditionEntityFilter([target], scope))}`,
  );
  let routedId = '';
  const response = await suggestionResponse(
    request,
    {},
    async () => page,
    async (id) => {
      routedId = id;
      return { state: 'withheld', id };
    },
  );
  expect(routedId).toBe(first);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ state: 'withheld', id: first });
});

test('a retired label read cannot publish after its signal is aborted and operand reads stop at the grammar limit', async () => {
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = (() =>
    new Promise<Response>((resolve) => {
      finish = resolve;
    })) as typeof fetch;
  const controller = new AbortController();
  const pending = resolveConditionEntityLabels([first], [target], context, controller.signal);
  controller.abort();
  finish?.(Response.json({ state: 'ready', id: first, labels: { ja: 'Retired label' }, type: target, typeLabels: {} }));
  await expect(pending).rejects.toThrow();

  let reads = 0;
  globalThis.fetch = (async (input) => {
    reads++;
    const id = new URL(input instanceof Request ? input.url : String(input), 'https://rezics.test').searchParams.get('id')!;
    return Response.json({ state: 'withheld', id });
  }) as typeof fetch;
  const many = Array.from({ length: 80 }, (_, index) => `0192f3a0-6c1e-7b2a-9d4e-${String(index + 20).padStart(12, '0')}`);
  const result = await resolveConditionEntityLabels(many, [target], context, new AbortController().signal);
  expect(reads).toBe(64);
  expect(result.withheld).toHaveLength(64);
});
