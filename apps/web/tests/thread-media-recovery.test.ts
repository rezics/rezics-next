import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { ReplyImageUploadRecovery, type ReplyUploadContext } from '../src/threads/media-upload-recovery';
import { UploadRefusal } from '../src/threads/upload';
import { readDraftMediaStates } from '../src/threads/media-state';
import { ReplyIntent } from '../src/threads/reply-context-intent';
import { replyToThreadRequest } from '../src/threads/reply-context-request';
import type { WriteFailure } from '../src/threads/actions';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { mediaIssueList, mediaAfterRefusal, draftHasMediaIssues } = await import('../src/threads/composer');
const { m } = await import('../src/paraglide/messages.js');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const file = () => new File(['original image bytes'], 'chart.png', { type: 'image/png' });
const session = { subject: id(90), csrfToken: 'current-session-csrf' };
const signal = () => new AbortController().signal;
function uncertain(mediaId = id(1)) {
  const error = new UploadRefusal('unavailable');
  error.mediaId = mediaId;
  return error;
}
function draftWithImages(ids: string[]): DocumentSnapshot {
  const text = fromPlainText('Keep my reply, citation and image descriptions.', 'blocks');
  return {
    ...text,
    doc: {
      ...text.doc,
      content: [
        ...text.doc.content!,
        ...ids.map((src, index) => ({ type: 'image', attrs: { id: `image-${index}`, src, alt: `Chart ${index}` } })),
      ],
    },
  };
}

