import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { readModerationReports, resolveReportTargets } = await import('../src/moderation/reports-read');
const { dismissReport, reportDecisionReason, takeDownReport } = await import('../src/moderation/actions');
const { ModerationReportsView } = await import('../src/moderation/reports-page');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function report(
  n: number,
  target: { kind: 'post' | 'thread'; id: string },
  outcome: 'actioned' | 'dismissed' | null = null,
) {
  return {
    id: id(n),
    target,
    revisionId: null,
    reason: `Reason ${n}`,
    evidence: null,
    createdAt: `2026-01-0${n}T12:00:00.000Z`,
    outcome,
    resolvedAt: outcome ? '2026-01-10T12:00:00.000Z' : null,
    reporterId: `private-reporter-${n}`,
  };
}

test('board report pages retain their cursor, omit reporter identity, and resolve each distinct target once', async () => {
  const calls: string[] = [];
  const reports = [
    report(1, { kind: 'post', id: id(50) }),
    report(2, { kind: 'post', id: id(50) }),
    report(3, { kind: 'thread', id: id(51) }),
  ];
  const page = await readModerationReports(
    {
      boardReports: async (boardId, cursor) => {
        calls.push(`board:${boardId}:${cursor ?? ''}`);
        return { reports, next: 'next+page==' };
      },
      threadReports: async () => ({ reports: [], next: null }),
      postReports: async () => ({ reports: [], next: null }),
    },
    { boardId: id(1), cursor: 'current/page==' },
  );
  const targets = await resolveReportTargets(page.reports, {
    post: async (targetId) => {
      calls.push(`post:${targetId}`);
      return {
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reported post text' }] }],
        },
      };
    },
    thread: async (targetId) => {
      calls.push(`thread:${targetId}`);
      return { title: 'Reported thread' };
    },
  });

  expect(page.next).toBe('next+page==');
  expect(calls).toEqual([`board:${id(1)}:current/page==`, `post:${id(50)}`, `thread:${id(51)}`]);
  expect(targets).toHaveLength(2);
  expect(JSON.stringify(page)).not.toContain('private-reporter');
  expect(JSON.stringify(targets)).toContain('Reported post text');
});

test('thread scope reads reports from the thread endpoint and the read owns outcomes', async () => {
  const calls: string[] = [];
  const page = await readModerationReports(
    {
      boardReports: async () => {
        calls.push('board');
        return { reports: [], next: null };
      },
      threadReports: async (threadId, cursor) => {
        calls.push(`thread:${threadId}:${cursor ?? ''}`);
        return { reports: [report(1, { kind: 'thread', id: threadId }, 'dismissed')], next: null };
      },
      postReports: async () => ({ reports: [], next: null }),
    },
    { boardId: id(1), threadId: id(2), cursor: 'thread-cursor' },
  );
  expect(calls).toEqual([`thread:${id(2)}:thread-cursor`]);
  expect(page.reports[0]?.outcome).toBe('dismissed');
});

test('pages of five and twenty reports read each repeated target once', async () => {
  for (const count of [5, 20]) {
    let targetReads = 0;
    const repeated = Array.from({ length: count }, (_, index) => report(index + 1, { kind: 'post', id: id(77) }));
    const page = await readModerationReports(
      {
        boardReports: async () => ({ reports: repeated, next: null }),
        threadReports: async () => ({ reports: [], next: null }),
        postReports: async () => ({ reports: [], next: null }),
      },
      { boardId: id(1) },
    );
    const targets = await resolveReportTargets(page.reports, {
      post: async () => {
        targetReads += 1;
        return { post: { body: 'same target' } };
      },
      thread: async () => {
        targetReads += 1;
        return null;
      },
      board: async () => {
        targetReads += 1;
        return null;
      },
    });
    expect(page.reports).toHaveLength(count);
    expect(targets).toHaveLength(1);
    expect(targetReads).toBe(1);
  }
});

test('post scope reads reports for one known post and carries its cursor', async () => {
  const calls: string[] = [];
  const postId = id(88);
  const page = await readModerationReports(
    {
      boardReports: async () => {
        calls.push('board');
        return { reports: [], next: null };
      },
      threadReports: async () => {
        calls.push('thread');
        return { reports: [], next: null };
      },
      postReports: async (targetId, cursor) => {
        calls.push(`post:${targetId}:${cursor ?? ''}`);
        return { reports: [report(1, { kind: 'post', id: targetId })], next: null };
      },
    },
    { boardId: id(1), postId, cursor: 'post-cursor' },
  );
  expect(calls).toEqual([`post:${postId}:post-cursor`]);
  expect(page.reports[0]?.target).toEqual({ kind: 'post', id: postId });
});

