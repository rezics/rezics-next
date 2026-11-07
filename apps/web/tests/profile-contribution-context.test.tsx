import { expect, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { dirname } from 'node:path';
import { performanceAmbientTree } from './performance-ambient';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { PublicProfilePage } = await import('../src/accounts/public-profile/page');
const { contributionDestination } = await import('../src/accounts/public-profile/contributions/row');
const { rememberContribution, restoreContribution } =
  await import('../src/accounts/public-profile/contributions/navigation');
const { viewIsPublic } = await import('../src/features/pages/account-read');
import { contributionPage } from '../src/stories/pages/accounts-public-profile/fixtures';
import { preparedProfileContributions } from '../src/kernel/fake/profile-contribution-reading';
import { isRecord } from '../src/features/pages/shared';
import { locales } from '../src/paraglide/runtime.js';
import { useAgentReaderScope, useAgentReaderResult } from '../src/features/pages/agent-reader';
import type { AgentReaderResult } from '../src/features/pages/agent-actions';
import { m } from '../src/paraglide/messages.js';
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

function pageFor(kind: 'posts' | 'reviews' = 'reviews') {
  const page = contributionPage(kind);
  const prepared = preparedProfileContributions();
  const row = kind === 'posts' ? prepared.reply : prepared.review;
  row.authorId = page.account!.id;
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    const field = kind === 'posts' ? 'posts' : 'threads';
    if (Array.isArray(result.body[field])) result.body[field] = [row];
  }
  return { page, row };
}

function app(page: ReturnType<typeof contributionPage>, locale = 'en') {
  const cache = new QueryClient();
  cache.setQueryData(['exposure', 'anonymous'], []);
  return (
    <QueryClientProvider client={cache}>
      <PublicProfilePage
        page={page}
        locale={locale}
        base={`/${locale}/@${page.account!.handle}`}
        messages={{
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Account',
          sources: 'Sources',
          aliases: 'Aliases',
          details: 'Details',
        }}
        publicRealms={false}
        renderJsonLd={false}
      />
    </QueryClientProvider>
  );
}

test('review subject and historical citation preserve exact keys, destinations and all existing locales', () => {
  const { page, row } = pageFor();
  for (const locale of locales) {
    const html = renderToStaticMarkup(performanceAmbientTree(app(page, locale)));
    expect(html).toContain('data-profile-contribution-kind="review"');
    expect(html).toContain('Prepared reviewed work');
    expect(html).toContain('prepared-question');
    expect(html).toContain('data-feed-review-question-revision="3"');
    expect(html).toContain('data-feed-review-vote-revision="7"');
    expect(html).toContain(m.profile_contribution_historical_citation({}, { locale }));
    expect(html).toContain(`href="${contributionDestination(row, 'review', locale)}"`);
    expect(html).not.toContain('Prepared hidden ending');
    expect(html).not.toContain('csrf');
  }
});

test('reply and parent destinations stay separate; hidden text, missing context and concealed rows stay truthful', () => {
  const { page, row } = pageFor('posts');
  const html = renderToStaticMarkup(performanceAmbientTree(app(page)));
  expect(html).toContain(`?post=${row.id}#post-${row.id}`);
  expect(html).toContain('data-profile-conversation');
  expect(html).toContain('post=prepared-parent#post-prepared-parent');
  expect(html).toContain('prepared-parent-revision');
  expect(html).not.toContain('Prepared concealed parent ending');
  const body = Object.values(page.reads).find((entry) => isRecord(entry.body) && Array.isArray(entry.body.posts))!.body;
  if (!isRecord(body) || !Array.isArray(body.posts) || !isRecord(body.posts[0])) throw new Error('Missing posts');
  delete body.posts[0].parentContext;
  expect(renderToStaticMarkup(performanceAmbientTree(app(page)))).toContain('data-profile-context="unavailable"');
  body.posts[0].visibility = 'private';
  expect(renderToStaticMarkup(performanceAmbientTree(app(page)))).not.toContain(`?post=${row.id}`);
  expect(contributionDestination({ id: 'post', thread: { title: 'Not a locator' } }, 'reply', 'en')).toBeUndefined();
  expect(
    contributionDestination({ id: 'post', threadId: 'actual', thread: { id: 'other', title: 'Wrong' } }, 'reply', 'ja'),
  ).toBe('/ja/threads/actual?post=post#post-post');
});

