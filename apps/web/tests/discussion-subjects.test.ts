import { expect, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { searchContentSubjects } from '../src/threads/content-subject-search';
import { discussionSubjectIds, startThreadRequest } from '../src/threads/post-writes';
import { ReplyIntent } from '../src/threads/reply-context-intent';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const subjects = Array.from({ length: 128 }, (_, n) => id(n + 1));

test('discussion references accept zero, the existing single preset, and exactly 128 ordered unique native IDs', () => {
  expect(discussionSubjectIds({})).toEqual([]);
  expect(discussionSubjectIds({ subjectId: id(4) })).toEqual([id(4)]);
  expect(discussionSubjectIds({ subjectIds: [] })).toEqual([]);
  expect(discussionSubjectIds({ subjectIds: subjects })).toEqual(subjects);
  for (const invalid of [
    { subjectIds: [...subjects, id(129)] },
    { subjectIds: [id(1), id(1)] },
    { subjectIds: [null] },
    { subjectIds: ['bad-id'] },
    { subjectIds: [id(1).toUpperCase()] },
    { subjectIds: ['0192f3a0-6c1e-4b2a-9d4e-000000000001'] },
    { subjectIds: id(1) },
    { subjectIds: undefined },
    { subjectId: id(1), subjectIds: [] },
  ])
    expect(() => discussionSubjectIds(invalid)).toThrow();
});

test('discussion selection snapshots keep the complete ordered 128-reference limit in the caller intent', () => {
  const intent = new ReplyIntent<{ subjectIds: string[] }>(id(130));
  const selected = [...subjects].reverse();
  const draft = {
    title: 'Ordered references',
    body: fromPlainText('One ordinary discussion', 'blocks'),
    mediaIds: [],
    submissionContext: { subjectIds: selected },
  };
  const command = intent.prepare(draft, null, JSON.stringify([null, id(131), 'viewer', 'csrf']));

  selected.pop();
  expect(command.submissionContext).toEqual({ subjectIds: [...subjects].reverse() });
  expect(command.submissionContext?.subjectIds).toHaveLength(128);
  expect(command.submissionContext).not.toHaveProperty('voteCitation');
  expect(discussionSubjectIds({ subjectIds: command.submissionContext!.subjectIds })).toEqual([...subjects].reverse());
});

test('a multi-reference discussion keeps the exact body, media, ordered selection and key through a lost response', async () => {
  const calls: { body: unknown; key: string }[] = [];
  const client = {
    threads: {
      post: async (body: unknown, options: { headers: { 'idempotency-key': string } }) => {
        calls.push({ body: structuredClone(body), key: options.headers['idempotency-key'] });
        if (calls.length === 1) throw new Error('Response lost after commit');
        return { data: { thread: { id: id(200) } } };
      },
    },
  } as unknown as KernelClient;
  const intent = new ReplyIntent<{ subjectIds: string[] }>(id(201));
  const draft = {
    title: 'Shared themes',
    body: fromPlainText('A discussion', 'blocks'),
    mediaIds: [id(202)],
    submissionContext: { subjectIds: [...subjects].reverse() },
  };
  const scope = JSON.stringify([null, id(203), 'viewer', 'csrf']);
  const command = intent.prepare(draft, null, scope);
  intent.settle(false);
  draft.submissionContext.subjectIds.pop();
  expect(intent.canPrepare(draft, null, scope)).toBe(false);
  const send = (original: typeof command) =>
    startThreadRequest(
      { boardId: id(203), ...original, ...original.submissionContext! },
      new Request('https://rezics.test/', { headers: { authorization: 'Bearer viewer' } }),
      {},
      client,
      () => ({ ok: false, reason: 'unavailable' }),
    );
  expect(await send(command)).toEqual({ ok: false, reason: 'unavailable' });
  intent.settle(false);
  const originalDraft = { ...draft, submissionContext: { subjectIds: [...subjects].reverse() } };
  for (const submissionContext of [{ subjectIds: [] }, { subjectIds: subjects }])
    expect(() => intent.prepare({ ...draft, submissionContext }, null, scope)).toThrow();
  expect(intent.canPrepare(originalDraft, null, `${scope}changed-account`)).toBe(false);
  const retry = intent.prepare(originalDraft, null, scope);
  expect(retry).toBe(command);
  expect(await send(retry)).toMatchObject({ ok: true });
  await expect(send({ ...command, submissionContext: { subjectIds: [...subjects, id(129)] } })).rejects.toThrow();
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(calls[0]);
  expect(calls[0]).toEqual({
    key: JSON.stringify(id(201)),
    body: {
      boardId: id(203),
      title: draft.title,
      body: draft.body,
      mediaIds: draft.mediaIds,
      subjectIds: [...subjects].reverse(),
      licence: 'LicenseRef-rezics-terms',
      visibility: 'published',
    },
  });
});

test('one suggestion call maps the original review labels and covers and rejects unavailable or aborted responses', async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const calls: string[] = [];
  let unavailable = false;
  let abortLate = false;
  globalThis.fetch = (async (url, init) => {
    calls.push(String(url));
    expect(init?.signal).toBe(controller.signal);
    if (unavailable) return new Response(null, { status: 503 });
    if (abortLate) controller.abort();
    return Response.json({
      subjects: [{ id: id(2), labels: { en: 'Second subject' }, type: 'schema:Book', facts: {}, summary: null }],
      types: { 'schema:Book': { en: 'Book' } },
    });
  }) as typeof fetch;
  try {
    const found = await searchContentSubjects('Second & subject', controller.signal);
    expect(found).toEqual([
      { id: id(2), title: 'Second subject', types: ['schema:Book'], typeLabel: 'Book', year: null, cover: null },
    ]);
    expect(calls).toEqual(['/api/search/suggestions?q=Second%20%26%20subject&locale=en']);
    unavailable = true;
    await expect(searchContentSubjects('Unavailable', controller.signal)).rejects.toThrow('Suggestions unavailable');
    unavailable = false;
    abortLate = true;
    await expect(searchContentSubjects('Old query', controller.signal)).rejects.toThrow();
    const before = calls.length;
    await expect(searchContentSubjects('Aborted query', controller.signal)).rejects.toThrow();
    expect(calls).toHaveLength(before);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