test('take down and dismiss send their established commands and return to read outcomes', async () => {
  const calls: { path: string; body: unknown }[] = [];
  const fetcher = async (path: string, body: unknown) => {
    calls.push({ path, body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ outcome: path.includes('dismiss') ? 'dismissed' : 'actioned' }),
    };
  };
  await takeDownReport(fetcher, {
    reportId: id(1),
    targetKind: 'board',
    targetId: id(2),
    reason: '  Policy reason  ',
  });
  await dismissReport(fetcher, { reportId: id(3) });
  expect(calls).toEqual([
    { path: `/v1/boards/${id(2)}:takeDown`, body: { reason: 'Policy reason' } },
    { path: `/v1/reports/${id(3)}:dismiss`, body: {} },
  ]);
  expect(() => reportDecisionReason('   ')).toThrow();
  expect(() => reportDecisionReason('R'.repeat(1025))).toThrow();
  expect(reportDecisionReason(`  ${'😀'.repeat(1024)}  `)).toBe('😀'.repeat(1024));
});

test('the reports page renders target, reason, report time and read outcomes without reporter identity', () => {
  const reports = [
    report(1, { kind: 'post', id: id(50) }, 'actioned'),
    report(2, { kind: 'thread', id: id(51) }, 'dismissed'),
  ];
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports,
      targets: [
        { key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Reported post content' } } },
        { key: `thread:${id(51)}`, kind: 'thread', value: { thread: { title: 'Reported thread title' } } },
      ],
      next: null,
    }),
  );

  expect(markup).toContain('Reported post content');
  expect(markup).toContain('Reported thread title');
  expect(markup).toContain('Reason 1');
  expect(markup).toContain('dateTime="2026-01-01T12:00:00.000Z"');
  expect(markup).toContain('Actioned');
  expect(markup).toContain('Dismissed');
  expect(markup).not.toContain('private-reporter');
  expect(markup).not.toContain('Dismiss</button>');
});

test('open reports require one native-sized reason for take down and offer dismissal', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports: [report(1, { kind: 'post', id: id(50) })],
      targets: [{ key: `post:${id(50)}`, kind: 'post', value: { post: { body: 'Reported post content' } } }],
      next: null,
    }),
  );
  expect(markup).toContain('Take down');
  expect(markup).toContain('Dismiss');
  expect(markup).toContain('name="reason" required');
  expect(markup).not.toContain('name="statement"');
  expect(markup.match(/<textarea/g)).toHaveLength(1);
  expect(markup).toContain('maxLength="1024"');
});

test('withheld and deleted report targets use the existing content placeholders', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports: [report(1, { kind: 'post', id: id(50) }), report(2, { kind: 'post', id: id(51) })],
      targets: [
        { key: `post:${id(50)}`, kind: 'post', value: { post: { availability: 'withheld' } } },
        { key: `post:${id(51)}`, kind: 'post', value: { post: { availability: 'erased' } } },
      ],
      next: null,
    }),
  );
  expect(markup).toContain('data-slot="withheld"');
  expect(markup).toContain('data-slot="tombstone"');
});

test('reported post documents are extracted from the block profile read shape', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      reports: [report(1, { kind: 'post', id: id(50) })],
      targets: [
        {
          key: `post:${id(50)}`,
          kind: 'post',
          value: {
            post: {
              body: {
                version: 'rezics-document-v1',
                profile: 'blocks',
                doc: {
                  type: 'doc',
                  content: [
                    {
                      type: 'paragraph',
                      attrs: { id: 'reported-block-post' },
                      content: [{ type: 'text', text: 'Reported block post text' }],
                    },
                  ],
                },
              },
            },
          },
        },
      ],
      next: null,
    }),
  );
  expect(markup).toContain('Reported block post text');
});

test('the reports route is signed-in, noindex, private, and conceals refused reads', async () => {
  const route = await Bun.file(new URL('../src/routes/boards/$id_.moderation.tsx', import.meta.url)).text();
  const read = await Bun.file(new URL('../src/moderation/reports-read.ts', import.meta.url)).text();
  expect(route).toContain('beforeLoad: requireSignedIn');
  expect(route).toContain("robots: 'noindex, nofollow'");
  expect(read).toContain("setResponseHeader('cache-control', 'private, no-store')");
  // The accepted reader contract replaces the old single throw/source-string oracle with
  // unavailable/denied page states. Native refusal still conceals all private evidence;
  // the connected campaign exercises those outcomes through the actual loader.
  expect(read).toContain('if (!authorization || !readerOrigin) throw notFound()');
  expect(read).toContain("[401, 403, 404].includes(status) ? 'denied' : 'error'");
});

