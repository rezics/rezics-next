import { expect, test } from 'bun:test';
import type { PageRead } from '@rezics/composition';
import { sameRelationStream } from '../src/features/pages/relation-stream-descriptor';

test('relation descriptors compare native fields, independently of object identity and cursor position', () => {
  for (const kind of ['links', 'relations'] as const) {
    const initial = { kind, id: 'subject', property: 'schema:author', limit: 12 };
    expect(sameRelationStream(initial, { ...initial, cursor: 'opaque:/+?=&% 日本語#' })).toBe(true);
    for (const change of [
      { kind: kind === 'links' ? 'relations' : 'links' },
      { id: 'another-subject' },
      { context: 'another-context' },
      { property: 'schema:illustrator' },
      { filter: 'another-filter' },
      { type: 'schema:Book' },
      { limit: 6 },
    ])
      expect(sameRelationStream(initial, { ...initial, ...change } as PageRead)).toBe(false);
    expect(sameRelationStream(initial, { kind: 'subject', id: initial.id })).toBe(false);
    expect(sameRelationStream({ kind: 'subject', id: initial.id }, initial)).toBe(false);
  }
});
