import { afterEach, expect, test } from 'bun:test';
import type { AnswerPersona, AnswerRecord, AnswerSample } from '../../../../scripts/api/answer-record.ts';
import games from '../../../../tests/qa/fixtures/outcomes/games/catalogue-browse-and-search-in-its-zone.json';
import { mainApiWithToken } from '../api/main.ts';
import { readZoneBrowse } from '../realm/read.ts';
import type { ZoneBrowseQuery } from '../realm/types.ts';
import { recordedFetch } from '../stories/recorded-fetch.ts';

const record = games as AnswerRecord;
const personas: AnswerPersona[] = ['visitor', 'stranger', 'member', 'owner', 'moderator', 'operator'];
const disposals: (() => void)[] = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); });

/** Reader coverage of the original API requests; these are not route-reachable story states. */
function requestOf(sample: AnswerSample): { realm: string; query: ZoneBrowseQuery } {
  const url = new URL(sample.path, 'https://recorded.invalid');
  const params = url.searchParams;
  const sort = params.get('sort');
  if (sort !== null && sort !== 'newest' && sort !== 'updated' && sort !== 'relevance') {
    throw new Error(`Unexpected recorded Games sort: ${sort}`);
  }
  const realm = url.pathname.split('/')[3];
  if (!realm) throw new Error('Recorded Games request has no Realm');
  return { realm, query: {
    ...(sort ? { sort } : {}),
    ...(params.has('limit') ? { limit: Number(params.get('limit')) } : {}),
    ...(params.has('q') ? { q: params.get('q')! } : {}),
    ...(params.has('cursor') ? { cursor: params.get('cursor')! } : {}),
    ...(params.has('actingSubject') ? { actingSubject: params.get('actingSubject')! } : {}),
    type: params.getAll('type'),
  } };
}

for (const persona of personas) {
  test(`${persona}: the production reader consumes unchanged Games browse, search, sort, empty and continuation answers`, async () => {
    const before = JSON.stringify(record.personas[persona]);
    const samples = record.personas[persona].filter(sample =>
      sample.operationId === 'getV1RealmsByRealmModulesBrowse' && sample.status === 200);
    expect(samples.length).toBeGreaterThan(10);
    for (const sample of samples) {
      const replay = recordedFetch(record, persona, [{ label: sample.label, state: 'populated' }]);
      disposals.push(replay.dispose);
      const main = mainApiWithToken(undefined, { fetcher: replay.fetcher });
      const { realm, query } = requestOf(sample);
      // Equality includes titles and language, Work/revision identity, native credits,
      // source position, exact/lower-bound counts and the complete opaque cursor.
      expect(await readZoneBrowse(realm, 'en', query, main)).toEqual({ ok: true, data: sample.answer });
    }
    expect(JSON.stringify(record.personas[persona])).toBe(before);
  });

  test(`${persona}: the recorded unsupported-query refusal remains a failed read`, async () => {
    const sample = record.personas[persona].find(item => item.label === 'unsupported-query-shape');
    if (!sample) throw new Error(`Missing Games refusal for ${persona}`);
    expect(sample.status).toBe(400);
    expect(sample.answer).toMatchObject({ title: 'Relevance needs text', code: 'unsupported_query_shape' });
    const replay = recordedFetch(record, persona, [{ label: sample.label, state: 'error' }]);
    disposals.push(replay.dispose);
    const { realm, query } = requestOf(sample);
    const page = await readZoneBrowse(realm, 'en', query, mainApiWithToken(undefined, { fetcher: replay.fetcher }));
    expect(page).toMatchObject({ ok: false, failure: 'invalid' });
  });
}

test('the production reader waits while a recorded Games browse request is held unanswered', async () => {
  const sample = record.personas.visitor.find(item => item.label === 'populated');
  if (!sample) throw new Error('Missing visitor Games browse');
  const replay = recordedFetch(record, 'visitor', [{ label: sample.label, state: 'loading' }]);
  disposals.push(replay.dispose);
  let requested = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = true;
    return replay.fetcher(input, init);
  }) as typeof fetch;
  const { realm, query } = requestOf(sample);
  let settled = false;
  const page = readZoneBrowse(realm, 'en', query, mainApiWithToken(undefined, { fetcher }))
    .finally(() => { settled = true; });
  await Bun.sleep(10);
  expect(requested).toBe(true);
  expect(settled).toBe(false);
  replay.dispose();
  await page;
});
