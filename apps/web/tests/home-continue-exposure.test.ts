import { expect, test } from 'bun:test';
import { homeFeedViewer } from '../src/features/pages/home-feed-read';
import { operationGroups, operationIsAdmitted } from '../src/kernel/exposure';

test('Signed-in Home admits its existing Continue read only through actual native personal-library and reading-progress groups rather than a fictional operation flag while preserving all unknown closed and private read boundaries', async () => {
  const feed = await Bun.file(new URL('../../../services/kernel/src/content/feed.ts', import.meta.url)).text();
  const native = await Bun.file(
    new URL('../../../services/kernel/src/library/continue-routes.ts', import.meta.url),
  ).text();
  expect(native).toContain("'x-exposure': 'gate:personal_library'");
  expect(native).toContain("group: 'reading_progress'");
  expect(operationGroups['library_continue.list']).toBe('personal_library');
  expect(operationGroups['progress_session.list']).toBe('reading_progress');
  for (const operation of ['library_label.list', 'library_entry.restore'] as const)
    expect(operationIsAdmitted(operation, ['personal_library', 'reading_progress'])).toBe(false);

  // Home now delegates lane admission to the native mixed producer. Readiness still comes from session authority.
  expect(feed).toContain("group: 'personal_library'");
  expect(feed).toContain("group: 'reading_progress'");
  expect(feed).toContain("clientAction: 'library_entry:list'");
  expect(feed).toContain("clientAction: 'progress_session:list'");
  for (const state of ['unknown', 'signed-out', 'unavailable', 'signed-in']) {
    for (const subject of [undefined, null, 'viewer']) {
      for (const csrfToken of [null, 'csrf']) {
        expect(homeFeedViewer({ state, subject, csrfToken }) !== null).toBe(
          state === 'signed-in' && Boolean(subject) && Boolean(csrfToken),
        );
      }
    }
  }
});
