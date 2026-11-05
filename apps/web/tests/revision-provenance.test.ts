import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import type { DocumentSnapshot } from '@rezics/document';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { revisePostRequest, startThreadRequest } from '../src/threads/post-writes';
import { RevisionProvenance } from '../src/threads/revision-provenance-view';
import { readAuthorRevisionVotes, readRevisionSubjects } from '../src/threads/revision-provenance';
import { m } from '../src/paraglide/messages.js';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const body: DocumentSnapshot = {
  version: 'rezics-document-v1',
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', attrs: { id: 'stable-block' }, content: [{ type: 'text', text: 'Revised words' }] }],
  },
};
const request = () => new Request('https://rezics.test/', { headers: { authorization: 'Bearer author' } });
const refusal = () => ({ ok: false as const, reason: 'unavailable' as const });
function client(handler: (request: Request) => Promise<Response> | Response) {
  return createKernelClient('https://kernel.test', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect() {},
    }),
  });
}

test('an ordinary edit inherits a non-default licence and preserves document/block identity and 412 recovery', async () => {
  const sent: { body: Record<string, unknown>; headers: Headers }[] = [];
  let stale = false;
  let licence = 'CC-BY-SA-4.0';
  const kernel = client(async (call) => {
    // A protected post is readable by this author, never by an anonymous recovery read.
    expect(call.headers.get('authorization')).toBe('Bearer author');
    if (call.method === 'GET') return Response.json({ post: { body, licence } }, { headers: { etag: `"${id(8)}"` } });
    const payload = await call.json();
    sent.push({ body: payload, headers: call.headers });
    if (new URL(call.url).pathname === '/v1/threads') return Response.json({ thread: { id: id(9) } });
    if (stale) return Response.json({ code: 'precondition_failed' }, { status: 412 });
    if (typeof payload.licence === 'string') licence = payload.licence;
    return Response.json({ post: { body: payload.body, licence, revisionId: id(8) } });
  });
  const input = { postId: id(1), revisionId: id(2), idempotencyKey: id(3), body };
  const revised = await revisePostRequest(input, request(), {}, kernel, refusal);
  expect(revised).toMatchObject({ ok: true, post: { licence: 'CC-BY-SA-4.0', body } });
  expect(sent[0]!.body).not.toHaveProperty('licence');
  expect(sent[0]!.body.body).toEqual(body);
  expect(sent[0]!.headers.get('if-match')).toBe(`"${id(2)}"`);
  expect(sent[0]!.headers.get('idempotency-key')).toBe(JSON.stringify(id(3)));
  stale = true;
  expect(await revisePostRequest(input, request(), {}, kernel, refusal)).toMatchObject({
    ok: false,
    reason: 'stale',
    currentPost: { revisionId: id(8) },
  });
  expect(input.body).toEqual(body);
  await startThreadRequest(
    { boardId: id(4), title: 'New post', body, idempotencyKey: id(5) },
    request(),
    {},
    kernel,
    refusal,
  );
  expect(sent.at(-1)!.body.licence).toBe('LicenseRef-rezics-terms');
});

test('two revisions retain their references/citations after a vote change; only the author gets private comparisons', async () => {
  const revisions = [14, 8].map((units, index) => ({
    id: id(10 + index),
    authorId: id(90),
    licence: index ? 'CC-BY-4.0' : 'CC-BY-SA-4.0',
    subjectIds: [id(20 + index)],
    voteCitation: { questionId: id(30), units, revision: index + 1 },
  }));
  const reads: Request[] = [];
  let currentUnits = 18;
  let ownStatus = 200;
  const kernel = client((call) => {
    reads.push(call);
    if (ownStatus === 0) throw new TypeError('Network unavailable');
    if (new URL(call.url).pathname.endsWith('/vote'))
      return Response.json(
        ownStatus === 200 ? { units: currentUnits, revision: 7, at: '2026-10-31T00:00:00Z' } : { code: 'unavailable' },
        { status: ownStatus },
      );
    const subjectId = new URL(call.url).pathname.split('/').at(-1)!;
    if (subjectId === id(21)) return Response.json({ code: 'not_found' }, { status: 404 });
    return Response.json({
      subject: { id: subjectId, type: 'schema:Book', labels: { en: 'First edition' } },
      summary: { label: { value: 'First edition' }, types: ['schema:Book'], cover: null },
    });
  });
  const subjects = await readRevisionSubjects(kernel, revisions);
  const markup = (index: number, votes: Awaited<ReturnType<typeof readAuthorRevisionVotes>>) =>
    renderToStaticMarkup(
      createElement(RevisionProvenance, {
        revision: revisions[index]!,
        subjects,
        currentVote: votes[revisions[index]!.id] ?? null,
        review: true,
      }),
    );
  for (const viewer of [null, { id: id(91), authorization: 'Bearer reader' }]) {
    const votes = await readAuthorRevisionVotes(kernel, revisions, viewer);
    expect(votes).toEqual({});
    expect(markup(0, votes)).toContain('First edition');
    expect(markup(1, votes)).toContain(id(21));
    expect(markup(1, votes)).not.toContain('<a');
    expect(markup(0, votes)).not.toContain(m.thread_provenance_current_vote());
  }
  expect(reads.filter((call) => call.url.endsWith('/vote'))).toHaveLength(0);
  const author = { id: id(90), authorization: 'Bearer author' };
  for (const units of [18, 0]) {
    currentUnits = units;
    const votes = await readAuthorRevisionVotes(kernel, revisions, author);
    for (const index of [0, 1]) {
      const html = markup(index, votes);
      expect(html).toContain(revisions[index]!.licence);
      expect(html).toContain(
        m.thread_provenance_vote({
          units: String(revisions[index]!.voteCitation.units),
          questionId: id(30),
          revision: String(revisions[index]!.voteCitation.revision),
        }),
      );
      expect(html).toContain(m.thread_provenance_current_vote());
      expect(html).toContain(m.thread_provenance_vote({ units: String(units), questionId: id(30), revision: '7' }));
    }
  }
  for (const status of [404, 403, 503, 0]) {
    ownStatus = status;
    expect(markup(0, await readAuthorRevisionVotes(kernel, revisions, author))).not.toContain(
      m.thread_provenance_current_vote(),
    );
  }
  expect(
    reads
      .filter((call) => call.url.endsWith('/vote'))
      .every((call) => call.headers.get('authorization') === 'Bearer author'),
  ).toBe(true);
  expect(markup(0, {})).not.toContain(id(21));
  expect(markup(1, {})).not.toContain('First edition');
});