test('Discussion publication follows Posts independently of Reviews, including missing profile refusal', () => {
  const page = contributionPage('reviews');
  for (const node of page.document.content) if (node.type === 'AccountThreads') node.props.threadKind = 'discussion';
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body)) continue;
    if (Array.isArray(result.body.threads))
      for (const row of result.body.threads) if (isRecord(row)) row.kind = 'discussion';
    if (Array.isArray(result.body.accounts))
      for (const profile of result.body.accounts)
        if (isRecord(profile)) profile.publicViews = { posts: true, reviews: false, collections: false, realms: false };
  }
  expect(renderToStaticMarkup(performanceAmbientTree(app(page)))).toContain('data-slot="account-threads"');
  for (const result of Object.values(page.reads)) {
    if (!isRecord(result.body) || !Array.isArray(result.body.accounts)) continue;
    for (const profile of result.body.accounts)
      if (isRecord(profile)) profile.publicViews = { posts: false, reviews: true };
  }
  expect(renderToStaticMarkup(performanceAmbientTree(app(page)))).not.toContain('data-slot="account-threads"');
  expect(viewIsPublic(undefined, 'discussion')).toBe(false);
});

test('a contribution window beyond the native twenty-row bound is unavailable', () => {
  const { page, row } = pageFor('posts');
  for (const result of Object.values(page.reads)) {
    if (isRecord(result.body) && Array.isArray(result.body.posts))
      result.body.posts = Array.from({ length: 21 }, (_, index) => ({ ...row, id: `post-${index}` }));
  }
  const html = renderToStaticMarkup(performanceAmbientTree(app(page)));
  expect(html).not.toContain('data-profile-contribution-kind="reply"');
  expect(html).toContain(m.subject_section_failed());
});

test('return focus belongs to the exact view/cursor history entry and exact reply link', () => {
  const window = new Window({ url: 'https://rezics.test/ja/@reader/posts?cursor=signed%2B%2F%3D&x=%20' });
  const root = window.document.createElement('li');
  root.innerHTML = '<a href="/ja/threads/t?post=p#post-p">Reply</a><a href="/ja/threads/t">Conversation</a>';
  window.document.body.append(root);
  window.history.replaceState({ retained: true }, '');
  rememberContribution('p', '/ja/threads/t?post=p#post-p', window);
  const address = window.location.href;
  restoreContribution(root, 'p', window);
  expect(window.document.activeElement).toBe(root.firstElementChild);
  expect(window.location.href).toBe(address);
  expect(window.history.state.retained).toBe(true);
  window.document.activeElement?.blur();
  window.history.replaceState(window.history.state, '', '?cursor=another');
  restoreContribution(root, 'p', window);
  expect(window.document.activeElement).not.toBe(root.firstElementChild);
  window.happyDOM.abort();
});

test('mounted page replacement retires revealed parent text and delayed old-view work', async () => {
  const window = new Window({ url: 'https://rezics.test/en/@reader/posts' });
  const names = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent'] as const;
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const name of names) Object.defineProperty(globalThis, name, { value: window[name], configurable: true });
  const root = createRoot(window.document.body);
  try {
    const first = pageFor('posts');
    await act(async () => root.render(app(first.page)));
    const parent = window.document.querySelector('[data-feed-parent-context="available"]')!;
    await act(async () => parent.querySelector<HTMLButtonElement>('button')!.click());
    expect(parent.textContent).toContain('Prepared concealed parent ending');
    const replacement = pageFor('posts');
    await act(async () => root.render(app(replacement.page)));
    expect(window.document.body.textContent).not.toContain('Prepared concealed parent ending');
    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const session = { state: 'signed-in', subject: 'reader', csrfToken: 'credential-one' };
    cache.setQueryData(['session'], session);
    let complete!: (result: AgentReaderResult) => void;
    const pending = new Promise<AgentReaderResult>((resolve) => {
      complete = resolve;
    });
    const scopes: ReturnType<typeof useAgentReaderScope>[] = [];
    function Viewer({ view }: { view: string }) {
      const scope = useAgentReaderScope({
        handle: 'reader',
        locale: 'en',
        path: { kind: 'view', view },
        enabled: true,
        session,
      });
      scopes.push(scope);
      const query = useQuery({ queryKey: scope.queryKey, enabled: scope.enabled, queryFn: () => pending });
      const reader = useAgentReaderResult(scope, query.data, query.status);
      return <output>{reader.spoilerLevel}</output>;
    }
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <Viewer view="reviews" />
        </QueryClientProvider>,
      ),
    );
    const old = scopes.at(-1)!;
    expect(old.current()).toBe(true);
    await act(async () =>
      root.render(
        <QueryClientProvider client={cache}>
          <Viewer view="discussion" />
        </QueryClientProvider>,
      ),
    );
    expect(old.current()).toBe(false);
    const discussion = scopes.at(-1)!;
    await act(async () => cache.setQueryData(['session'], { ...session, csrfToken: 'credential-two' }));
    expect(discussion.current()).toBe(false);
    await act(async () => {
      complete({ kind: 'ready', accountId: 'reader', reader: { spoilerLevel: 2, suitability: 'show' } });
      await pending;
    });
    // New credentials can receive their own delivered result, but neither old observation regains authority.
    expect(old.current()).toBe(false);
    expect(discussion.current()).toBe(false);
    cache.clear();
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    window.happyDOM.abort();
  }
});
