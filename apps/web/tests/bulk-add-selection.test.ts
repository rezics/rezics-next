import { expect, test } from 'bun:test';
import members from '../src/kernel/recorded/library-collection-members.json';
import collection from '../src/kernel/recorded/library-collection.json';
import { captureBulkAddSelection, captureBulkAddDestination } from '../src/library/bulk-add-selection';

test('captures only loaded canonical subjects in first-selection order without changing members', () => {
  const before = JSON.stringify(members);
  const [first, second] = members.members;
  if (!first || !second) throw new Error('Missing loaded member fixtures');
  const capture = captureBulkAddSelection([second, first, second]);
  expect(capture).toEqual({ ok: true, subjects: [second.subject.id, first.subject.id] });
  expect(JSON.stringify(members)).toBe(before);
  if (!capture.ok) throw new Error('Expected loaded selection');
  expect(Object.isFrozen(capture.subjects)).toBe(true);
});

test('a chosen destination and selection are detached from later list and selection changes', () => {
  const loaded = [...members.members];
  const selection = captureBulkAddSelection(loaded);
  if (!selection.ok) throw new Error('Expected loaded selection');
  const destination = { ...collection.collection };
  const capture = captureBulkAddDestination(selection, destination);
  loaded.reverse();
  destination.id = 'replacement';
  destination.title = 'Refreshed title';
  destination.revision++;
  expect(capture.destination).toEqual({
    id: collection.collection.id,
    title: collection.collection.title,
    revision: collection.collection.revision,
  });
  expect(capture.subjects).toEqual(members.members.map((member) => member.subject.id));
  expect(Object.isFrozen(capture.destination)).toBe(true);
  expect(Object.isFrozen(capture)).toBe(true);
});

test('refuses the whole capture for an unavailable or mismatched subject or an oversized selection', () => {
  const first = members.members[0]!;
  expect(captureBulkAddSelection([])).toEqual({ ok: false, reason: 'empty' });
  expect(captureBulkAddSelection([first, { subject: null }])).toEqual({ ok: false, reason: 'unavailable' });
  expect(captureBulkAddSelection([{ ...first, subjectId: 'different' }])).toEqual({ ok: false, reason: 'unavailable' });
  expect(
    captureBulkAddSelection(Array.from({ length: 1001 }, (_, i) => ({ subject: { id: `subject-${i}` } }))),
  ).toEqual({ ok: false, reason: 'limit' });
});
