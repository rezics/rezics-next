import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentProps } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/subject-page.json';
import { qualifiedRealm, qualifiedRelationsPage, qualifiedSubject } from '../src/kernel/fake/qualified-relations';
import type { SubjectPageData } from '../src/features/pages/subject';
import { contextHref } from '../src/features/pages/context-navigation';
import { subjectHref } from '../src/subject/subject-href';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectFrame, SubjectViewPage, subjectFrame } = await import('../src/features/pages/subject-frame');
const { StreamHeading, PageStreamHeadingContext, ViewHeading } = await import('../src/features/pages/view-heading');
const { SubjectPage } = await import('../src/features/pages/subject');
const { SubjectCommunityRegion } = await import('../src/features/pages/subject-community-view');
const { SubjectLibraryLeaf } = await import('../src/features/pages/subject-library-leaf');
const { subjectPageMessages, viewTabLabels } = await import('../src/features/pages/route-support');
const { subjectTabs } = await import('../src/features/pages/views');
const { WriteReviewAction } = await import('../src/subject/write-review');

const translated = 'Donaudampfschifffahrtsgesellschaftskapitän'.repeat(5) + ' — 翻訳された長い題名 / 긴 번역 제목';
const original = '原題のすべてを省略せずに読むための長い題名'.repeat(8);
const heading = 'AusgabenUndVeröffentlichungsgeschichte'.repeat(5) + ' / 関連する作品と資料';
const signedOut = { state: 'signed-out', subject: null, csrfToken: null } as const;
const recordedIdentity = subjectFrame(recording as unknown as SubjectPageData, 'en')!;
type Frame = ComponentProps<typeof SubjectFrame>['frame'];

/** Existing supplied bodies only: this tests presentation, not successful native reads or permissions. */
function supplied(streams: 'none' | 'one' | 'many', realm?: string) {
  const page = qualifiedRelationsPage({ realm });
  if (streams === 'one')
    page.document.content = page.document.content.filter((node) => ['SubjectHeader', 'Credits'].includes(node.type));
  if (streams === 'none')
    page.document.content = page.document.content.map((node) => ({ ...node, props: { ...node.props, paged: false } }));
  if (realm) page.requestedRealm = realm;
  const frame: Frame = {
    ...subjectFrame(page, 'en')!,
    title: { text: translated, lang: 'de' },
    original: { text: original, lang: 'ja' },
    ...(recordedIdentity.date ? { date: recordedIdentity.date } : {}),
  };
  const base = subjectHref({ id: frame.id, label: frame.title.text }, 'en').href;
  const next = `${base}/credits?node=cast&cursor=cast-next${realm ? `&realm=${realm}` : ''}`;
  return { page, frame, base, next };
}

async function mount({
  streams = 'none',
  realm,
  missing = false,
  session = 'signed-out',
  embedded = false,
  streamTitle,
  withPreview = false,
}: {
  streams?: 'none' | 'one' | 'many';
  realm?: string;
  missing?: boolean;
  session?: 'signed-out' | 'unavailable';
  embedded?: boolean;
  streamTitle?: string;
  withPreview?: boolean;
} = {}) {
  const input = supplied(streams, realm);
  if (withPreview) {
    const threadPreview = recording.document.content.find((node) => node.type === 'ThreadList')!;
    input.page.document.content.push(structuredClone(threadPreview));
  }
  if (streamTitle)
    input.page.document.content = input.page.document.content.map((node) =>
      node.type === 'Credits' ? { ...node, props: { ...node.props, title: { de: streamTitle } } } : node,
    );
  if (missing) {
    const { original: _original, ...frame } = input.frame;
    input.frame = { ...frame, title: { text: '' }, summary: null };
  }
  const base = subjectHref({ id: input.frame.id, label: input.frame.title.text }, 'en').href;
  const client = new QueryClient();
  client.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  const content = embedded ? (
    <SubjectPage
      page={input.page}
      subjectLabel={input.frame.title.text}
      locale="en"
      messages={subjectPageMessages()}
      view="credits"
      renderJsonLd={false}
      framed
    />
  ) : (
    <SubjectViewPage
      page={input.page}
      subjectLabel={input.frame.title.text}
      locale="en"
      messages={subjectPageMessages()}
      view="credits"
      label={heading}
      nextHref={input.next}
      renderJsonLd={false}
      actions={
        <WriteReviewAction
          subjectId={input.frame.id}
          subjectTitle={input.frame.title.text}
          locale="en"
          session={session}
        />
      }
      frame={
        <SubjectFrame
          frame={input.frame}
          locale="en"
          realm={realm}
          typeLabel="Book"
          unlabelled={m.subject_value_unlabelled({}, { locale: 'en' })}
          tabs={subjectTabs(input.page)}
          tabLabels={viewTabLabels()}
          view="credits"
          library={<SubjectLibraryLeaf frame={input.frame} locale="en" session={signedOut} />}
        />
      }
    />
  );
  // A browser encodes multilingual paths before the router sees them; memory history does not.
  const location = new URL(contextHref(`${base}/credits`, realm), 'https://rezics.invalid');
  const router = createRouter({
    routeTree: createRootRoute({ component: () => content }),
    history: createMemoryHistory({ initialEntries: [location.pathname + location.search] }),
  });
  await router.load();
  try {
    return {
      ...input,
      html: renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
      base,
    };
  } finally {
    client.clear();
  }
}

