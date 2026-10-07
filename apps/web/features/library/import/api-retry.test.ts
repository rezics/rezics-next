import { describe, expect, test } from 'bun:test';
import { type MainClient } from '../../discover/types.ts';
import { ImportError, mainImportApi } from '../import-api.ts';

interface Reply {
  status: number;
  data: unknown;
  error?: { value: { code: string } };
  response?: Response;
}

function client(replies: Reply[]) {
  const sent: Array<{ body: unknown; headers: { 'idempotency-key': string } }> = [];
  const waits: number[] = [];
  const post = async (body: unknown, { headers }: { headers: { 'idempotency-key': string } }) => {
    sent.push({ body, headers });
    const reply = replies[sent.length - 1];
    if (!reply) throw new Error('Unexpected extra import request');
    return reply;
  };
  const imports = Object.assign(() => ({ rows: () => ({ adoptions: { post } }) }), { post });
  const main = { v1: { me: { 'library-imports': imports } } } as unknown as MainClient;
  return { api: mainImportApi('reader', () => main, async milliseconds => { waits.push(milliseconds); }), sent, waits };
}

const admission = (retryAfter?: string): Reply => ({ status: 429, data: null,
  response: new Response(null, { status: 429, headers: retryAfter ? { 'retry-after': retryAfter } : {} }) });
const pending = (): Reply => ({ status: 202, data: { pending: true } });
const unavailable: Reply = { status: 503, data: null, error: { value: { code: 'source_unavailable' } } };

describe('library import admission and adoption polling', () => {
  test('more than eight admission refusals keep the same command until it succeeds', async () => {
    const inspection = { headers: ['Title'], distinctValues: { Title: ['A book'] } };
    const { api, sent, waits } = client([...Array.from({ length: 10 }, () => admission('2')),
      { status: 200, data: inspection }]);
    expect(await api.inspect('Title\nA book')).toEqual(inspection);
    expect(sent).toHaveLength(11);
    expect(new Set(sent.map(request => request.headers['idempotency-key'])).size).toBe(1);
    expect(sent.every(request => JSON.stringify(request.body) === JSON.stringify(sent[0]!.body))).toBe(true);
    expect(waits).toEqual(Array<number>(10).fill(2000));
  });

  test('more than eight accepted adoptions keep the same intent until the Work arrives', async () => {
    const { api, sent, waits } = client([...Array.from({ length: 10 }, pending),
      { status: 200, data: { work: 'book' } }]);
    expect(await api.adopt('import', 1, 'OL1W', 'en')).toBe('book');
    expect(sent).toHaveLength(11);
    expect(sent.every(request => request.headers['idempotency-key'] === 'library-import:adopt:import:1:OL1W')).toBe(true);
    expect(sent.every(request => JSON.stringify(request.body)
      === JSON.stringify({ actingSubject: 'reader', workId: 'OL1W', titleLanguage: 'en' }))).toBe(true);
    expect(waits).toEqual(Array<number>(10).fill(1000));
  });

  test('adoption respects Retry-After for both admission and accepted work', async () => {
    const { api, waits } = client([admission('0'), { ...pending(),
      response: new Response(null, { status: 202, headers: { 'retry-after': '3' } }) },
    admission('Thu, 01 Jan 1970 00:00:00 GMT'), { status: 200, data: { work: 'book' } }]);
    expect(await api.adopt('import', 1, 'OL1W', 'en')).toBe('book');
    expect(waits).toEqual([0, 3000, 0]);
  });

  test('a daily adoption budget is terminal even after accepted work', async () => {
    const { api, sent, waits } = client([pending(), { status: 429, data: null,
      error: { value: { code: 'reader_import_adoption_budget' } } }]);
    await expect(api.adopt('import', 1, 'OL1W', 'en')).rejects.toEqual(new ImportError('budget'));
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  test('a real unavailable refusal stops admission polling', async () => {
    const { api, sent, waits } = client([admission(), unavailable]);
    await expect(api.inspect('Title')).rejects.toEqual(new ImportError('unavailable'));
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  test('a real unavailable refusal stops accepted adoption polling', async () => {
    const { api, sent, waits } = client([pending(), unavailable]);
    await expect(api.adopt('import', 1, 'OL1W', 'en')).rejects.toEqual(new ImportError('unavailable'));
    expect(sent).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  test('a completed adoption without a Work is invalid, rather than synthetic unavailable', async () => {
    const { api, sent, waits } = client([{ status: 200, data: {} }]);
    await expect(api.adopt('import', 1, 'OL1W', 'en')).rejects.toEqual(new ImportError('invalid'));
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test('an accepted command without data is invalid, rather than synthetic unavailable', async () => {
    const { api } = client([{ status: 200, data: null }]);
    await expect(api.inspect('Title')).rejects.toEqual(new ImportError('invalid'));
  });
});
