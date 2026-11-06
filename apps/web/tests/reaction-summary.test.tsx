import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import type { CompositionDocument } from '@rezics/composition';
import recording from '../src/kernel/recorded/subject-reactions.json';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { planReads, platformRegistry } = await import('@rezics/composition');
const { OverviewContext } = await import('../src/features/pages/overview');
const { ReactionSummary } = await import('../src/features/pages/reaction-summary');

const subject = '01a17a3b-0884-721b-91ef-d7ffd7bb58e4';
const document: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'ReactionSummary', props: { id: 'reactions' } }],
};
const plan = planReads(platformRegistry, document, { subject });
const read = plan.reads[plan.nodes.reactions!]!;
const body = { counts: recording.counts, watermark: recording.watermark };

function render(section: unknown, subjectId: string | null = subject) {
  return renderToString(
    createElement(
      OverviewContext.Provider,
      {
        value: {
          locale: 'en',
          subject: subjectId,
          currentHref: '/en/subjects/little-prince/',
          unlabelled: 'Unlabelled',
          reader: { suitability: 'blur' },
          labels: { cover: 'Cover' },
          sections: new Map([['reactions', section]]),
        } as never,
      },
      createElement(ReactionSummary, { id: 'reactions' }),
    ),
  );
}

test('recorded public reaction totals render without a viewer slot', () => {
  const html = render({ ok: true, read, body });
  expect(html).toContain('data-slot="reaction-summary"');
  expect(html).toContain('Like 42');
  expect(html).toContain('Love 17');
  expect(html).toContain('Laugh 3');
  expect(html).toContain('Insightful 8');
  expect(html).toContain('Sad 1');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('upvote');
  expect(html).not.toContain('viewer');
});

test('a mismatched producer or malformed counts leaf is unavailable as a whole', () => {
  const mismatched = render({
    ok: true,
    read: { kind: 'search', body: { filter: { type: { in: ['schema:Book'] } }, sort: 'name', limit: 1 } },
    body,
  });
  expect(mismatched).toContain('role="alert"');
  expect(mismatched).not.toContain('Like 42');
  expect(mismatched).toContain('/en/subjects/little-prince/');

  const otherSubject = render({
    ok: true,
    read: { kind: 'reactions', id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06' },
    body,
  });
  expect(otherSubject).toContain('role="alert"');
  expect(otherSubject).not.toContain('Like 42');

  const malformed = render({
    ok: true,
    read,
    body: {
      counts: [
        { kind: 'like', count: 42 },
        { kind: 'like', count: 1 },
      ],
      watermark: recording.watermark,
    },
  });
  expect(malformed).toContain('role="alert"');
  expect(malformed).not.toContain('Like 42');
});

test('Retry-After waits on this leaf and unrequested continuations stay omitted', () => {
  const waiting = render({ ok: false, status: 429, retryAt: Date.now() + 60_000 });
  expect(waiting).toContain('role="alert"');
  expect(waiting).toContain('disabled');
  expect(waiting).not.toContain('Like 42');

  const unrequested = render({ ok: false, status: 204 });
  expect(unrequested).toBe('');
});
