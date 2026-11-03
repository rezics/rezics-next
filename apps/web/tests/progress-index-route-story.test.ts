import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import sessionsRecording from '../src/kernel/recorded/library-progress-sessions.json';
import {
  libraryProgressStoryLongSubjectLabel,
  libraryProgressStoryNextCursor,
  libraryProgressStoryRequestCursor,
  routes,
  setLibraryProgressStoryMode,
} from '../src/kernel/fake/library-progress-story';

test('the routed Progress story uses constructed response examples without changing stored or private identity', async () => {
  const list = routes.find((route) => route.method === 'GET' && route.path === '/v1/progressSessions')!;
  const address = new URL('https://kernel.test/v1/progressSessions');
  address.searchParams.set('subjectId', sessionsRecording.progressSessions[0]!.subjectId);
  address.searchParams.set('cursor', libraryProgressStoryRequestCursor);
  setLibraryProgressStoryMode('constructed-unknown-identity');
  try {
    const response = (await list.story!({ request: new Request(address), recordings: {}, match: null })) as unknown as {
      progressSessions: typeof sessionsRecording.progressSessions;
      next: string;
    };
    const rows = response.progressSessions;
    expect([address.searchParams.get('subjectId'), address.searchParams.get('cursor')]).toEqual([
      sessionsRecording.progressSessions[0]!.subjectId,
      libraryProgressStoryRequestCursor,
    ]);
    expect(response.next).toBe(libraryProgressStoryNextCursor);
    expect(
      rows.map(({ subjectId, mode, unit, amount, position, locator }) => [
        subjectId,
        mode,
        unit,
        amount,
        position,
        locator,
      ]),
    ).toEqual(
      sessionsRecording.progressSessions.map(({ subjectId, mode, unit, amount, position, locator }) => [
        subjectId,
        mode,
        unit,
        amount,
        position,
        locator,
      ]),
    );
    expect(rows.map((row) => row.subject?.id ?? null)).toEqual(
      sessionsRecording.progressSessions.map((row) => row.subject?.id ?? null),
    );
    expect(rows.every((row) => !('unitLabel' in row))).toBe(true);
    const label = sessionsRecording.progressSessions[0]!.subject!.label;
    const suppliedLabel = typeof label === 'string' ? label : label.value;
    expect(rows[0]!.subject?.label).toBe(libraryProgressStoryLongSubjectLabel);
    expect(libraryProgressStoryLongSubjectLabel).toBe(
      `${suppliedLabel} — ${suppliedLabel} — ${suppliedLabel} — ${suppliedLabel}`,
    );
  } finally {
    setLibraryProgressStoryMode('recorded');
  }

  const source = readFileSync(new URL('../src/stories/library-progress.stories.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('export const UnknownUnitConstructedIdentityIndex: Story');
  const end = source.indexOf('export const LongContent: Story', start);
  const routeStory = source.slice(start, end);
  expect(source).toMatch(/function ProgressStory[\s\S]*?return <PageStory visitor="Signed In" path=\{path\} \/>;/);
  expect(routeStory).toContain("'constructed-unknown-identity'");
  expect(routeStory).toContain('m.library_progress_index_reader_history_unavailable()');
  expect(routeStory).toContain('m.library_progress_more()');
  expect(routeStory).toContain('libraryProgressStoryNextCursor');
  expect(routeStory).not.toMatch(/PatternStory|readProgressIndex/);
});
