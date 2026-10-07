import { describe, expect, test } from 'bun:test';
import { type MainClient } from '../../discover/types.ts';
import { IMPORT_REQUEST_ATTEMPTS, ImportError, mainImportApi } from '../import-api.ts';

interface Reply {
  status: number;
  data: unknown;
  error?: { value: { code: string } };
  response?: Response;
}

function client(replies: Reply[]) {
  const sent: Array<{ body: unknown; headers: { 'idempotency-key': string }; signal?: AbortSignal }> = [];
  const waits: number[] = [];
  const post = async (body: unknown, { headers, fetch }: { headers: { 'idempotency-key': string }; fetch?: { signal?: AbortSignal } }) => {
    sent.push({ body, headers, signal: fetch?.signal });
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
  test('permanent 429 exhausts finite attempts and remains admission, never unavailable', async () => {
    const { api, sent, waits } = client(Array.from({ length: IMPORT_REQUEST_ATTEMPTS }, () => admission('0')));
    await expect(api.inspect('Title')).rejects.toEqual(new ImportError('admission'));
    expect(sent).toHaveLength(IMPORT_REQUEST_ATTEMPTS);
    expect(waits).toHaveLength(IMPORT_REQUEST_ATTEMPTS - 1);
    expect(new Set(sent.map(request => request.headers['idempotency-key'])).size).toBe(1);
  });

  test('Retry-After beyond the observation window stops without an early retry', async () => {
    const { api, sent, waits } = client([admission('60')]);
    await expect(api.inspect('Title')).rejects.toEqual(new ImportError('admission'));
    expect(sent).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test('permanent 202 adoption exhausts as pending, never unavailable', async () => {
    const { api, sent } = client(Array.from({ length: IMPORT_REQUEST_ATTEMPTS }, pending));
    await expect(api.adopt('import', 1, 'OL1W', 'en')).rejects.toEqual(new ImportError('pending'));
    expect(sent).toHaveLength(IMPORT_REQUEST_ATTEMPTS);
  });

  test('abort interrupts admission waits and prevents the next command', async () => {
    const controller = new AbortController();
    const { api, sent } = client([admission()]);
    const response = api.inspect('Title', { signal: controller.signal });
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.signal?.aborted).toBe(true);
  });

  test('abort reaches an in-flight SDK fetch and releases an adapter that never answers', async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const main = { v1: { me: { 'library-imports': { post: (_body: unknown,
      options: { fetch: { signal: AbortSignal } }) => {
      fetchSignal = options.fetch.signal;
      return new Promise(() => {});
    } } } } } as unknown as MainClient;
    const response = mainImportApi('reader', () => main).inspect('Title', { signal: controller.signal });
    controller.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSignal?.aborted).toBe(true);
  });

  test('already cancelled operations send nothing', async () => {
    const controller = new AbortController(); controller.abort();
    const { api, sent } = client([]);
    await expect(api.inspect('Title', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(sent).toHaveLength(0);
  });

  test('abort after 429 arrives interrupts its Retry-After wait', async () => {
    const controller = new AbortController();
    let calls = 0, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const main = { v1: { me: { 'library-imports': { post: async () => { calls++; return admission('2'); } } } } } as unknown as MainClient;
    const api = mainImportApi('reader', () => main, async (_delay, signal) => {
      expect(signal?.aborted).toBe(false); entered(); return new Promise(() => {});
    });
    const response = api.inspect('Title', { signal: controller.signal });
    await waiting; controller.abort();
    await expect(response).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(1);
  });

});
