import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { BrowseReadError, discoveryApi } from '../discover/api.ts';

const target = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
test('a rating-population refusal keeps its entire HTTP problem through the discovery adapter', async () => {
  const problem = { type: 'problem', status: 503, code: 'population_read_unavailable', title: 'Read unavailable',
    recovery: { position: 'exact-position', retryAfter: 2 } };
  const main = browserMainApi('https://recorded.invalid', { anonymous: true,
    fetcher: Object.assign(async () => Response.json(problem, { status: 503 }), { preconnect: fetch.preconnect }) });
  try {
    await discoveryApi(main, 'en').populations(target);
    throw new Error('Refusal did not throw');
  } catch (error) {
    expect(error).toBeInstanceOf(BrowseReadError);
    if (!(error instanceof BrowseReadError)) throw error;
    expect(error.status).toBe(503);
    expect(error.problem).toEqual(problem);
  }
});

test('retaining a problem does not remove the population continuation consistency check', async () => {
  const main = browserMainApi('https://recorded.invalid', { anonymous: true, fetcher: Object.assign(async () => Response.json({
    profile: 'rating-populations-v1', target, items: [], complete: false, nextCursor: null,
    count: { value: 0, kind: 'exact' },
  }), { preconnect: fetch.preconnect }) });
  await expect(discoveryApi(main, 'en').populations(target)).rejects.toBeInstanceOf(BrowseReadError);
});
