import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import collection from '../src/kernel/recorded/library-collection.json';
import members from '../src/kernel/recorded/library-collection-members.json';
import { captureBulkOccurrenceRemove } from '../src/library/bulk-occurrence-remove';
import { BulkOccurrenceRemoveReview } from '../src/library/bulk-occurrence-remove-review';

test('captures two selected occurrences of one Subject, retaining source and selection order without deletion', () => {
  const first = members.members[0]!;
  const second = { ...members.members[1]!, subject: first.subject, subjectId: first.subject.id };
  const source = { ...collection.collection };
  const loaded = [first, second];
  const before = JSON.stringify(loaded);
  const capture = captureBulkOccurrenceRemove(source, loaded, new Set([second.id, first.id]));
  expect(JSON.stringify(loaded)).toBe(before);
  if (!capture.ok) throw new Error('Expected an exact occurrence capture');
  expect(capture.targets).toEqual([
    { memberId: second.id, subjectId: first.subject.id },
    { memberId: first.id, subjectId: first.subject.id },
  ]);
  const review = renderToStaticMarkup(<BulkOccurrenceRemoveReview capture={capture} />);
  expect(review).toContain(first.id);
  expect(review).toContain(second.id);
  expect(review).toContain(source.id);
  expect(review).not.toContain('<button');
  source.id = 'later-source';
  source.title = 'Later title';
  loaded.reverse();
  expect(capture.source).toEqual({ id: collection.collection.id, title: collection.collection.title });
  expect(Object.isFrozen(capture.targets[0])).toBe(true);
  expect(Object.isFrozen(capture.targets)).toBe(true);
  expect(Object.isFrozen(capture.source)).toBe(true);
});

test('never adds an unselected duplicate or silently drops an unavailable selected occurrence', () => {
  const first = members.members[0]!;
  const duplicate = { ...first, id: members.members[1]!.id };
  const capture = captureBulkOccurrenceRemove(collection.collection, [first, duplicate], new Set([first.id]));
  expect(capture.ok && capture.targets.map((target) => target.memberId)).toEqual([first.id]);
  for (const loaded of [[], [{ ...first, subject: null }], [{ ...first, subjectId: 'different' }], [first, first]]) {
    expect(captureBulkOccurrenceRemove(collection.collection, loaded, new Set([first.id]))).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  }
  expect(captureBulkOccurrenceRemove(collection.collection, [first], new Set())).toEqual({
    ok: false,
    reason: 'empty',
  });
  expect(
    captureBulkOccurrenceRemove(collection.collection, [], new Set(Array.from({ length: 1001 }, (_, i) => `${i}`))),
  ).toEqual({ ok: false, reason: 'limit' });
});