test('the board actions menu exposes moderation only to signed-in viewers', async () => {
  const boardRoute = await Bun.file(new URL('../src/routes/boards/$id.tsx', import.meta.url)).text();
  expect(boardRoute).toContain("session === 'signed-in' ? (");
  expect(boardRoute).toContain('href={`/${locale}/boards/${id}/moderation`}');
});

test('a known post queue reads only that post scope and preserves its cursor', async () => {
  const calls: string[] = [];
  const page = await readModerationReports(
    {
      boardReports: async () => {
        throw new Error('A post queue must not enumerate its board');
      },
      threadReports: async () => {
        throw new Error('A post queue must not enumerate its thread');
      },
      postReports: async (postId, cursor) => {
        calls.push(`post:${postId}:${cursor}`);
        return { reports: [report(1, { kind: 'post', id: postId })], next: 'post-next' };
      },
    },
    { boardId: id(1), threadId: id(2), postId: id(50), cursor: 'post/current==' },
  );
  expect(calls).toEqual([`post:${id(50)}:post/current==`]);
  expect(page.next).toBe('post-next');
  expect(JSON.stringify(page)).not.toContain('private-reporter');
});

test('appeal context remains readable while missing or denied current authority hides resolution controls', async () => {
  const { ModerationAppealsView } = await import('../src/moderation/appeals-tab');
  for (const canResolve of [true, false, undefined]) {
    const markup = renderToStaticMarkup(
      createElement(ModerationAppealsView, {
        appeals: [
          {
            id: id(1),
            decisionId: id(2),
            appellantId: 'private-appellant',
            statement: 'Please review this decision.',
            createdAt: '2026-01-01T12:00:00.000Z',
            decision: { statement: 'Moderator reason.', target: { kind: 'post', id: id(50) } },
            ...(canResolve === undefined ? {} : { canResolve }),
          },
        ],
        targets: [],
        next: null,
        postId: id(50),
      }),
    );
    expect(markup).toContain('Moderator reason.');
    expect(markup).toContain('Please review this decision.');
    expect(markup).toContain(id(50));
    expect(markup).toContain(`href="?post=${id(50)}"`);
    expect(markup).not.toContain('private-appellant');
    expect(markup.includes('>Uphold</button>')).toBe(canResolve === true);
    expect(markup.includes('>Reverse</button>')).toBe(canResolve === true);
  }
});

test('a duplicate appeal resolution crosses the server boundary as a conflict rather than another success', async () => {
  const { submitModerationAppealResolution } = await import('../src/moderation/actions');
  let commands = 0;
  const result = await submitModerationAppealResolution(
    async () => {
      commands += 1;
      throw Object.assign(new Error('Already resolved'), { status: 409 });
    },
    { id: id(1), outcome: 'reverse', statement: 'Independent review.' },
  );
  expect(result).toEqual({ state: 'conflict' });
  expect(commands).toBe(1);
});

test('the report page retains board context and native continuation when its authorized page has no rows', () => {
  const markup = renderToStaticMarkup(
    createElement(ModerationReportsView, {
      boardId: id(1),
      threadId: id(2),
      postId: id(3),
      reports: [],
      targets: [],
      revisions: [],
      next: 'sealed+native/cursor==',
    }),
  );
  expect(markup).toContain('Back to board');
  expect(markup).toContain(`/boards/${id(1)}`);
  expect(markup).toContain('Reports for this post');
  expect(markup).toContain(`?tab=appeals&amp;thread=${id(2)}&amp;post=${id(3)}`);
  expect(markup).toContain('There may be more reports on the next page.');
  expect(markup).toContain('Next page');
  expect(markup).not.toContain('sealed+native/cursor==');
  expect(markup).not.toContain('<textarea');
});