const escaped = (value: string) => renderToStaticMarkup(<>{value}</>);
const region = (html: string, tag: string, slot: string) =>
  new RegExp(`<${tag}[^>]*data-slot="${slot}"[\\s\\S]*?<\\/${tag}>`).exec(html)?.[0] ?? '';
const hrefs = (html: string) =>
  [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!.replaceAll('&amp;', '&'));

describe('Companion Subject views retain the complete supplied title, original title, view heading and native continuation at phone width without changing view navigation, action gates or Library placement.', () => {
  test('the mounted frame keeps all identity text, languages, metadata and the actual view heading', async () => {
    const { html, frame, base } = await mount();
    const header = region(html, 'header', 'subject-header');
    expect(header).toMatch(/<a[^>]*lang="de"/);
    expect(header).toContain(`${escaped(translated)}</a>`);
    expect(header).toContain(escaped(original));
    expect(header).toMatch(/<span lang="ja"/);
    expect(header).toContain('Book');
    expect(header).toContain(frame.date!);
    expect(hrefs(header)).toContain(base);
    expect(header).not.toContain('<h1');
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(region(html, 'div', 'view-heading')).toContain(`${escaped(heading)}</h1>`);
    expect(html).toContain('Ada Player');
    expect(html).toContain('data-size="xs"');
    expect(html).toContain('data-ratio="5:7"');
  });

  test('the exact fallback cursor and Realm survive once, with independent supplied Library and action regions in order', async () => {
    const { html, base, next, frame } = await mount({ realm: qualifiedRealm });
    const tabs = region(html, 'nav', 'view-tabs');
    expect(hrefs(tabs)).toContain(contextHref(`${base}/credits`, qualifiedRealm));
    expect(tabs.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tabs).toMatch(/data-view="credits"[^>]*aria-current="page"/);
    expect(tabs).not.toContain('role="tab"');
    expect(hrefs(html).filter((href) => href === next)).toHaveLength(1);
    expect(html.match(/data-slot="next-page"/g)).toHaveLength(1);
    expect(html).not.toContain('data-slot="continue-group"');
    expect(html).toContain(escaped(m.subject_view_continue({ label: heading }, { locale: 'en' })));
    expect(html.match(/data-slot="subject-library"/g)).toHaveLength(1);
    expect(html).toContain('data-library-sign-in');
    expect(hrefs(html)).toContain(
      `/auth/sign-in?return_to=${encodeURIComponent(contextHref(`${base}/credits`, qualifiedRealm))}`,
    );
    expect(hrefs(region(html, 'nav', 'page-context'))).toEqual([`/en/realms/${qualifiedRealm}`, `${base}/credits`]);
    expect(html.indexOf('data-slot="subject-header"')).toBeLessThan(html.indexOf('data-slot="subject-library"'));
    expect(html.indexOf('data-slot="subject-library"')).toBeLessThan(html.indexOf('data-slot="view-tabs"'));
    expect(html.indexOf('data-slot="view-tabs"')).toBeLessThan(html.indexOf('<h1'));
    expect(html).not.toContain('data-slot="subject-contribute"');
    expect(hrefs(html)).toContain(`/auth/sign-in?return_to=${encodeURIComponent(`/en/subjects/${frame.id}/reviews`)}`);
  });

  test('one real stream owns its heading and continuation; the wrapper adds neither', async () => {
    const { html } = await mount({ streams: 'one', realm: qualifiedRealm });
    // The h1 comes from the stream rather than a duplicate wrapper heading.
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<h1[^>]*>Cast<\/h1>/g)).toHaveLength(1);
    expect(html.match(/<h[12][^>]*>Cast<\/h[12]>/g)).toHaveLength(1);
    expect(html).not.toContain('data-slot="view-heading"');
    expect(html).not.toContain('data-slot="next-page"');
    expect(html.match(/data-slot="continue-group"/g)).toHaveLength(1);
    const continuation = hrefs(html).find((href) => href.includes('cursor=cast-next'))!;
    const target = new URL(continuation, 'https://rezics.invalid');
    expect(target.pathname).toBe(`${subjectHref(qualifiedSubject, 'en').href}/credits`);
    expect(Object.fromEntries(target.searchParams)).toEqual({
      realm: qualifiedRealm,
      node: 'cast',
      cursor: 'cast-next',
    });
    expect(target.searchParams.has('context')).toBe(false);
    expect(html).toContain('Cast community');
  });

  test('an embedded real stream retains h2 and a full-page stream preserves its complete supplied heading and language', async () => {
    const embedded = await mount({ streams: 'one', embedded: true });
    expect(embedded.html).not.toContain('<h1');
    expect(embedded.html.match(/<h2[^>]*>Cast<\/h2>/g)).toHaveLength(1);
    const page = await mount({ streams: 'one', streamTitle: heading });
    expect(page.html.match(/<h1\b/g)).toHaveLength(1);
    expect(page.html).toContain(`${escaped(heading)}</h1>`);
    expect(page.html).toMatch(/<h1[^>]*id="cast-title"[^>]*lang="de"/);
    expect(hrefs(page.html).filter((href) => href.includes('cursor=cast-next'))).toEqual(
      hrefs(embedded.html).filter((href) => href.includes('cursor=cast-next')),
    );
  });

  test('the selected page stream has one h1 while a real embedded community preview retains h2', async () => {
    const { html } = await mount({ streams: 'one', withPreview: true });
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html.match(/<h1[^>]*>Cast<\/h1>/g)).toHaveLength(1);
    expect(html).toContain(`${escaped(m.subject_discussion())}</h2>`);
    expect(html).not.toContain('data-slot="next-page"');
    expect(html.match(/data-slot="continue-group"/g)).toHaveLength(1);
  });

  test('the shared rank option preserves embedded community headings and a direct host can override the inherited rank', () => {
    for (const kind of ['review', 'discussion'] as const) {
      const label = kind === 'review' ? m.subject_reviews() : m.subject_discussion();
      const region = (
        <SubjectCommunityRegion
          id={kind}
          kind={kind}
          region={{ state: 'closed' }}
          authors={{}}
          now="2026-11-02T00:00:00.000Z"
          subject={qualifiedSubject}
          locale="en"
          href={`${subjectHref(qualifiedSubject, 'en').href}/${kind === 'review' ? 'reviews' : 'discussion'}`}
          paged
        />
      );
      const embedded = renderToStaticMarkup(region);
      expect(embedded).not.toContain('<h1');
      expect(embedded).toContain(`${escaped(label)}</h2>`);
      const fullPage = renderToStaticMarkup(<PageStreamHeadingContext value={kind}>{region}</PageStreamHeadingContext>);
      expect(fullPage.match(/<h1\b/g)).toHaveLength(1);
      expect(fullPage).toContain(`${escaped(label)}</h1>`);
      expect(fullPage).toContain(`aria-labelledby="${kind}-title"`);
    }
    const explicit = renderToStaticMarkup(
      <PageStreamHeadingContext value="embedded">
        <StreamHeading node="embedded" level={2} lang="de">
          {heading}
        </StreamHeading>
      </PageStreamHeadingContext>,
    );
    expect(explicit).toMatch(/<h2[^>]*lang="de"/);
    expect(explicit).toContain(`${escaped(heading)}</h2>`);
    expect(explicit).not.toContain('<h1');
  });

  test('multiple stream groups retain their own cursor targets and exactly one page heading', async () => {
    const { html } = await mount({ streams: 'many', realm: qualifiedRealm });
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toContain(`${escaped(heading)}</h1>`);
    expect(html).not.toContain('data-slot="next-page"');
    const continuations = hrefs(html).filter((href) => href.includes('cursor='));
    expect(continuations).toHaveLength(3);
    expect(continuations.map((href) => new URL(href, 'https://rezics.invalid').searchParams.get('node'))).toEqual([
      'cast',
      'editions',
      'adaptations',
    ]);
  });

  test('missing cover and label use the disclosed fallback without adding an original title or exposing the id as text', async () => {
    const { html, base } = await mount({ missing: true, session: 'unavailable', realm: qualifiedRealm });
    const header = region(html, 'header', 'subject-header');
    expect(header).toContain(`${escaped(m.subject_value_unlabelled({}, { locale: 'en' }))}</a>`);
    expect(header).toContain('data-state="placeholder"');
    expect(header).not.toContain('lang="ja"');
    expect(header).not.toContain(original);
    expect(header).not.toContain('<img');
    expect(hrefs(header)).toEqual([contextHref(base, qualifiedRealm)]);
    expect(html).not.toContain(m.thread_review_sign_in({}, { locale: 'en' }));
  });

  test('global editorial entry and standalone ViewHeading count remain independent', async () => {
    const { html } = await mount();
    expect(html).toContain('data-slot="subject-contribute"');
    const headingOnly = renderToStaticMarkup(<ViewHeading label={heading} count={<span>12+</span>} />);
    expect(headingOnly).toContain(`${escaped(heading)}</h1><span>12+</span>`);
    expect(headingOnly.match(/<h1\b/g)).toHaveLength(1);
  });
});
