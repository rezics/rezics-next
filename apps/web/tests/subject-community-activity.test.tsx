import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommunityNativePresentation } from '../src/features/pages/subject-community-card-view';
import type { CommunityNativeCard } from '../src/features/pages/subject-community-card';

const card = (comments: CommunityNativeCard['comments']): CommunityNativeCard => ({
  author: null,
  presentation: { state: 'current', language: 'en', spoiler: false },
  comments,
  media: [],
});

function render(comments: CommunityNativeCard['comments']) {
  return renderToStaticMarkup(
    <CommunityNativePresentation
      card={card(comments)}
      summary="A current discussion preview."
      locale="en"
      now="2026-11-04T00:05:00.000Z"
      retryHref="/en/subjects/book/discussion"
    />,
  );
}

test('Subject cards render exact zero, accessible lower bounds and a retryable withheld state', () => {
  const zero = render({
    state: 'current',
    cohort: 'public',
    count: { kind: 'exact', value: 0 },
    lastActivityAt: null,
    source: { epoch: 1, position: '1' },
  });
  expect(zero).toContain('Replies: 0');
  expect(zero).not.toContain('<time');

  const lowerBound = render({
    state: 'current',
    cohort: 'public',
    count: { kind: 'lower-bound', value: 10_000 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
    source: { epoch: 1, position: '2' },
  });
  expect(lowerBound).toContain('Replies: 10,000+');
  expect(lowerBound).toContain('aria-label="At least 10,000 replies"');
  expect(lowerBound).toContain('<time datetime="2026-11-04T00:00:00.000Z"');

  const withheld = render({ state: 'withheld' });
  expect(withheld).toContain('role="status"');
  expect(withheld).toContain('Reply activity is unavailable.');
  expect(withheld).toContain('href="/en/subjects/book/discussion"');
  expect(withheld).not.toContain('10,000');
});
