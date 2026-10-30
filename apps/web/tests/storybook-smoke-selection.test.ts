import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  selectSmokeStories,
  type CopyRecording,
  type SmokeStoryEntry,
  type SmokeStoryIndex,
} from '../scripts/storybook-smoke.ts';

const app = resolve(import.meta.dir, '..');

function readRecording<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(app, 'src/kernel/recorded', name), 'utf8')) as T;
}

function story(id: string, title: string, name: string): SmokeStoryEntry {
  return { id, title, name, type: 'story' };
}

const webIndex: SmokeStoryIndex = {
  entries: Object.fromEntries(
    [
      story('pages-subjects-subject--count-unavailable', 'Pages/Subjects/Subject', 'Count Unavailable'),
      story('pages-subjects-subject--signed-in', 'Pages/Subjects/Subject', 'Member'),
      story('pages-library-copies--none', 'Pages/Library/Copies', 'None'),
      story('pages-library-copies--many-copies', 'Pages/Library/Copies', 'Owner'),
      story('patterns-account-shell--signed-out', 'Patterns/Account/Shell', 'Signed out, account menu open'),
      story(
        'patterns-account-shell--member-account-menu-open',
        'Patterns/Account/Shell',
        'Member, account menu open',
      ),
    ].map((entry) => [entry.id, entry] as const),
  ),
};
const uiIndex: SmokeStoryIndex = {
  entries: {
    'components-cover-card--default': story('components-cover-card--default', 'Components/Cover Card', 'Default'),
  },
};

test('selects named full-page stories for the null-cover subject and recorded-cover copy', () => {
  const subjectPage = readRecording<{
    reads: { r0?: { body?: { summary?: { cover?: unknown } | null } } };
  }>('subject-page.json');
  const copyRecording = readRecording<CopyRecording>('library-copies.json');
  const stories = selectSmokeStories(webIndex, uiIndex, copyRecording);

  expect(subjectPage.reads.r0?.body?.summary?.cover).toBeNull();
  expect(stories.shell.id).toBe('patterns-account-shell--signed-out');
  expect(stories.signedInShell.id).toBe('patterns-account-shell--member-account-menu-open');
  expect(stories.uiCoverCard.id).toBe('components-cover-card--default');
  expect(stories.subject.id).toBe('pages-subjects-subject--signed-in');
  expect(stories.copies.id).toBe('pages-library-copies--many-copies');
  expect(stories.coverMedia).toBe(copyRecording.copies?.[1]?.subject?.cover?.media);
});

test('requires a recorded covered member for the positive media scenario', () => {
  const noCoverRecording: CopyRecording = { copies: [{ subject: { cover: null } }] };
  expect(() => selectSmokeStories(webIndex, uiIndex, noCoverRecording)).toThrow(
    'The recorded second Library Copies member has no cover media.',
  );
});
