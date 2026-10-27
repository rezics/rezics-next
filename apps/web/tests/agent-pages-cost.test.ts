import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { agentAccount } from '../src/kernel/agent-fixtures.ts';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import fixtures from '../src/kernel/fixtures.json';
import { agentPath, loadAgentPage } from '../src/features/pages/agent.tsx';
import { SubjectPage } from '../src/features/pages/subject.tsx';
import { subjectTabs } from '../src/features/pages/views.ts';
import type { View } from '@rezics/composition';

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${n.toString(16).padStart(12, '0')}`;
const messages = { unknown: '', none: '', unlabelled: 'Unlabelled', sources: 'Sources', aliases: '', search: '' };
const names = Object.fromEntries(
  [
    'overview',
    'editions',
    'contents',
    'characters',
    'appearances',
    'credits',
    'works',
    'relations',
    'posts',
    'reviews',
    'discussion',
    'lists',
    'collections',
    'details',
  ].map((view) => [view, view]),
) as Record<View, string>;

// The previews hold four rows each; a view holds at most 20 posts, 20 reviews and 24 collections.
const preview = { 'account-posts': 4, 'account-reviews': 4, 'account-collections': 4 } as const;
const views = [
  ['posts', 'account-posts', 20],
  ['reviews', 'account-reviews', 20],
  ['collections', 'account-collections', 24],
] as const;

const section = (html: string, slot: string) =>
  new RegExp(`<section[^>]*data-slot="${slot}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
const rows = (html: string, slot: string) => (section(html, slot).match(/<li\b/g) ?? []).length;

for (const scale of [1, 10, 100]) {
  test(`an agent page reads and renders what its limits bound at 1, 10 and 100 threads, posts and collections (${scale})`, async () => {
    const account = agentAccount(
      { id: id(0x9001), handle: 'scaled', displayName: 'Scaled' },
      { reviews: scale, discussions: scale, posts: scale, collections: scale },
    );
    const sent: string[] = [];
    const local = createFakeKernelFetch({ ...fixtures, accounts: [account] } as never);
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        sent.push(`${request.method} ${new URL(request.url).pathname}`);
        return local(request);
      }) as typeof fetch,
    });
    const render = (page: Awaited<ReturnType<typeof loadAgentPage>> & { kind: 'page' }, view: View) =>
      renderToString(
        createElement(SubjectPage, {
          page: page.page,
          locale: 'en',
          messages,
          view,
          tabs: subjectTabs(page.page),
          tabLabels: { views: 'Views', names },
          base: agentPath('en', 'scaled'),
          ...(view === 'overview'
            ? {}
            : { heading: { title: 'Scaled', label: view, href: agentPath('en', 'scaled') } }),
          renderJsonLd: false,
        } as never),
      );

    // The overview is one page read; each preview holds its limit or the account's rows, whichever is fewer.
    const overview = await loadAgentPage(client, 'scaled');
    expect(overview.kind).toBe('page');
    expect(sent).toEqual(['POST /v1/pages:read']);
    const html = render(overview as never, 'overview');
    for (const [slot, limit] of Object.entries(preview)) expect(rows(html, slot)).toBe(Math.min(scale, limit));

    // A view is one page read and holds its own limit, so the work stays flat once the lists outgrow it.
    for (const [view, slot, limit] of views) {
      sent.length = 0;
      const page = await loadAgentPage(client, 'scaled', view);
      expect(sent).toEqual(['POST /v1/pages:read']);
      expect(rows(render(page as never, view), slot)).toBe(Math.min(scale, limit));
    }
  });
}
