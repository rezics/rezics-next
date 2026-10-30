import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Report } from '../src/moderation/reports-read';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { resolveReportedRevisions } = await import('../src/moderation/reports-read');
const { reportDecisionReason, takeDownReport } = await import('../src/moderation/actions');
const { BoardReportQueue } = await import('../src/stories/patterns/board-report-queue/board-report-queue');
const report: Report = {
  id: 'report',
  target: { kind: 'post', id: 'known-post' },
  revisionId: 'original-revision',
  reason: 'other',
  evidence: 'Submitted evidence text',
  createdAt: '2026-10-30T12:00:00.000Z',
  outcome: null,
  resolvedAt: null,
};

test('edited targets show original reported content separately and submit one reason within the native cap', async () => {
  const calls: string[][] = [];
  const revisions = await resolveReportedRevisions([report, { ...report, id: 'duplicate' }], async (...ids) => {
    calls.push(ids);
    return { post: { body: 'Original readable revision' } };
  });
  expect(calls).toEqual([['known-post', 'original-revision']]);
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [report],
      revisions,
      targets: [{ key: 'post:known-post', kind: 'post', value: { post: { body: 'Readable current target' } } }],
      onAction: async () => {},
    }),
  );
  expect(markup).toContain('Original readable revision');
  expect(markup).toContain('Readable current target');
  expect(markup).toContain('Submitted evidence text');
  expect(markup.match(/<textarea/g)).toHaveLength(1);
  expect(markup).toContain('maxLength="1024"');
  const commands: unknown[] = [];
  await takeDownReport(
    async (path, body) => {
      commands.push({ path, body });
    },
    {
      reportId: report.id,
      targetKind: 'post',
      targetId: 'known-post',
      reason: 'R'.repeat(1024),
    },
  );
  expect(commands).toEqual([{ path: '/v1/posts/known-post:takeDown', body: { reason: 'R'.repeat(1024) } }]);
  expect(() => reportDecisionReason('R'.repeat(1025))).toThrow();
  expect(() => reportDecisionReason('   ')).toThrow();
});

test('unknown post identity and refused exact revision stay neutrally unavailable', async () => {
  const calls: string[] = [];
  const reports: Report[] = [report, { ...report, id: 'thread-report', target: { kind: 'thread', id: 'thread' } }];
  const revisions = await resolveReportedRevisions(reports, async (postId) => {
    calls.push(postId);
    throw new Error('Not found');
  });
  expect(calls).toEqual(['known-post']);
  expect(revisions).toEqual(reports.map(({ id }) => ({ reportId: id, value: null })));
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports,
      revisions,
      targets: [],
      onAction: async () => {},
    }),
  );
  expect(markup).not.toContain('original-revision');
  expect(markup).not.toContain('href=');
  expect(markup).not.toContain('Original readable revision');
});

test('review cards keep submitted evidence and native resolution times separate from readable content', () => {
  const markup = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [{ ...report, outcome: 'dismissed', resolvedAt: '2026-10-31T09:00:00.000Z' }],
      revisions: [{ reportId: report.id, value: { post: { availability: 'unavailable', body: 'Private revision' } } }],
      targets: [{ key: 'post:known-post', kind: 'post', value: { post: { removed: true, body: 'Removed body' } } }],
      onAction: async () => {},
    }),
  );
  expect(markup).toContain('Submitted evidence text');
  expect(markup).toContain('Submitted report');
  expect(markup).toContain('Reported revision');
  expect(markup).toContain('Current target');
  expect(markup).toContain('Dismissed');
  expect(markup).toContain('dateTime="2026-10-31T09:00:00.000Z"');
  expect(markup).not.toContain('Private revision');
  expect(markup).not.toContain('Removed body');
  expect(markup).not.toContain('original-revision');
  expect(markup).not.toContain('<textarea');
});

test('an empty native page keeps continuation while preparation states disclose no report details', () => {
  const empty = renderToStaticMarkup(
    createElement(BoardReportQueue, {
      reports: [],
      targets: [],
      revisions: [],
      next: 'sealed+continuation==',
      onAction: async () => {},
    }),
  );
  expect(empty).toContain('Next page');
  expect(empty).toContain('There may be more reports on the next page.');
  expect(empty).not.toContain('sealed+continuation==');
  for (const state of ['loading', 'error'] as const) {
    const markup = renderToStaticMarkup(
      createElement(BoardReportQueue, {
        reports: [report],
        targets: [],
        next: 'sealed+continuation==',
        state,
        onAction: async () => {},
      }),
    );
    expect(markup).not.toContain(report.evidence!);
    expect(markup).not.toContain('Next page');
    expect(markup).not.toContain('<textarea');
  }
});