test('Composer retries known uploads and shows unknown native media state without losing the draft', async () => {
  const original = file();
  const fresh = mock(async () => {
    throw uncertain();
  });
  const resume = mock(async (mediaId: string, retryFile: File) => {
    expect(retryFile).toBe(original);
    return { src: mediaId, width: 4, height: 3 };
  });
  const recovery = new ReplyImageUploadRecovery(() => ({ target: id(20), session }), {
    uploadReplyImage: fresh,
    resumeReplyImageUpload: resume,
  });
  await expect(recovery.upload(original, signal())).rejects.toMatchObject({ mediaId: id(1) });
  expect(await recovery.upload(original, signal())).toEqual({ src: id(1), width: 4, height: 3 });
  expect(fresh).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]![0]).toBe(id(1));

  const body = draftWithImages([id(1)]);
  const draft = { title: 'Draft subject', body, mediaIds: [id(1)] };
  const before = structuredClone(draft);
  const intent = new ReplyIntent(id(30));
  const command = intent.prepare(draft, id(40));
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request.clone());
        return request.method === 'POST'
          ? Response.json({ code: 'media_unavailable' }, { status: 409 })
          : Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const refused = await replyToThreadRequest({ ...command, threadId: id(20) }, client, 'Bearer current-author', () => ({
    ok: false,
    reason: 'media-unavailable',
  }));
  expect(refused).toMatchObject({
    ok: false,
    reason: 'media-unavailable',
    media: [{ id: id(1), state: 'unavailable' }],
  });
  if (refused.ok) throw new Error('Expected a native claim refusal');
  const media = mediaAfterRefusal(refused.media!, body, new Set([id(1)]));
  expect(draftHasMediaIssues({ ...refused, media }, body)).toBe(true);
  const html = renderToStaticMarkup(
    mediaIssueList(
      media,
      body,
      () => {},
      () => {},
      () => {},
    ),
  );
  expect(html).toContain('Chart 0');
  expect(html).toContain(m.thread_media_state_unavailable());
  expect(html).toContain(m.thread_media_check_again());
  expect(html).not.toContain(m.thread_media_missing());
  expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/threads/${id(20)}/posts`,
    `/v1/media/${id(1)}`,
  ]);
  expect(await requests[0]!.json()).toMatchObject({ body, parentId: id(40), mediaIds: [id(1)] });
  expect(requests[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(command.idempotencyKey));
  expect(intent.prepare(draft, id(40))).toEqual(command);
  expect(draft).toEqual(before);
});

test('retry never crosses original target, future-thread key or actual author session; abort releases the file', async () => {
  for (const change of [
    { target: id(21), session },
    { target: { newThread: { boardId: id(22), idempotencyKey: id(32) } }, session },
    { target: { newThread: { boardId: id(22), idempotencyKey: id(31) } }, session: { ...session, subject: id(91) } },
    {
      target: { newThread: { boardId: id(22), idempotencyKey: id(31) } },
      session: { ...session, csrfToken: 'another-session' },
    },
  ]) {
    let context: ReplyUploadContext = { target: { newThread: { boardId: id(22), idempotencyKey: id(31) } }, session };
    const fresh = mock(async () => {
      throw uncertain();
    });
    const resume = mock(async () => ({ src: id(1) }));
    const recovery = new ReplyImageUploadRecovery(() => context, {
      uploadReplyImage: fresh,
      resumeReplyImageUpload: resume,
    });
    const original = file();
    await expect(recovery.upload(original, signal())).rejects.toBeInstanceOf(UploadRefusal);
    context = change;
    const dismiss = new AbortController();
    await expect(recovery.upload(original, dismiss.signal)).rejects.toMatchObject({ recovery: 'target-changed' });
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    dismiss.abort();
    // Reselecting after removal is a deliberate new file intent, even if a caller retains the same File object.
    await expect(recovery.upload(original, signal())).rejects.toBeInstanceOf(UploadRefusal);
    expect(fresh).toHaveBeenCalledTimes(2);
    recovery.clear();
  }
});

test('rejected uploads need a fresh selection; an absent resume producer keeps the original reservation unavailable', async () => {
  for (const outcome of ['rejected', 'absent', 'no-id'] as const) {
    const original = file();
    const fresh = mock(async () => {
      throw outcome === 'no-id' ? new UploadRefusal('unavailable') : uncertain();
    });
    const resume = mock(async () => {
      throw new UploadRefusal('rejected');
    });
    const recovery = new ReplyImageUploadRecovery(() => ({ target: id(20), session }), {
      uploadReplyImage: fresh,
      ...(outcome === 'rejected' ? { resumeReplyImageUpload: resume } : {}),
    });
    await expect(recovery.upload(original, signal())).rejects.toBeInstanceOf(UploadRefusal);
    await expect(recovery.upload(original, signal())).rejects.toBeInstanceOf(UploadRefusal);
    await expect(recovery.upload(original, signal())).rejects.toBeInstanceOf(UploadRefusal);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(outcome === 'rejected' ? 1 : 0);
    recovery.clear();
  }
});

test('native media reads remain bounded, distinct and unavailable on failure; denied writes do not inspect media', async () => {
  let writes = 0;
  const reads: string[] = [];
  const states = ['reserved', 'uploaded', 'rejected', 'erased', 'missing', 'unavailable', 'available'] as const;
  const ids = states.map((_, index) => id(index + 1));
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.method === 'POST') {
          writes++;
          return Response.json({ code: 'forbidden' }, { status: 403 });
        }
        const mediaId = new URL(request.url).pathname.split('/').at(-1)!;
        reads.push(mediaId);
        const state = states[ids.indexOf(mediaId)];
        return state === 'missing' || state === 'unavailable'
          ? Response.json({ code: 'unavailable' }, { status: state === 'missing' ? 404 : 503 })
          : Response.json({ media: { id: mediaId, state } });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const media = await readDraftMediaStates(client, 'Bearer current-author', [...ids, ids[0]!]);
  expect(media.map((item) => item.state)).toEqual(states);
  expect(reads).toEqual(ids);
  const body = draftWithImages(ids);
  const presentation = mediaAfterRefusal(media, body, new Set());
  expect(presentation.at(-1)?.state).toBe('used');
  const html = renderToStaticMarkup(
    mediaIssueList(
      presentation,
      body,
      () => {},
      () => {},
      () => {},
    ),
  );
  for (const label of [
    m.thread_media_processing(),
    m.thread_media_rejected(),
    m.thread_media_erased(),
    m.thread_media_missing(),
    m.thread_media_used(),
    m.thread_media_state_unavailable(),
  ])
    expect(html).toContain(label);
  const overflow = Array.from({ length: 33 }, (_, index) => id(index + 1));
  expect(
    (await readDraftMediaStates(client, 'Bearer current-author', overflow)).every(
      (item) => item.state === 'unavailable',
    ),
  ).toBe(true);
  expect(reads).toEqual(ids);
  const refusal = (): WriteFailure => ({ ok: false, reason: 'forbidden' });
  expect(
    await replyToThreadRequest(
      { body, mediaIds: ids, threadId: id(20), idempotencyKey: id(30) },
      client,
      'Bearer current-author',
      refusal,
    ),
  ).toEqual(refusal());
  expect(writes).toBe(1);
  expect(reads).toEqual(ids);
});

test('an uncertain post retains its exact original command until a known refusal permits a changed intent', () => {
  const intent = new ReplyIntent(id(30));
  const draft = { title: 'Subject', body: draftWithImages([id(1)]), mediaIds: [id(1)] };
  const original = intent.prepare(draft, id(40), 'thread/current-session');
  intent.settle(false);
  expect(intent.selectParent(null)).toBe(original.idempotencyKey);
  expect(intent.canPrepare({ ...draft, title: 'Changed' }, id(40), 'thread/current-session')).toBe(false);
  expect(intent.canPrepare(draft, null, 'thread/current-session')).toBe(false);
  expect(intent.canPrepare(draft, id(40), 'thread/another-session')).toBe(false);
  expect(intent.prepare(draft, id(40), 'thread/current-session')).toBe(original);
  intent.settle(true);
  expect(intent.prepare({ ...draft, title: 'Changed' }, null, 'thread/current-session').idempotencyKey).not.toBe(
    original.idempotencyKey,
  );
});
