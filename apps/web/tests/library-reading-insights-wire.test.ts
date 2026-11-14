import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { insightsSearch, insightsDiaryHref } from '../src/library/reading-insights/address';
import { receiveInsights, readInsights } from '../src/library/reading-insights/native';
import { readingInsightsExample } from '../src/library/reading-insights/story-values';

// The real generated client serializes the only native request; no substitute client route is used.
test('one admitted overview request preserves all five panel values and exact diary operands', async () => {
  const base = readingInsightsExample(1);
  const value = {
    ...base,
    panels: {
      ...base.panels,
      allTime:
        base.panels.allTime.status === 'received'
          ? {
              status: 'received' as const,
              value: {
                ...base.panels.allTime.value,
                completedOccurrences: '9007199254740993',
                distinctCompletedSubjects: '9007199254740990',
              },
            }
          : base.panels.allTime,
    },
  };
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(value, { headers: { 'cache-control': 'private, no-store' } });
    }) as typeof fetch,
  });
  const read = await readInsights(client, 'Bearer owner-credential', 1);
  expect(read).toEqual({ kind: 'ready', value });
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('GET');
  expect(new URL(request.url).pathname).toBe('/v1/libraryReadingInsights');
  expect(new URL(request.url).search).toBe('?year=1');
  expect(request.headers.get('authorization')).toBe('Bearer owner-credential');
  expect(request.cache).toBe('no-store');
  expect(insightsDiaryHref(value.actions.diary, 'ja')).toBe('/ja/library/history?year=1');
  expect(insightsDiaryHref(value.actions.months[11]!, 'en')).toBe('/en/library/history?year=1&month=12');
  expect(insightsDiaryHref(value.actions.unallocatedMonth, 'zh-Hant')).toBe(
    '/zh-Hant/library/history?year=1&month=unallocated',
  );
});

test('independent failure, historical unknown, exact decimal and available zero survive receiving', () => {
  const base = readingInsightsExample();
  const value = {
    ...base,
    panels: { ...base.panels, allTime: { status: 'failed' as const, reason: 'overloaded' as const } },
  };
  expect(receiveInsights(value, 2026)).toEqual({ kind: 'ready', value });
  const zero = readingInsightsExample(9999, true);
  expect(receiveInsights(zero, 9999)).toEqual({ kind: 'ready', value: zero });
});

test('malformed HTTP responses cannot become zero or a different year or month destination', () => {
  const fixture = readingInsightsExample();
  expect(receiveInsights(fixture, 2025)).toEqual({ kind: 'unavailable' });
  const wrongAction = {
    ...fixture,
    actions: {
      ...fixture.actions,
      months: fixture.actions.months.map((action, index) =>
        index === 0 ? { ...action, query: { ...action.query, year: 2025 } } : action,
      ),
    },
  };
  const duplicateMonth = {
    ...fixture,
    actions: {
      ...fixture.actions,
      months: fixture.actions.months.map((action, index) => (index === 0 ? fixture.actions.months[1]! : action)),
    },
  };
  const wrongPanel = {
    ...fixture,
    panels: {
      ...fixture.panels,
      profiles:
        fixture.panels.profiles.status === 'received'
          ? { status: 'received', value: { ...fixture.panels.profiles.value, year: 2025 } }
          : fixture.panels.profiles,
    },
  };
  const wrongCount = {
    ...fixture,
    panels: {
      ...fixture.panels,
      allTime:
        fixture.panels.allTime.status === 'received'
          ? { status: 'received', value: { ...fixture.panels.allTime.value, completedOccurrences: 0 } }
          : fixture.panels.allTime,
    },
  };
  for (const invalid of [null, {}, wrongAction, duplicateMonth, wrongPanel, wrongCount])
    expect(receiveInsights(invalid, 2026)).toEqual({ kind: 'unavailable' });
});

test('URL years retain the complete native Gregorian range and refuse invalid explicit years', () => {
  expect(insightsSearch({})).toEqual({});
  for (const year of [1, 9999, '0001', '9999']) expect(insightsSearch({ year }).year).toBe(Number(year));
  for (const year of [0, 10000, -1, 1.5, '', '2e3', ['2026', '2027'], null])
    expect(insightsSearch({ year })).toEqual({ year: 'invalid' });
});

test('native authority failures are not converted to healthy empty panels', async () => {
  for (const [status, kind] of [
    [401, 'retired'],
    [403, 'denied'],
    [503, 'unavailable'],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: (async () => Response.json({ code: 'dependency_unavailable' }, { status })) as typeof fetch,
    });
    expect(await readInsights(client, 'Bearer owner-credential', 2026)).toEqual({ kind });
  }
});
