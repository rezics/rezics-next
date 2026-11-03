import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { loadPostHistoryPage } from '../src/threads/post-history-read';
import { currentHistoryEnvelope, mount, runtime, m, selected } from './support/post-history-current';

test('generated native envelopes at 1/20/100 require one history request and no duplicate hydration', async () => {
  for (const count of [1, 20, 100]) {
    const envelope = currentHistoryEnvelope(count);
    let calls = 0;
    const client = createKernelClient('https://kernel.test', {
      fetch: async () => {
        calls++;
        return Response.json(envelope);
      },
    });
    const result = await loadPostHistoryPage(
      client,
      { postId: selected.id },
      { authorization: null, subject: undefined },
    );
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('Expected admitted page');
    expect(result.revisions).toEqual(envelope.revisions);
    expect(result.context).toEqual(envelope.page);
    expect(calls).toBe(1);
  }
});

test('mounted discussion, reply and review expose admitted context and exact revision associations', async () => {
  for (const kind of ['discussion', 'reply', 'review'] as const) {
    const view = await mount(currentHistoryEnvelope(2, kind));
    try {
      expect(view.host.textContent).not.toContain('Admitted conversation');
      await view.open();
      expect(view.host.textContent).toContain('Admitted conversation');
      expect(view.host.textContent).toContain('Admitted Board');
      expect(view.host.textContent).toContain('Current author presentation');
      expect(view.host.textContent).toContain(m.prq_global());
      expect(runtime.calls).toHaveLength(1);
      await view.inspect(2);
      const inspector = view.host.querySelector('[data-history-inspector]')!;
      expect(inspector.textContent).toContain(runtime.envelope.revisions[1]!.revisionId);
      expect(inspector.textContent).toContain(selected.subjectIds[0]!);
      expect(inspector.textContent).toContain('Merged terminal book');
      if (kind === 'review') {
        expect(inspector.textContent).toContain('Recorded rating question');
        expect(inspector.textContent).toContain(m.post_history_scale_value({ min: '0', max: '20', step: '1' }));
        expect(inspector.textContent).toContain(m.post_history_question_retired());
        const recorded = inspector.querySelector(`[aria-label="${m.post_history_recorded_context()}"]`)!;
        expect(recorded.querySelector('dd')?.textContent).toBe('0');
        expect(recorded.textContent).toContain(`${selected.voteCitation!.questionId} / 2`);
      }
      expect(view.host.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
    } finally {
      await view.dispose();
    }
  }
});

test('concealed authors and targets differ from absent and failed context; failure retries the same cursor', async () => {
  const envelope = currentHistoryEnvelope();
  envelope.next = 'next-address';
  envelope.page.authors.items = [{ id: selected.authorId, state: 'concealed' }];
  envelope.page.subjects.items = [{ id: selected.subjectIds[0]!, state: 'concealed', summary: null }];
  envelope.page.reviewScores = {
    state: 'unavailable',
    retryable: true,
    items: [{ revisionId: envelope.revisions[0]!.revisionId, state: 'unavailable', citation: null, question: null }],
  };
  envelope.revisions[0]!.voteCitation = null;
  envelope.page.retry = { state: 'same_cursor', cursor: null };
  const view = await mount(envelope);
  try {
    await view.open();
    await view.inspect();
    expect(view.host.textContent).toContain(m.post_history_author_concealed());
    expect(view.host.textContent).toContain(m.post_history_target_concealed());
    expect(view.host.textContent).toContain(m.post_history_score_failed());
    expect(view.host.textContent).not.toContain(m.thread_provenance_unscored());
    const { click, control } = await import('./support/post-history-current');
    await click(control(view.host, m.exact_revision_retry()));
    expect(runtime.calls).toHaveLength(2);
    expect(runtime.calls[1]!.url).toBe(runtime.calls[0]!.url);
  } finally {
    await view.dispose();
  }
});

test('a bounded summary omission withholds presentation while an empty recorded target list is absent', async () => {
  for (const subjectIds of [[], selected.subjectIds]) {
    const envelope = currentHistoryEnvelope();
    envelope.revisions[0]!.subjectIds = subjectIds;
    envelope.page.subjects.items = [];
    const view = await mount(envelope);
    try {
      await view.open();
      await view.inspect();
      expect(view.host.textContent).toContain(
        subjectIds.length ? m.post_history_target_concealed() : m.post_history_targets_absent(),
      );
      if (subjectIds.length) expect(view.host.textContent).not.toContain(m.post_history_targets_absent());
    } finally {
      await view.dispose();
    }
  }
});
