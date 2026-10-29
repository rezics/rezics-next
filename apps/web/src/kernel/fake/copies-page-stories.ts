import { resetCopyKindsStory } from './copies-kinds';
import type { FakeRoute } from '../fake-modules.ts';
import recording from '../recorded/library-copies.json';

export type CopiesStoryMode = 'none' | 'one' | 'many' | 'refusal';
let mode: CopiesStoryMode = 'many';

/** Set the copies fixture before mounting a page story. */
export function setCopiesStoryMode(next: CopiesStoryMode): void {
  resetCopyKindsStory();
  mode = next;
}

const base = recording.copies.map((copy) => ({ ...copy, kind: 'physical' }));
const many = [
  ...base,
  ...base.slice(0, 1).map((copy) => ({
    ...copy,
    id: '01a17a3b-7065-7048-8c7f-f4ccfae1f400',
    status: 'lent',
    note: 'Loaned to a friend.',
  })),
  ...base.slice(1, 2).map((copy) => ({
    ...copy,
    id: '01a17a3b-7065-7048-8c7f-f4ccfae1f401',
    status: 'disposed',
    note: 'Passed along.',
  })),
];

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: '/v1/copies',
    story: () => ({ status: 200, copies: mode === 'none' ? [] : mode === 'one' ? base.slice(0, 1) : many, next: null }),
  },
  {
    method: 'POST',
    path: '/v1/copies',
    story: () =>
      mode === 'refusal'
        ? { status: 422, type: 'https://rezics.com/problems/invalid_request', code: 'invalid_request' }
        : undefined,
  },
];
