import { expect, test } from 'bun:test';
import { candidateItems } from '../src/modules/wiki/candidates.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('G-898: final disclosure fence makes restricted matches byte-identical to absence', () => {
  const publicMember = id(1), privateMember = id(2);
  const availability = new Map([[publicMember, true], [privateMember, false]]);
  const absent = [new Set<string>(), new Set([publicMember])];
  const present = [new Set([privateMember]), new Set([publicMember, privateMember])];
  expect(JSON.stringify(candidateItems(present, availability)))
    .toBe(JSON.stringify(candidateItems(absent, availability)));
  expect(candidateItems(present, availability)).toEqual([
    { index: 0, status: 'new', candidates: [] },
    { index: 1, status: 'matched', candidates: [publicMember] },
  ]);
  expect(candidateItems(present, new Map())).toEqual([
    { index: 0, status: 'new', candidates: [] }, { index: 1, status: 'new', candidates: [] },
  ]);
});

test('G-898: undisclosed matches do not consume the candidate bound or hide readable matches', () => {
  const visible = Array.from({ length: 16 }, (_, i) => id(i));
  const hidden = Array.from({ length: 64 }, (_, i) => id(i + 16));
  const availability = new Map(visible.map(target => [target, true]));
  expect(candidateItems([new Set([...visible, ...hidden])], availability))
    .toEqual(candidateItems([new Set(visible)], availability));
  availability.set(hidden[0]!, true);
  expect(() => candidateItems([new Set([...visible, ...hidden])], availability)).toThrow('wiki_query_budget');
});