test('real stale conflict requires current-state recovery, keeps the reason and gives a reviewed decision a new key', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { sendModerationReportAction } = await import('../src/moderation/actions');
  const { createReportReviewAction } = await import('../src/moderation/reports-view-action');
  const { reportActionResult } = await import('../src/moderation/report-actions');
  for (const [status, code] of [
    [409, 'conflict'],
    [422, 'idempotency_conflict'],
  ] as const) {
    const requests: { key: string | null; body: unknown; url: string }[] = [];
    const client = createKernelClient('https://kernel.invalid', {
      fetch: async (url, init) => {
        requests.push({
          key: new Headers(init?.headers).get('idempotency-key'),
          body: JSON.parse(String(init?.body)),
          url: String(url),
        });
        return requests.length === 1
          ? Response.json({ code, detail: 'Hidden target and denial details' }, { status })
          : Response.json({ securityRevision: 'current', reportId: report.id, outcome: 'dismissed' });
      },
    });
    const review = createReportReviewAction();
    const draft = '  Preserve the entered moderator reason.  ';
    const intent = {
      action: 'take-down' as const,
      reportId: report.id,
      targetKind: 'post' as const,
      targetId: report.target.id,
      reason: reportDecisionReason(draft),
    };
    const action = (input: import('../src/moderation/actions').ReportActionInput) =>
      sendModerationReportAction(client, input, 'Bearer moderator');
    const stale = status === 409 ? { action: 'dismiss' as const, reportId: report.id } : intent;
    expect(await review.submit(stale, action)).toEqual({ ok: false, state: 'conflict' });
    expect(JSON.stringify(await review.retry(action))).not.toContain('Hidden target');
    review.changed();
    await review.submit(intent, action);
    expect(requests).toHaveLength(1);
    // A failed reread cannot unlock a stale command.
    await expect(
      review.refresh(async () => {
        throw new Error('Read unavailable');
      }),
    ).rejects.toThrow('Read unavailable');
    await review.submit(intent, action);
    expect(requests).toHaveLength(1);
    let reads = 0;
    await review.refresh(async () => {
      reads += 1;
    });
    expect(reads).toBe(1);
    expect(requests).toHaveLength(1);
    expect(draft).toBe('  Preserve the entered moderator reason.  ');
    const current = status === 409 ? stale : { ...intent, targetId: 'current-target' };
    expect(await review.submit(current, action)).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.key).not.toBe(requests[0]!.key);
    if (status === 422) {
      expect(requests[1]!.url).toContain('/posts/current-target:takeDown');
      expect(requests[1]!.body).toEqual({ reason: draft.trim() });
    }
    await review.submit(current, action);
    expect(requests).toHaveLength(2);
  }
  expect(reportActionResult(412, { code: 'precondition_failed' })).toEqual({ ok: false, state: 'conflict' });
  expect(() => reportActionResult(422, { code: 'too_many_events' })).toThrow();
});

test('native denied outcomes differ from uncertain transport retry with the exact intent, key and reason preserved', async () => {
  const { createKernelClient } = await import('@rezics/client');
  const { sendModerationReportAction } = await import('../src/moderation/actions');
  const { createReportReviewAction } = await import('../src/moderation/reports-view-action');
  const intent = {
    action: 'take-down' as const,
    reportId: report.id,
    targetKind: 'post' as const,
    targetId: report.target.id,
    reason: 'Preserved reason.',
  };
  for (const [status, state] of [
    [403, 'forbidden'],
    [401, 'sign-in'],
    [404, 'unavailable'],
    [503, 'error'],
  ] as const) {
    let writes = 0;
    const client = createKernelClient('https://kernel.invalid', {
      fetch: async () => {
        writes += 1;
        return Response.json({ code: 'private', detail: 'Hidden denial internals' }, { status });
      },
    });
    const review = createReportReviewAction();
    const action = (input: import('../src/moderation/actions').ReportActionInput) =>
      sendModerationReportAction(client, input, 'Bearer moderator');
    expect(await review.submit(intent, action)).toEqual({ ok: false, state });
    await review.retry(action);
    await review.submit({ ...intent, reason: 'Edited reason.' }, action);
    expect(writes).toBe(1);
    expect(review.input?.action === 'take-down' && review.input.reason).toBe(intent.reason);
    await review.refresh(async () => {});
    expect(writes).toBe(1);
    expect(await review.submit(intent, action)).toEqual({ ok: false, state });
    expect(writes).toBe(2);
  }
  const requests: import('../src/moderation/actions').ReportActionInput[] = [];
  const review = createReportReviewAction();
  const action = async (input: import('../src/moderation/actions').ReportActionInput) => {
    requests.push(input);
    if (requests.length === 1) throw new TypeError('Failed to fetch');
    return { ok: true as const };
  };
  expect(await review.submit(intent, action)).toEqual({ ok: false, state: 'uncertain' });
  review.changed();
  await review.submit({ ...intent, reason: 'A different decision must wait.' }, action);
  expect(requests).toHaveLength(1);
  expect(await review.retry(action)).toEqual({ ok: true });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[1]).toMatchObject(intent);
  await review.retry(action);
  await review.submit(intent, action);
  expect(requests).toHaveLength(2);
  const unknown = createReportReviewAction();
  expect(
    await unknown.submit(intent, async () => {
      throw new Error('Unknown source failure');
    }),
  ).toEqual({ ok: false, state: 'error' });
  expect(await createReportReviewAction().submit(intent, async () => {})).toEqual({ ok: false, state: 'error' });
});
