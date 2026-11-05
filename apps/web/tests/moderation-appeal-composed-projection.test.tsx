import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Appeal } from '../src/moderation/appeals-read';
import { appealResolutionObservation } from '../src/moderation/appeal-resolution/intent';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/threads/authoring-departure', () => ({
  AuthoringDepartureBoundary: ({ children }: { children: unknown }) => children,
  useAuthoringDeparture: () => ({ release() {} }),
}));
const { WorkbenchAppeal } = await import('../src/moderation/workbench-appeal');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');

const appeal: Appeal = {
  id: '01900000-0000-7000-8000-000000000001',
  decisionId: '01900000-0000-7000-8000-000000000002',
  appellantId: 'private-appellant-id',
  appellantIdentity: {
    state: 'available',
    kind: 'actor',
    handle: 'reader',
    displayName: 'Reader',
    automated: false,
  },
  statement: 'Please reconsider the decision.',
  createdAt: '2026-01-01T00:00:00.000Z',
  decision: {
    statement: 'Policy violation.',
    target: { kind: 'post', id: 'original-post-id' },
  },
  targetContext: {
    state: 'available',
    destination: { kind: 'thread', id: 'current-thread-id', boardId: 'current-board-id' },
  },
  canResolve: false,
  resolution: null,
  resolutionCommand: {
    operationId: 'moderation_appeal.resolve',
    method: 'POST',
    path: '/v1/moderation-appeals/01900000-0000-7000-8000-000000000001:resolve',
  },
  source: { partition: 0, epoch: 1, position: '12' },
};

function render(selectedAppeal: Appeal) {
  const cache = new QueryClient();
  cache.setQueryData(['session'], { state: 'signed-in', subject: 'moderator', csrfToken: 'csrf' });
  const markup = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: cache },
      createElement(WorkbenchAppeal, {
        appealId: selectedAppeal.id,
        page: { state: 'ready', appeals: [], selectedAppeal },
        queueHref: '/moderation/workbench?queue=appeals&cursor=captured',
      }),
    ),
  );
  cache.clear();
  return markup;
}

test('selected appeal keeps original evidence distinct from disclosed identity and current destination', () => {
  const markup = render(appeal);
  expect(markup).toContain('Reader · @reader');
  expect(markup).toContain('Policy violation.');
  expect(markup).toContain('original-post-id');
  expect(markup).toContain('current-thread-id');
  expect(markup).toContain('current-board-id');
  expect(markup).toContain('Please reconsider the decision.');
  expect(markup).toContain(m.moderation_appeal_resolution_pending());
  expect(markup).not.toContain('private-appellant-id');
  expect(markup).toContain('cursor=captured');
});

test('concealed and unavailable context preserve exact resolution outcomes and statements', () => {
  const upheld = render({
    ...appeal,
    appellantIdentity: { state: 'concealed' },
    targetContext: { state: 'concealed' },
    resolution: { outcome: 'upheld', statement: 'Reviewed independently.', resolvedAt: '2026-01-02T00:00:00.000Z' },
  });
  expect(upheld).toContain(m.moderation_appeal_appellant_concealed());
  expect(upheld).toContain(m.moderation_appeal_context_concealed());
  expect(upheld).toContain(m.moderation_appeal_upheld());
  expect(upheld).toContain('Reviewed independently.');
  expect(upheld).toContain('2026-01-02T00:00:00.000Z');
  expect(upheld).toContain('Please reconsider the decision.');

  const reversed = render({
    ...appeal,
    appellantIdentity: { state: 'unavailable' },
    targetContext: { state: 'unavailable' },
    resolution: {
      outcome: 'reversed',
      statement: 'The decision was reversed.',
      resolvedAt: '2026-01-03T00:00:00.000Z',
    },
  });
  expect(reversed).toContain(m.moderation_appeal_appellant_unavailable());
  expect(reversed).toContain(m.moderation_target_unavailable());
  expect(reversed).toContain(m.moderation_appeal_reversed());
  expect(reversed).toContain('The decision was reversed.');
  expect(reversed).toContain('2026-01-03T00:00:00.000Z');
});

test('a current resolved observation does not settle a pending or uncertain original command', () => {
  const observed = {
    outcome: 'upheld' as const,
    statement: 'Observed independently.',
    resolvedAt: '2026-01-02T00:00:00.000Z',
  };
  expect(appealResolutionObservation('pending', null, observed)).toBeUndefined();
  expect(appealResolutionObservation('uncertain', null, observed)).toBeUndefined();
  expect(appealResolutionObservation('draft', null, observed)).toEqual({
    outcome: 'upheld',
    statement: 'Observed independently.',
  });
  expect(
    appealResolutionObservation(
      'uncertain',
      { state: 'resolved', outcome: 'reverse', statement: 'Receipt.' },
      observed,
    ),
  ).toEqual({ outcome: 'reversed', statement: 'Receipt.' });
});