test('Default report review preserves authorized rich reported and current evidence with current context links while withheld and erased targets disclose no document or media', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationReportPage } = await import('../src/moderation/reports-read');
  const { selected, later, current } = await import('../src/stories/exact-revision/fixture');
  const { moderationEvidence } = await import('../src/moderation/target-context');
  const { exactRevisionHref } = await import('../src/threads/exact-revision-href');
  const { threadLocation } = await import('../src/threads/thread-href');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const mediaId = id(500);
  const rich: typeof selected = {
    ...selected,
    mediaIds: [mediaId, id(501)],
    body: {
      ...selected.body,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'evidence-paragraph' },
            content: [
              { type: 'text', text: 'Original evidence ', marks: [{ type: 'bold' }] },
              {
                type: 'text',
                text: 'source link',
                marks: [{ type: 'link', attrs: { href: 'https://example.com/source' } }],
              },
              { type: 'text', text: 'concealed ending', marks: [{ type: 'spoiler' }] },
            ],
          },
          {
            type: 'bulletList',
            attrs: { id: 'evidence-list' },
            content: [
              {
                type: 'listItem',
                attrs: { id: 'evidence-list-item' },
                content: [
                  {
                    type: 'paragraph',
                    attrs: { id: 'evidence-list-paragraph' },
                    content: [{ type: 'text', text: 'A list item' }],
                  },
                ],
              },
            ],
          },
          {
            type: 'blockquote',
            attrs: { id: 'evidence-quote' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'evidence-quote-paragraph' },
                content: [{ type: 'text', text: 'A quoted passage' }],
              },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { id: 'evidence-code', language: 'ts' },
            content: [{ type: 'text', text: 'const evidence = true;' }],
          },
          { type: 'image', attrs: { id: 'evidence-image', src: mediaId, alt: 'Evidence illustration' } },
          { type: 'image', attrs: { id: 'undeclared-image', src: id(502), alt: 'Undeclared illustration' } },
        ],
      },
    },
  };
  const head: typeof selected = {
    ...later,
    authorId: id(91),
    mediaIds: [mediaId],
    body: {
      ...later.body,
      doc: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'current-paragraph' },
            content: [{ type: 'text', text: 'Current admitted evidence' }],
          },
          { type: 'image', attrs: { id: 'current-image', src: mediaId, alt: 'Current illustration' } },
        ],
      },
    },
  };
  const reports = [
    { ...report(1, { kind: 'post', id: selected.id }), revisionId: selected.revisionId },
    { ...report(2, { kind: 'post', id: selected.id }), revisionId: selected.revisionId },
    ...(['withheld', 'erased'] as const).map((_, index) => ({
      ...report(index + 3, { kind: 'post' as const, id: id(510 + index) }),
      revisionId: id(520 + index),
    })),
  ];
  const calls: Request[] = [];
  const mediaInputs: string[][] = [];
  let context: 'available' | 'denied' | 'foreign' = 'available';
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const url = new URL(request.url);
        if (url.pathname === `/v1/boards/${selected.boardId}/reports`)
          return Response.json({ reports, next: 'sealed+native/cursor==' });
        if (url.pathname === `/v1/posts/${selected.id}`) return Response.json({ post: head });
        if (url.pathname === `/v1/posts/${selected.id}/revisions/${selected.revisionId}`)
          return Response.json({ post: rich });
        for (const [index, availability] of (['withheld', 'erased'] as const).entries()) {
          if (
            url.pathname === `/v1/posts/${id(510 + index)}` ||
            url.pathname === `/v1/posts/${id(510 + index)}/revisions/${id(520 + index)}`
          )
            return Response.json({
              post: {
                ...rich,
                id: id(510 + index),
                revisionId: id(520 + index),
                threadId: id(530 + index),
                authorId: id(540 + index),
                availability,
                removed: true,
                // Poisoned extras must never be serialized, rendered, or used for enrichment.
                body: {
                  ...rich.body,
                  doc: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'HIDDEN BODY' }] }],
                  },
                },
                mediaIds: [id(550 + index)],
              },
            });
        }
        if (url.pathname === `/v1/threads/${selected.threadId}`) {
          if (context === 'denied') return Response.json({ code: 'not_found' }, { status: 404 });
          return Response.json({
            thread: { ...current.thread, id: context === 'foreign' ? id(999) : selected.threadId, firstPost: head },
          });
        }
        if (url.pathname === `/v1/boards/${selected.boardId}`)
          return Response.json({
            board: { id: selected.boardId, availability: 'available', title: 'Current community board' },
          });
        if (url.pathname === '/v1/accounts')
          return Response.json({
            accounts: [
              {
                id: selected.authorId,
                kind: 'person',
                state: 'active',
                handle: 'original-author',
                displayName: 'Original author',
              },
              {
                id: head.authorId,
                kind: 'person',
                state: 'active',
                handle: 'current-author',
                displayName: 'Current author',
              },
            ],
          });
        if (url.pathname === '/v1/media/presentations') {
          mediaInputs.push(((await request.json()) as { ids: string[] }).ids);
          return Response.json({
            images: [
              {
                id: mediaId,
                containerId: selected.threadId,
                digest: 'a'.repeat(64),
                width: 640,
                height: 480,
                variants: [{ format: 'webp', width: 640, height: 480 }],
                placeholder: null,
                focalPoint: null,
                credit: null,
              },
            ],
          });
        }
        throw new Error(`Unexpected native request ${request.method} ${url.pathname}`);
      },
      { preconnect() {} },
    ),
  });
  const read = () =>
    readModerationReportPage(
      client,
      { boardId: selected.boardId, cursor: 'native/cursor==' },
      'Bearer moderator',
      id(900),
    );
  const page = await read();
  const markup = renderToStaticMarkup(createElement(ModerationReportsView, page));
  expect(page.next).toBe('sealed+native/cursor==');
  const queue = calls.find((call) => new URL(call.url).pathname.endsWith('/reports'))!;
  expect(new URL(queue.url).searchParams.get('limit')).toBe('20');
  expect(new URL(queue.url).searchParams.get('cursor')).toBe('native/cursor==');
  for (const path of [
    `/v1/posts/${selected.id}`,
    `/v1/posts/${selected.id}/revisions/${selected.revisionId}`,
    `/v1/threads/${selected.threadId}`,
    `/v1/boards/${selected.boardId}`,
    '/v1/accounts',
    '/v1/media/presentations',
  ])
    expect(calls.filter((call) => new URL(call.url).pathname === path)).toHaveLength(1);
  expect(calls.every((call) => call.headers.get('authorization') === 'Bearer moderator')).toBe(true);
  expect(mediaInputs).toEqual([[mediaId]]);
  const identities = new URL(calls.find((call) => new URL(call.url).pathname === '/v1/accounts')!.url).searchParams
    .get('ids')!
    .split(',');
  expect(identities.sort()).toEqual([selected.authorId, head.authorId].sort());
  const revision = moderationEvidence(page.revisions[0]!.value)!;
  expect(revision.post?.body).toEqual(rich.body);
  expect(revision.post?.licence).toBe(selected.licence);
  expect(revision.post?.createdAt).toBe(selected.createdAt);
  expect(revision.documentMedia.kind === 'ready' && revision.documentMedia.images instanceof Map).toBe(true);
  for (const text of [
    'Original evidence',
    'Current admitted evidence',
    'Original author',
    'Current author',
    'Current community board',
    current.thread.title!,
    'Evidence illustration',
    '<ul',
    '<blockquote',
    '<pre',
    '<code',
    'const evidence = true;',
    'data-slot="withheld"',
    'data-slot="tombstone"',
  ])
    expect(markup).toContain(text);
  expect(markup).toContain('<strong>Original evidence ');
  expect(markup).toContain('href="https://example.com/source"');
  expect(markup).toContain(m.thread_reveal_spoiler());
  expect(markup).toContain(`href="${threadLocation(getLocale(), current.thread, undefined, selected.id)}"`);
  expect(markup).toContain(
    `href="${exactRevisionHref({ postId: selected.id, revisionId: selected.revisionId }, getLocale())}"`,
  );
  expect(markup).toContain(`/media/${mediaId}`);
  expect(markup).not.toContain('<iframe');
  expect(markup).not.toContain('HIDDEN BODY');
  for (const hiddenId of [id(530), id(531), id(540), id(541), id(550), id(551)]) {
    expect(JSON.stringify(page)).not.toContain(hiddenId);
    expect(markup).not.toContain(hiddenId);
    expect(calls.some((call) => call.url.includes(hiddenId))).toBe(false);
  }
  // Optional current context is a separate authority; denial and foreign identity keep admitted revisions readable.
  for (context of ['denied', 'foreign'] as const) {
    const withoutContext = renderToStaticMarkup(createElement(ModerationReportsView, await read()));
    expect(withoutContext).toContain('Original evidence');
    expect(withoutContext).toContain('Original author');
    expect(withoutContext).not.toContain(current.thread.title!);
    expect(withoutContext).not.toContain('#post-');
    expect(withoutContext).not.toContain('Current community board');
  }
});

