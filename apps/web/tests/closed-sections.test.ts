import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry } from '@rezics/composition';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { loadSubjectPage, SubjectPage } from '../src/features/pages/subject.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import type { PageMessages } from '../src/features/pages/data.tsx';
import { OverviewContext, ReviewList, ThreadList } from '../src/features/pages/overview.tsx';

const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e06';
const local = createFakeKernelFetch(fixtures as never);
const client = createKernelClient('https://kernel.invalid', { fetch: local as typeof fetch });
const messages: PageMessages = {
  unknown: 'Unknown value',
  none: 'No value',
  unlabelled: 'Unlabelled subject',
  sources: 'Sources',
  aliases: 'Also known as',
  details: 'Details',
};
const render = async () => {
  const result = await loadSubjectPage(client, subject);
  if (result.kind !== 'page') throw new Error('expected a subject page');
  const html = renderToString(
    createElement(SubjectPage, {
      page: result.page,
      locale: 'en',
      messages,
      renderJsonLd: false,
    } as never),
  );
  return { html, page: result.page };
};

test('closed subject features leave no overview panels or tabs, and their URLs return to the overview', async () => {
  const { html, page } = await render();
  for (const slot of ['rating-summary', 'review-list', 'thread-list']) {
    expect(html).not.toContain(`data-slot="${slot}"`);
  }
  const tabs = subjectTabs(page);
  expect(tabs.map(({ view }) => view)).not.toContain('reviews');
  expect(tabs.map(({ view }) => view)).not.toContain('discussion');

  const route = await Bun.file(
    join(import.meta.dir, '..', 'src', 'routes', 'subjects', '$id_.$slug_.$view.tsx'),
  ).text();
  expect(route).toContain('tabs.some((tab) => tab.view === data.view)');
  expect(route).toContain('subjectUrlForView(canonical.value)');
});

test('closed subject features do not render not-yet-open bordered panels', async () => {
  const { html } = await render();
  expect(html).not.toContain('data-state="unavailable"');
  expect(html).not.toContain('not open yet');
  expect(html).not.toContain('border p-6');
});

test('open empty Reviews and Discussion reads retain their first-contribution invitations', () => {
  const document = {
    root: { props: {} },
    content: [
      { type: 'AccountThreads', props: { id: 'reviews', threadKind: 'review', limit: 5 } },
      { type: 'AccountThreads', props: { id: 'discussion', threadKind: 'discussion', limit: 5 } },
    ],
  };
  const account = { id: 'account-id', handle: 'reader' };
  const plan = planReads(platformRegistry, document as never, { subject, account });
  const reads = Object.fromEntries(
    Object.keys(plan.reads).map((key) => [key, { status: 200, body: { threads: [], next: null } }]),
  );
  const tabs = subjectTabs({
    subject,
    account,
    document,
    reads,
    views: ['overview', 'reviews', 'discussion', 'details'],
  });
  expect(tabs.map(({ view }) => view)).toContain('reviews');
  expect(tabs.map(({ view }) => view)).toContain('discussion');

  for (const [Component, id, invitation] of [
    [ReviewList, 'reviews', 'Write the first review.'],
    [ThreadList, 'threads', 'Start the first discussion.'],
  ] as const) {
    const context = {
      locale: 'en',
      subject,
      subjectLabel: 'Mushishi',
      unlabelled: 'Unlabelled subject',
      sections: new Map([[id, { ok: true, read: { kind: 'threads' }, body: { threads: [] } }]]),
    };
    const html = renderToString(
      createElement(OverviewContext.Provider, { value: context as never }, createElement(Component, { id })),
    );
    expect(html).toContain(invitation);
  }
});
