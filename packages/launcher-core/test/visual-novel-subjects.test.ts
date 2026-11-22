import { expect, test } from 'bun:test';
import { createVisualNovelSubjects } from '../src/plugins/visual-novel-subjects.ts';

const website = new URL('https://rezics.example.invalid');

test('finds localized VN titles through the public Subject client without sending local metadata', async () => {
  const requests: { url: string; method?: string | undefined; body: unknown }[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { languages: string[] };
    requests.push({
      url: input.toString(),
      method: init?.method,
      body,
    });
    const labels: Record<string, string> = { en: 'Fixture', 'zh-Hant': '測試作品' };
    const language = body.languages.find((tag) => Object.hasOwn(labels, tag)) ?? 'en';
    return Response.json({
      subjects: [
        { id: 'catalogue-vn', type: 'wd:Q689445', labels: { [language]: labels[language] } },
        { id: 'same-title-book', type: 'schema:Book', labels: { 'zh-Hans': '测试作品' } },
        { id: 'no-title', type: 'wd:Q689445', labels: {} },
      ],
      next: null,
      as_of: '2026-11-21T10:00:00Z',
    });
  }) as typeof fetch;
  const { search } = createVisualNovelSubjects('https://catalog.example.invalid/v1/', website, 'zh-CN', fetcher);

  expect(await search(' 测试作品 ')).toEqual([{ id: 'catalogue-vn', type: 'wd:Q689445', title: '測試作品' }]);
  expect(requests).toEqual([
    {
      url: 'https://catalog.example.invalid/v1/subjects:search',
      method: 'POST',
      body: {
        text: '测试作品',
        filter: { type: { in: ['wd:Q689445'] } },
        languages: ['zh-CN', 'zh', 'zh-Hans', 'zh-Hant', 'en', 'ja'],
        limit: 8,
      },
    },
  ]);
  await expect(search(' '.repeat(200))).rejects.toThrow('search title');
  expect(requests).toHaveLength(1);
});

test('reads only the requested public visual novel and keeps unavailable titles distinct from a service failure', async () => {
  const id = '018943aa-abcd-4abc-9abc-0123456789ab';
  const visualNovel = { id, type: 'wd:Q689445', labels: { en: 'An English title', ja: '作品名' } };
  const replies = [
    Response.json({ subject: visualNovel }),
    Response.json({ subject: { ...visualNovel, type: 'schema:Book' } }),
    Response.json({ subject: { ...visualNovel, id: 'another-subject' } }),
    Response.json({}, { status: 404 }),
    Response.json({}, { status: 503 }),
  ];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    expect(input.toString()).toBe(`https://catalog.example.invalid/v1/subjects/${id}`);
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    expect(init?.redirect).toBe('error');
    return replies.shift()!;
  }) as typeof fetch;
  const { read } = createVisualNovelSubjects('https://catalog.example.invalid/v1', website, 'ja-JP', fetcher);

  expect(await read(id)).toEqual({ id, type: visualNovel.type, title: '作品名' });
  expect(await read(id)).toBeNull();
  expect(await read(id)).toBeNull();
  expect(await read(id)).toBeNull();
  await expect(read(id)).rejects.toThrow('Could not read the linked REZICS title.');
});

test('cancels only the abandoned title search and passes cancellation to the Subject request', async () => {
  const calls: { signal: AbortSignal; reply: (response: Response) => void }[] = [];
  const entered = Promise.withResolvers<void>();
  const fetcher = ((_input: string | URL, init: RequestInit) => {
    if (!init.signal) throw new Error('Expected a request signal.');
    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    const signal = init.signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    calls.push({ signal, reply: resolve });
    if (calls.length === 2) entered.resolve();
    return promise;
  }) as typeof fetch;
  const { search } = createVisualNovelSubjects('https://catalog.example.invalid', website, 'en', fetcher);
  const abandoned = new AbortController();
  const first = search('First title', abandoned.signal);
  const second = search('Second title');
  await entered.promise;
  const [firstCall, secondCall] = calls;
  if (!firstCall || !secondCall) throw new Error('Both title searches should be in flight.');
  expect(firstCall.signal.aborted).toBe(false);
  abandoned.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(firstCall.signal.aborted).toBe(true);
  expect(secondCall.signal.aborted).toBe(false);
  secondCall.reply(Response.json({ subjects: [{ id: 'second', type: 'wd:Q689445', labels: { en: 'Second title' } }] }));
  expect(await second).toEqual([{ id: 'second', title: 'Second title', type: 'wd:Q689445' }]);
  await expect(search('Late title', abandoned.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toHaveLength(2);
});

test('resolves a pasted REZICS link or ID through the exact public read', async () => {
  const id = '018943aa-abcd-4abc-9abc-0123456789ab';
  const reply = { id, type: 'wd:Q689445', labels: { en: 'The Question' } };
  const requests: string[] = [];
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    expect(init?.method).toBe('GET');
    expect(init?.body).toBeUndefined();
    requests.push(input.toString());
    return Response.json({ subject: reply });
  }) as typeof fetch;
  const { search } = createVisualNovelSubjects('https://catalog.example.invalid', website, 'en', fetcher);
  const title = [{ id, type: reply.type, title: 'The Question' }];

  expect(await search(`${website.origin}/en/subjects/${id}/the-question/details?from=library#summary`)).toEqual(title);
  expect(await search(id.toUpperCase())).toEqual(title);
  expect(await search(`https://elsewhere.invalid/subjects/${id}`)).toEqual([]);
  expect(await search(`${website.origin}/books/${id}`)).toEqual([]);
  expect(await search(`https://user@${website.host}/subjects/${id}`)).toEqual([]);
  expect(requests).toEqual(Array(2).fill(`https://catalog.example.invalid/v1/subjects/${id}`));
});
