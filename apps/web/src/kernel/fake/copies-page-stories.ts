import { resetCopyKindsStory } from './copies-kinds';
import type { FakeRoute } from '../fake-modules.ts';
import recording from '../recorded/library-copies.json';

export type CopiesStoryMode = 'none' | 'one' | 'many' | 'long' | 'unavailable' | 'error' | 'refusal';
let mode: CopiesStoryMode = 'many';

/** Set the copies fixture before mounting a page story. */
export function setCopiesStoryMode(next: CopiesStoryMode): void {
  resetCopyKindsStory();
  mode = next;
}

const base = recording.copies.map((copy, index) => ({ ...copy, kind: index === 1 ? 'digital' : 'physical' }));
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
    story: () => {
      if (mode === 'unavailable')
        return { status: 503, type: 'https://rezics.com/problems/unavailable', code: 'unavailable' };
      if (mode === 'error')
        return { status: 500, type: 'https://rezics.com/problems/internal_error', code: 'internal_error' };
      if (mode === 'long') {
        const template = many[0]!;
        const copies = Array.from({ length: 12 }, (_, index) => ({
          ...template,
          id: `0192f3a0-6c1e-7b2a-9d4e-${String(index + 1).padStart(12, '0')}`,
          note: `Library copy story ${index + 1}`,
        }));
        return { status: 200, copies, next: null };
      }
      return { status: 200, copies: mode === 'none' ? [] : mode === 'one' ? base.slice(0, 1) : many, next: null };
    },
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