test('default report transport forwards every selection and exact scope with native sparse continuation', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationReportPage, moderationReportInput, reportPageIsCurrent } =
    await import('../src/moderation/reports-read');
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const path = new URL(request.url).pathname;
        if (
          ![`/v1/boards/${id(1)}/reports`, `/v1/threads/${id(2)}/reports`, `/v1/posts/${id(3)}/reports`].includes(path)
        )
          throw new Error(`Unexpected report request: ${path}`);
        return Response.json({ reports: [], next: 'native-sparse-next' });
      },
      { preconnect() {} },
    ),
  });
  for (const scope of [{}, { thread: id(2) }, { thread: id(2), post: id(3) }]) {
    const input = moderationReportInput(id(1), {
      ...scope,
      status: 'resolved',
      targetKind: 'post',
      order: 'oldest',
      cursor: 'native-current',
    });
    const page = await readModerationReportPage(client, input, 'Bearer moderator', id(900));
    expect(page.state).toBe('ready');
    expect(page.reports).toEqual([]);
    expect(page.next).toBe('native-sparse-next');
    expect(page.viewerId).toBe(id(900));
    expect(reportPageIsCurrent(page, input)).toBe(true);
    const request = calls.at(-1)!;
    expect(Object.fromEntries(new URL(request.url).searchParams)).toEqual({
      status: 'resolved',
      targetKind: 'post',
      order: 'oldest',
      limit: '20',
      cursor: 'native-current',
    });
    expect(request.headers.get('authorization')).toBe('Bearer moderator');
    expect(request.cache).toBe('no-store');
    const markup = renderToStaticMarkup(
      createElement(ModerationReportsView, {
        ...page,
        selection: { status: 'resolved', targetKind: 'post', order: 'oldest' },
      }),
    );
    expect(markup).toContain('There may be more reports on the next page.');
    expect(markup).toContain('Next page');
    expect(markup).not.toContain('native-sparse-next');
  }
  expect(calls.map((request) => new URL(request.url).pathname)).toEqual([
    `/v1/boards/${id(1)}/reports`,
    `/v1/threads/${id(2)}/reports`,
    `/v1/posts/${id(3)}/reports`,
  ]);
});

