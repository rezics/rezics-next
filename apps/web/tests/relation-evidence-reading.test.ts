import { expect, mock, test } from 'bun:test';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
const target = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e02';
const key = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e03';
const statement = {
  id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e04',
  property: { id: 'ex:appearance', data_type: 'wikibase-item' },
  value: { type: 'value', content: target },
  qualifiers: [],
  references: [],
  rank: 'normal',
};

test('an exact slot reads its own native window and refuses unavailable windows as an end', async () => {
  const { readRelationEvidence } = await import('../src/features/pages/relation-evidence-read');
  const calls: unknown[] = [];
  const responses: { status: number; data?: unknown }[] = [
    {
      status: 200,
      data: {
        candidates: [
          { id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e10', deleted: true },
          {
            id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
            source: null,
            retracted: null,
            statement,
            release: 'sha256:release',
            revision: 7,
            decision: 'accepted',
            head: 2,
            rank: 'preferred',
          },
        ],
        adoption: null,
        next: 'window-two',
      },
    },
    { status: 403 },
    { status: 400 },
  ];
  const client = {
    subjects: () => ({
      candidates: {
        get: async (request: unknown) => {
          calls.push(request);
          return responses.shift()!;
        },
      },
    }),
  };
  const input = { subject, locale: 'en', property: 'ex:appearance', target, key };
  const first = await readRelationEvidence(client as never, input);
  expect(first).toEqual({
    kind: 'ready',
    candidates: [
      {
        id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
        revision: 7,
        decision: 'accepted',
        rank: 'preferred',
        retracted: false,
        statement,
      },
    ],
    next: 'window-two',
  });
  // Release and source identifiers stay in the native reader.
  expect(JSON.stringify(first)).not.toContain('sha256:release');
  expect(calls[0]).toMatchObject({ query: { property: 'ex:appearance', target, key, limit: 20 } });
  expect(await readRelationEvidence(client as never, { ...input, cursor: 'window-two' })).toEqual({
    kind: 'failure',
    status: 403,
  });
  expect(calls[1]).toMatchObject({ query: { cursor: 'window-two' } });
  expect(await readRelationEvidence(client as never, { ...input, cursor: 'window-two' })).toEqual({
    kind: 'failure',
    status: 400,
  });
});

test('an evidence address adds only its exact slot and returns to the window unchanged', async () => {
  const { relationEvidenceClose, relationEvidenceHref } =
    await import('../src/features/pages/relation-evidence-context');
  const window =
    '/en/subjects/journey-work/relations?node=appearances&streamProperty=ex:appearance&streamDirection=forward&cursor=page-two';
  const href = relationEvidenceHref(window, { property: 'ex:credit', target, key });
  expect(href).toBeDefined();
  const opened = new URL(href!, 'https://rezics.invalid').searchParams;
  expect(opened.get('evidence')).toBe(target);
  expect(opened.get('evidenceProperty')).toBe('ex:credit');
  expect(opened.get('evidenceKey')).toBe(key);
  expect(opened.get('node')).toBe('appearances');
  expect(opened.get('cursor')).toBe('page-two');
  // The address is re-serialized, so the window is compared by its parsed parameters.
  const closed = new URL(relationEvidenceClose(href!), 'https://rezics.invalid');
  expect(closed.pathname).toBe('/en/subjects/journey-work/relations');
  expect([...closed.searchParams]).toEqual([...new URL(window, 'https://rezics.invalid').searchParams]);
  expect(relationEvidenceHref(window, { property: 'ex:credit', target: 'not-a-slot' })).toBeUndefined();
  expect(relationEvidenceHref(window, { property: 'bare words', target })).toBeUndefined();
});
