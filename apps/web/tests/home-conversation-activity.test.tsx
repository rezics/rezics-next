import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { homeFeedDestination } from '../src/features/pages/home-feed-destination';
import { homeFeedItemPresentation } from '../src/features/feed/home-feed-item';
import { homeFeedStoryPage } from '../src/kernel/fake/home-feed-stories';

function card(activity: unknown) {
  const item = homeFeedStoryPage('en', true, 'mixed').feedItems.find((candidate) => candidate.key.owner === 'content')!;
  Object.assign(item.summary, { conversationActivity: activity });
  const presentation = homeFeedItemPresentation(item, 'en');
  return { html: renderToStaticMarkup(<>{presentation.metadata}</>), href: homeFeedDestination(item, 'en') };
}

test('Home distinguishes exact zero, lower-bound activity and withheld retry without losing its conversation target', () => {
  const zero = card({ state: 'current', cohort: 'public', count: { kind: 'exact', value: 0 }, lastActivityAt: null });
  expect(zero.html).toContain('Replies: 0');
  expect(zero.html).not.toContain('<time');
  expect(zero.href).toContain('/threads/');

  const lowerBound = card({
    state: 'current',
    cohort: 'public',
    count: { kind: 'lower-bound', value: 10_000 },
    lastActivityAt: '2026-11-04T00:00:00.000Z',
  });
  expect(lowerBound.html).toContain('Replies: 10,000+');
  expect(lowerBound.html).toContain('aria-label="At least 10,000 replies"');
  expect(lowerBound.html).toContain('<time datetime="2026-11-04T00:00:00.000Z"');

  const withheld = card({ state: 'withheld' });
  expect(withheld.html).toContain('role="status"');
  expect(withheld.html).toContain('Reply activity is unavailable.');
  expect(withheld.html).toContain(`href="${withheld.href}"`);
});