test('a late native response retires after any selector, cursor or exact scope changes', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationReportPage, moderationReportInput, reportPageIsCurrent } =
    await import('../src/moderation/reports-read');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async () => {
        await pending;
        return Response.json({ reports: [], next: 'old-generation' });
      },
      { preconnect() {} },
    ),
  });
  const original = moderationReportInput(id(1), {
    status: 'pending',
    targetKind: 'post',
    order: 'oldest',
    cursor: 'native-page',
  });
  const inFlight = readModerationReportPage(client, original, 'Bearer moderator', id(900));
  const selected = moderationReportInput(id(1), { status: 'resolved', targetKind: 'post', order: 'oldest' });
  expect(selected.cursor).toBeUndefined();
  release();
  const late = await inFlight;
  expect(reportPageIsCurrent(late, original)).toBe(true);
  for (const changed of [
    selected,
    { ...original, targetKind: 'thread' as const },
    { ...original, order: 'newest' as const },
    { ...original, cursor: undefined },
    { ...original, threadId: id(2) },
    { ...original, postId: id(3) },
    { ...original, boardId: id(4) },
  ])
    expect(reportPageIsCurrent(late, changed)).toBe(false);
});

test('default native read distinguishes stale selection, denied queue and unavailable transport without private rows', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationReportPage } = await import('../src/moderation/reports-read');
  const { m } = await import('../src/paraglide/messages.js');
  for (const [status, code, expected, message] of [
    [400, 'invalid_cursor', 'stale', m.moderation_queue_stale()],
    [409, 'stale_cursor', 'stale', m.moderation_queue_stale()],
    [404, 'not_found', 'denied', m.moderation_queue_read_denied()],
    [503, 'dependency_unavailable', 'error', m.moderation_queue_error()],
  ] as const) {
    const client = createKernelClient('https://kernel.test', {
      fetch: Object.assign(async () => Response.json({ code }, { status }), { preconnect() {} }),
    });
    const page = await readModerationReportPage(
      client,
      { boardId: id(1), cursor: 'stale' },
      'Bearer moderator',
      id(900),
    );
    expect(page.state).toBe(expected);
    expect(page.reports).toEqual([]);
    expect(page.targets).toEqual([]);
    expect(page.revisions).toEqual([]);
    expect(page.next).toBeNull();
    const markup = renderToStaticMarkup(
      createElement(ModerationReportsView, { ...page, onRestart() {}, onRetry() {} }),
    );
    expect(markup).toContain(message);
    expect(markup).not.toContain(m.moderation_reports_empty());
    expect(markup).not.toContain(m.moderation_queue_end());
  }
});

test('simultaneous default report readers keep private viewers, credentials and continuations isolated', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { readModerationReportPage } = await import('../src/moderation/reports-read');
  const received: Request[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      received.push(request);
      if (!new URL(request.url).pathname.endsWith('/reports')) throw new Error('Unexpected evidence read');
      if (request.headers.get('authorization') === 'Bearer first') {
        await gate;
        return Response.json({ reports: [], next: 'first-private-continuation' });
      }
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
    { preconnect() {} },
  );
  const input = { boardId: id(1), status: 'pending' as const, targetKind: 'post' as const, order: 'oldest' as const };
  const firstRead = readModerationReportPage(
    createKernelClient('https://kernel.test', { fetch: transport }),
    input,
    'Bearer first',
    id(900),
  );
  const second = await readModerationReportPage(
    createKernelClient('https://kernel.test', { fetch: transport }),
    input,
    'Bearer second',
    id(901),
  );
  expect(second.state).toBe('denied');
  expect(second.viewerId).toBe(id(901));
  expect(second.next).toBeNull();
  release();
  const first = await firstRead;
  expect(first.state).toBe('ready');
  expect(first.viewerId).toBe(id(900));
  expect(first.next).toBe('first-private-continuation');
  expect(second.next).toBeNull();
  expect(received.map((request) => request.headers.get('authorization'))).toEqual(['Bearer first', 'Bearer second']);
  expect(received.every((request) => request.cache === 'no-store')).toBe(true);
});

