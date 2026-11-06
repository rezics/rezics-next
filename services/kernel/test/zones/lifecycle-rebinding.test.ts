import { expect, test } from 'bun:test';
import { ProblemError } from '../../src/http/problem.ts';
import type { ZoneHead } from '../../src/zones/resource-store.ts';
import { liveCoverage, retainCoveredPayload } from '../../src/zones/cleanup-intent.ts';
import { changeTakedown, rebindWithholding, withholdingJson, withholdingOf } from '../../src/zones/takedown.ts';

const doc = (text: string) => ({
  root: { props: { appearance: { radius: 1 } } },
  content: [{ type: 'Text', props: { id: 'node-1', text } }],
});
const configuration = (pages: { route: string; document: unknown }[]) =>
  ({ labels: { en: 'Zone' }, scope: [], pages }) as never;
const head = (revision: string, pages: { route: string; document: unknown }[], withholding: unknown = {}) =>
  ({ revision, configuration: configuration(pages), mounts: [], withholding }) as unknown as ZoneHead;

const front = { route: '', document: doc('front') };
const notes = { route: 'notes', document: doc('notes') };

/** A revision-3 Zone whose notes page is covered at its exact pointer. */
function covered() {
  const base = head('2', [front, notes]);
  return head('3', [front, notes], withholdingJson(changeTakedown(base, ['/pages/1/document'], true, '3')));
}

test('a reordered covered page keeps its decision on the same element and retains no original', () => {
  const next = rebindWithholding(covered(), configuration([notes, front]), [], '4');
  expect(Object.keys(next.decisions)).toEqual(['/pages/0/document']);
  expect(next.decisions['/pages/0/document']!.version).toBe('4');
  expect(next.custody).toEqual([]);
});

test('an edit to a covered page keeps the decision and retains the superseded original with its locator', () => {
  const edited = { route: 'notes', document: doc('replaced') };
  const next = rebindWithholding(covered(), configuration([front, edited]), [], '4');
  expect(Object.keys(next.decisions)).toEqual(['/pages/1/document']);
  expect(next.custody).toEqual([
    expect.objectContaining({ pointer: '/pages/1/document', version: '3', original: notes.document }),
  ]);
});

test('removing a covered page retains its original and leaves no live decision that could hide another page', () => {
  const next = rebindWithholding(covered(), configuration([front]), [], '4');
  expect(next.decisions).toEqual({});
  expect(next.custody).toEqual([
    expect.objectContaining({ pointer: '/pages/1/document', version: '3', original: notes.document }),
  ]);
  const shown = withholdingJson(next);
  if (shown === null || typeof shown !== 'object' || Array.isArray(shown))
    throw new Error('withholding JSON must be an object');
  expect(Object.keys(shown)).toEqual(['custody']);
  expect(withholdingOf(shown).decisions).toEqual({});
});

test('a named release removes only a live decision and refuses one that is not held', () => {
  const held = covered();
  expect(withholdingJson(changeTakedown(held, ['/pages/1/document'], false, '4'))).toEqual({});
  expect(() => changeTakedown(held, ['/labels/en'], false, '4')).toThrow(ProblemError);
});

test('account cleanup and early privacy keep only the covered page and drop the uncovered label', () => {
  const row = covered();
  expect(liveCoverage(row)).toEqual(['/pages/1/document']);
  const kept = retainCoveredPayload(row);
  expect(kept.configuration?.pages).toEqual([notes]);
  expect(kept.configuration?.labels).toEqual({});
  expect(kept.mounts).toEqual([]);
});
