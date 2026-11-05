import { expect, test } from 'bun:test';
import {
  progressStartDraftChanged,
  progressStartDraftNavigationContext,
  type ProgressStartDraft,
} from '../src/library/progress-start-draft-navigation';

const loaded: ProgressStartDraft = {
  subjectId: 'subject-a',
  versionSubjectId: '',
  mode: 'scalar_amount',
  unit: 'pages',
  total: '',
};

test('Progress setup compares its selected fields and exact total text with the loaded baseline', () => {
  expect(progressStartDraftChanged(loaded, { ...loaded, subjectId: 'subject-b' })).toBe(true);
  expect(progressStartDraftChanged(loaded, { ...loaded, versionSubjectId: 'version-a' })).toBe(true);
  expect(progressStartDraftChanged(loaded, { ...loaded, mode: 'cursor_position' })).toBe(true);
  expect(progressStartDraftChanged(loaded, { ...loaded, unit: 'chapters' })).toBe(true);
  expect(progressStartDraftChanged(loaded, { ...loaded, total: '1.2' })).toBe(true);
  expect(progressStartDraftChanged(loaded, { ...loaded, total: '' })).toBe(false);
});

test('Progress departure context notices pagination but ignores search key ordering', () => {
  const base = { pathname: '/library/progress', search: { subjectId: 'subject-a', cursor: 'next' } };
  expect(progressStartDraftNavigationContext(base)).toBe(
    progressStartDraftNavigationContext({
      pathname: base.pathname,
      search: { cursor: 'next', subjectId: 'subject-a' },
    }),
  );
  expect(progressStartDraftNavigationContext(base)).not.toBe(
    progressStartDraftNavigationContext({ pathname: base.pathname, search: { subjectId: 'subject-a' } }),
  );
});
