import { expect, test } from 'bun:test';
import { currentHistoryEnvelope, mount, m, selected } from './support/post-history-current';

test('failed Subject presentation keeps recorded target IDs; only an empty recorded list is absent', async () => {
  for (const subjectIds of [selected.subjectIds, []]) {
    const envelope = currentHistoryEnvelope();
    envelope.revisions[0]!.subjectIds = subjectIds;
    envelope.page.subjects.state = 'unavailable';
    envelope.page.retry = { state: 'same_cursor', cursor: null };
    const view = await mount(envelope);
    try {
      await view.open();
      await view.inspect();
      const recorded = view.host.querySelector(`[aria-label="${m.post_history_recorded_context()}"]`)!;
      expect(recorded.textContent).not.toContain('Merged terminal book');
      expect(recorded.textContent).not.toContain(m.post_history_target_concealed());
      expect(recorded.textContent).toContain(
        subjectIds.length ? m.post_history_targets_failed() : m.post_history_targets_absent(),
      );
      for (const id of subjectIds) expect(recorded.textContent).toContain(m.post_history_original_target({ id }));
      if (subjectIds.length) expect(recorded.textContent).not.toContain(m.post_history_targets_absent());
    } finally {
      await view.dispose();
    }
  }
});