// Authored UNRUN for controller integration; this mounts the default composition and uses its native transport.
test('The default Reports queue dismisses only explicitly selected loaded pending reports through existing native commands, retaining per-item outcomes and exact uncertain retry without crossing viewer or page generations', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createKernelClient } = await import('@rezics/client');
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { readModerationReportPage } = await import('../src/moderation/reports-read');
  const { sendModerationReportAction } = await import('../src/moderation/actions');
  const { m } = await import('../src/paraglide/messages.js');
  const window = new Window({ url: 'https://site.test/en/boards/moderation' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const rows = [1, 2, 3, 4, 5].map((n) => ({
    ...report(n, { kind: 'post', id: id(50) }, n === 5 ? 'dismissed' : null),
    evidence: 'Private evidence from the loaded page',
  }));
  const recorded = createStoryRecordedKernelFetch();
  const commands: { path: string; body: string; key: string | null; authorization: string | null }[] = [];
  let mode: 'uncertain' | 'refused' | 'success' = 'uncertain';
  let hold = true;
  let release!: () => void;
  let gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    maximumActive = 0,
    refreshes = 0;
  let refreshFails = true;
  let lost = false;
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === `/v1/boards/${id(1)}/reports`)
          return Response.json({ reports: rows, next: 'bounded-next' });
        if (request.method !== 'POST') return recorded(request);
        expect(path).toMatch(/^\/v1\/reports\/[0-9a-f-]+:dismiss$/u);
        commands.push({
          path,
          body: await request.text(),
          key: request.headers.get('idempotency-key'),
          authorization: request.headers.get('authorization'),
        });
        active++;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (hold) {
            hold = false;
            await gate;
          }
          if (mode === 'refused')
            return Response.json({ code: 'forbidden', detail: 'NEVER DISCLOSE' }, { status: 403 });
          if (mode === 'uncertain' && path === `/v1/reports/${id(3)}:dismiss` && !lost) {
            lost = true;
            throw new TypeError('Failed to fetch');
          }
          return Response.json({});
        } finally {
          active--;
        }
      },
      { preconnect() {} },
    ),
  });
  const onAction = (input: Parameters<typeof sendModerationReportAction>[1]) =>
    sendModerationReportAction(client, input, 'Bearer moderator');
  let data = await readModerationReportPage(client, { boardId: id(1) }, 'Bearer moderator', id(900));
  type Props = Parameters<typeof ModerationReportsView>[0];
  let props: Props;
  const render = async (patch: Partial<Props> = {}) => {
    props = { ...props, ...patch };
    await act(async () => root.render(createElement(ModerationReportsView, props)));
  };
  const onRefresh = async () => {
    refreshes++;
    if (refreshFails) throw new Error('Refresh failed');
    data = await readModerationReportPage(client, { boardId: id(1) }, 'Bearer moderator', id(900));
    props = { ...props, ...data };
    root.render(createElement(ModerationReportsView, props));
  };
  props = { ...data, boardId: id(1), onAction, onRefresh, onNext() {} };
  const button = (name: string) => {
    const found = [...host.querySelectorAll('button')].find((element) => element.textContent === name);
    expect(found, name).toBeDefined();
    return found!;
  };
  const flush = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const click = async (name: string) => {
    await act(async () => button(name).click());
    await flush();
  };
  const select = async (number: number) => {
    const label = [...host.querySelectorAll('label')].find(
      (element) => element.textContent === m.moderation_bulk_select_report({ number }),
    );
    expect(label).toBeDefined();
    const checkbox = host.querySelector(`[id="${label!.htmlFor}"]`) as unknown as HTMLElement;
    await act(async () => checkbox.click());
  };
  const review = async (count: number) => {
    await click(m.moderation_bulk_review());
    expect(host.textContent).toContain(m.moderation_bulk_confirmation({ count }));
  };
  try {
    await render();
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(4); // Resolved row has no selection.
    await select(1);
    await select(3);
    await select(4);
    await review(3);
    await click(m.moderation_bulk_cancel());
    expect(commands).toHaveLength(0);
    await review(3);
    const confirm = button(m.moderation_bulk_confirm({ count: 3 }));
    await act(async () => {
      confirm.click();
      confirm.click();
    });
    await flush();
    expect(commands.map((command) => command.path)).toEqual([`/v1/reports/${id(1)}:dismiss`]);
    const firstCard = host.querySelector('[role="article"]')!;
    for (const element of firstCard.querySelectorAll('button')) {
      if ([m.moderation_dismiss(), m.moderation_take_down()].includes(element.textContent!))
        expect(element.disabled).toBe(true);
    }
    await act(async () => release());
    await flush();
    expect(commands.map((command) => command.path)).toEqual([
      `/v1/reports/${id(1)}:dismiss`,
      `/v1/reports/${id(3)}:dismiss`,
    ]);
    expect(host.textContent).toContain(m.moderation_bulk_dismissed());
    expect(host.textContent).toContain(m.moderation_bulk_uncertain());
    expect(host.textContent).toContain(m.moderation_bulk_unattempted());
    expect(refreshes).toBe(0);
    expect(commands[0]!.key).not.toBe(commands[1]!.key);
    await click(m.moderation_bulk_retry());
    expect(commands).toHaveLength(3);
    expect(commands[2]).toEqual(commands[1]); // Exact payload, original key and authority, no batch replay.
    expect(commands[2]!.body).toBe('{}');
    expect(commands[2]!.authorization).toBe('Bearer moderator');
    expect(maximumActive).toBe(1);
    expect(refreshes).toBe(1);
    expect(host.textContent).toContain(m.moderation_bulk_stale());
    expect(host.textContent!.split(m.moderation_bulk_dismissed())).toHaveLength(3);
    expect(host.textContent).not.toContain('Private evidence from the loaded page');
    expect(host.textContent).not.toContain('NEVER DISCLOSE');

    // A definitive native refusal stops immediately and requires a real read before a new key/intent.
    mode = 'refused';
    hold = false;
    await render({ reports: [...rows] });
    await click(m.moderation_bulk_select_loaded());
    await review(4);
    await click(m.moderation_bulk_confirm({ count: 4 }));
    expect(commands).toHaveLength(4);
    expect(host.textContent).toContain(m.moderation_bulk_forbidden());
    expect(
      [...host.querySelectorAll('[role="checkbox"]')].every(
        (element) =>
          element.hasAttribute('disabled') ||
          element.hasAttribute('data-disabled') ||
          element.getAttribute('aria-disabled') === 'true',
      ),
    ).toBe(true);
    expect(
      [...host.querySelectorAll('button')].some((element) => element.textContent === m.moderation_bulk_retry()),
    ).toBe(false);
    const refusedKey = commands[3]!.key;
    mode = 'success';
    refreshFails = false;
    await click(m.moderation_bulk_refresh());
    await select(1);
    await review(1);
    await click(m.moderation_bulk_confirm({ count: 1 }));
    expect(commands).toHaveLength(5);
    expect(commands[4]!.key).not.toBe(refusedKey);

    // Every current composition identity retires a pending batch; its late success cannot schedule row two.
    for (const change of ['viewer', 'scope', 'selectors', 'page', 'loading', 'next', 'tab'] as const) {
      await render({
        ...data,
        reports: [...rows],
        boardId: id(1),
        viewerId: id(900),
        tab: 'reports',
        state: 'ready',
        selection: { status: 'all', targetKind: 'all', order: 'newest' },
      });
      hold = true;
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await click(m.moderation_bulk_select_loaded());
      await review(4);
      const before = commands.length;
      await click(m.moderation_bulk_confirm({ count: 4 }));
      expect(commands).toHaveLength(before + 1);
      if (change === 'viewer') await render({ viewerId: id(901), reports: [] });
      if (change === 'scope') await render({ postId: id(99), reports: [] });
      if (change === 'selectors')
        await render({ selection: { status: 'pending', targetKind: 'post', order: 'oldest' }, reports: [] });
      if (change === 'page') await render({ reports: [], next: 'new-page' });
      if (change === 'loading') await render({ state: 'loading' });
      if (change === 'next') await click(m.threads_next_page());
      if (change === 'tab') await render({ tab: 'appeals' });
      await act(async () => release());
      await flush();
      expect(commands).toHaveLength(before + 1);
      expect(host.textContent).not.toContain(m.moderation_bulk_dismissed());
      expect(host.textContent).not.toContain(m.moderation_bulk_results());
      expect(host.textContent).not.toContain(m.moderation_bulk_uncertain());
      if (change === 'tab') expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(0);
    }
    await render({
      state: 'ready',
      tab: 'reports',
      reports: Array.from({ length: 25 }, (_, index) => ({ ...rows[0]!, id: id(100 + index) })),
    });
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(20);
    await click(m.moderation_bulk_select_loaded());
    expect(host.textContent).toContain(m.moderation_bulk_selected({ count: 20 }));
    expect(
      commands.some(
        (command) =>
          command.path === `/v1/reports/${id(2)}:dismiss` ||
          command.path === `/v1/reports/${id(4)}:dismiss` ||
          command.path === `/v1/reports/${id(5)}:dismiss`,
      ),
    ).toBe(false);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 30_000);
