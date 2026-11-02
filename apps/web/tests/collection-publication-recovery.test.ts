import { expect, test } from 'bun:test';
import { publicationReview } from '../src/library/collection-publication-review';
import { publicationExample } from '../src/kernel/fake/collection-publication';

test('the private publication review copies only selected public metadata in native canonical order', () => {
  if (publicationExample.source.state !== 'ready') throw new Error('Expected recorded source');
  const source = publicationExample.source;
  const subject = source.page.members[0]!.subject!;
  const label = { value: 'Selected subject', language: 'en' };
  const page = {
    ...source.page,
    title: 'Original title',
    description: 'Original description',
    members: [
      { subjectId: 'raw-z', subject: { ...subject, id: 'z', label }, facts: [] },
      { subjectId: 'alias-z', subject: { ...subject, id: 'z', label: 'Duplicate alias' } },
      { subjectId: 'raw-a', subject: { ...subject, id: 'a', label: 'First' } },
      { subjectId: 'hidden', subject: null },
    ],
  };
  const review = publicationReview(page, 7, ['z', 'a']);
  page.title = 'New draft';
  label.value = 'New subject label';
  expect(review).toEqual({
    title: 'Original title',
    description: 'Original description',
    revision: 7,
    subjects: [
      { id: 'a', label: 'First' },
      { id: 'z', label: { value: 'Selected subject', language: 'en' } },
    ],
  });
  expect(publicationReview(page, 7, []).subjects).toEqual([]);
});
