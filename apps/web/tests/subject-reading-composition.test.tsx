import { expect, mock, test } from 'bun:test';
import { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { createFakeKernelFetch, createRecordedKernelFetch } from '../src/kernel/fake';
import type { SubjectPageData } from '../src/features/pages/subject';
import { SubjectViewError } from '../src/subject/view-error';
import { m } from '../src/paraglide/messages.js';
import fixtures from '../src/kernel/fixtures.json';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { continuationSubject } from '../src/kernel/fake/view-continuation';
import { subjectTabs } from '../src/features/pages/views';
import { subjectPageMessages, viewTabLabels } from '../src/features/pages/route-support';
import { subjectHref } from '../src/subject/subject-href';
import { screenProfileFixture } from '../src/kernel/fake/catalogue-screen-profile';
import recordedSubject from '../src/kernel/recorded/subject.json';

mock.module('cloudflare:workers', () => ({ env: {} }));
const [
  { loadSubjectPage, SubjectPage, subjectBody, pageContext },
  { loadViewPages, SubjectFrame, subjectFrame, SubjectViewPage },
  { SubjectHeaderActions },
  { SubjectLibrarySlot },
  { ScreenProfileReader },
] = await Promise.all([
  import('../src/features/pages/subject'),
  import('../src/features/pages/subject-frame'),
  import('../src/features/pages/subject-reactions-view'),
  import('../src/library/subject-slot-view'),
  import('../src/features/catalogue/screen-profile-reader'),
]);

test('screen overview uses its released reader label and description instead of a schema identifier or editorial prompt', async () => {
  const fixture = screenProfileFixture('ready', 'en', true, 'schema:TVSeries');
  const loaded = await fixture.transport.load();
  if (!loaded.ok || !loaded.public) throw new Error('Expected the admitted anime Subject');
  const type = loaded.release.types['schema:TVSeries']!;
  const label = type.labels.en!;
  const description = type.descriptions!.en!;
  const html = renderToStaticMarkup(
    <ScreenProfileReader locale="en" release={loaded.release} public={loaded.public} />,
  );
  expect(html).toContain(`<span lang="en">${label[0]!.toLocaleUpperCase('en')}${label.slice(1)}</span>`);
  expect(html).toContain(`lang="en">${description}</p>`);
  expect(html).not.toContain('schema:TVSeries');
  expect(html).not.toContain(m.screen_intro());
});

test('The default Subject reader does not describe admitted incoming editions as title-only and reports temporary dependency failure honestly with safe read recovery', async () => {
  // The recorded native default composition, with the same owner leaves as the ordinary route.
  const page = structuredClone(recordedPage) as unknown as SubjectPageData;
  const sourcePlan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const subjectKeys = Object.entries(sourcePlan.reads)
    .filter(([, read]) => read.kind === 'subject' && read.id === page.subject)
    .map(([key]) => key);
  if (subjectKeys.length === 0) throw new Error('Expected the composition Subject read.');
  for (const key of subjectKeys) page.reads[key] = { status: 200, body: structuredClone(recordedSubject) };
  const recorded = await loadSubjectPage(
    createKernelClient('https://kernel.invalid', {
      fetch: createRecordedKernelFetch({ 'subject-page': page as never }),
    }),
    recordedPage.subject,
  );
  if (recorded.kind !== 'page') throw new Error('Expected the recorded subject page.');
  const labels = viewTabLabels();
  const messages = subjectPageMessages();
  const client = createKernelClient('https://kernel.invalid', { fetch: createFakeKernelFetch(fixtures as never) });
  let content: ReactNode = (
    <SubjectPage
      page={recorded.page}
      locale="en"
      messages={messages}
      tabs={subjectTabs(recorded.page)}
      tabLabels={labels}
      renderJsonLd={false}
      actions={({ id, type }) => (
        <SubjectHeaderActions
          id={id}
          reactions={null}
          signedIn={false}
          returnTo={subjectHref({ id, label: 'The Little Prince' }, 'en').href}
          verification={{ sitekey: '', scriptUrl: '' }}
        >
          <SubjectLibrarySlot
            subject={{ id, type, label: 'The Little Prince' }}
            locale="en"
            data={{
              session: 'signed-out',
              csrfToken: null,
              entryAvailable: false,
              entry: null,
              publicCollections: null,
              publicCollectionsNext: null,
              collectionsLoaded: false,
              collections: null,
              labels: null,
            }}
          />
        </SubjectHeaderActions>
      )}
    />
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const exposure = await client.platform.exposure.get();
  queryClient.setQueryData(['exposure', 'anonymous'], [...(exposure.data?.admitted ?? []), 'personal_library']);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => content }),
    history: createMemoryHistory({ initialEntries: ['/en/subjects'] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(html.match(/data-slot="subject-header"/g)).toHaveLength(1);
  expect(html.indexOf('data-slot="subject-header"')).toBeLessThan(html.indexOf('data-slot="literary-reader"'));
  expect(html).toMatch(/<h1[^>]*font-sans[^>]*>The Little Prince<\/h1>/);
  expect(html).toMatch(/data-slot="subject-primary-actions"[^>]*class="[^"]*col-span-full[^">]*grid-cols-1/);
  expect(html.indexOf('data-slot="subject-primary-actions"')).toBeGreaterThan(html.indexOf('<h1'));
  expect(html).toContain('data-slot="subject-library-actions"');
  expect(html).toContain('data-slot="subject-header-actions"');
  expect(html).toContain('href="/auth/sign-in?return_to=');
  expect(html).toContain('id="summary"');
  expect(html).toContain('id="sources"');
  expect(html).toContain('overflow-x-auto');
  expect(html).toContain('flex-nowrap');
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).not.toContain('role="tab"');

  // Keep the actual default document and admitted native editions; only the subject's own facts are empty.
  const ownEmpty = structuredClone(recordedPage) as unknown as SubjectPageData & { status: number };
  const own = subjectBody(ownEmpty);
  if (!own) throw new Error('Expected the recorded native subject read.');
  own.subject.statements = {};
  own.subject.descriptions = {};
  own.subject.relationCounts = Object.fromEntries(Object.keys(own.subject.relationCounts).map((key) => [key, 0]));
  const plan = planReads(platformRegistry, ownEmpty.document as CompositionDocument, pageContext(ownEmpty));
  const editionKey = Object.entries(plan.reads).find(
    ([, read]) => read.kind === 'links' && read.property === 'schema:exampleOfWork',
  )?.[0];
  if (!editionKey) throw new Error('Expected the default composition editions read.');
  const renderPage = (page: SubjectPageData) => {
    content = (
      <SubjectPage
        page={page}
        locale="en"
        messages={messages}
        tabs={subjectTabs(page)}
        tabLabels={labels}
        invitation={m.subject_empty()}
        renderJsonLd={false}
      />
    );
    return renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  };
  const renderLoaded = async (recording: typeof ownEmpty) => {
    const loaded = await loadSubjectPage(
      createKernelClient('https://kernel.invalid', {
        fetch: createRecordedKernelFetch({ 'subject-page': recording }),
      }),
      recordedPage.subject,
    );
    if (loaded.kind !== 'page') throw new Error('Expected a loaded subject page.');
    return renderPage(loaded.page);
  };
  const incoming = await renderLoaded(ownEmpty);
  expect(incoming).toContain('The Little Prince (Reynal &amp; Hitchcock, 1943)');
  expect(incoming).not.toContain('data-slot="invitation"');
  expect(incoming).not.toContain(m.subject_empty());
  expect(incoming).toContain('data-slot="subject-contribute"');

  const empty = structuredClone(ownEmpty);
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'links')
      empty.reads[key] = { status: 200, body: { links: [], count: { value: 0, exact: true }, next: null } };
  }
  const invitation = await renderLoaded(empty);
  expect(invitation).toContain('data-slot="invitation"');
  expect(invitation).toContain(m.subject_empty());
  expect(invitation).toContain('data-slot="subject-contribute"');
  const described = structuredClone(empty);
  subjectBody(described)!.subject.descriptions = { en: 'A catalogue description' };
  expect(await renderLoaded(described)).not.toContain('data-slot="invitation"');
  const counted = structuredClone(empty);
  subjectBody(counted)!.subject.relationCounts = { 'schema:author': 1 };
  expect(await renderLoaded(counted)).not.toContain('data-slot="invitation"');

  // None of these admitted/unknown results certifies that the subject has no relations.
  for (const result of [
    undefined,
    { status: 204, body: null },
    { status: 503, body: { code: 'dependency_unavailable' } },
    { status: 200, body: { count: { value: 0, exact: true }, next: null } },
    { status: 200, body: { links: [], next: null } },
    { status: 200, body: { links: [], count: { value: 0, exact: false }, next: null } },
    { status: 200, body: { links: [], count: { value: 0, exact: true }, next: 'continue' } },
    { status: 200, body: { links: [{ subject: 'withheld', summary: null }], next: null } },
  ]) {
    const unknown = structuredClone(empty);
    if (result) unknown.reads[editionKey] = result;
    else delete unknown.reads[editionKey];
    const uncertain = await renderLoaded(unknown);
    expect(uncertain).not.toContain('data-slot="invitation"');
    expect(uncertain).toContain('data-slot="subject-contribute"');
    expect(uncertain).not.toContain('withheld');
  }

  // A dependency failure retries the same ordinary read, with no command or privileged fallback.
  const recordedFetch = createRecordedKernelFetch({ 'subject-page': ownEmpty });
  const requests: Request[] = [];
  const recoveryClient = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return requests.length === 1
        ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
        : recordedFetch(request);
    }) as typeof fetch,
  });
  const retryRead = () => loadSubjectPage(recoveryClient, recordedPage.subject);
  let readError: unknown;
  try {
    await retryRead();
  } catch (error) {
    readError = error;
  }
  expect(readError).toBeInstanceOf(Error);
  expect((readError as Error).message).toBe('dependency_unavailable');
  const entry = `${subjectHref({ id: recordedPage.subject, label: 'The Little Prince' }, 'en').href}?cursor=old&node=editions&context=notes#selection`;
  const errorRouter = createRouter({
    routeTree: createRootRoute({
      component: () => <SubjectViewError error={readError as Error} reset={() => void retryRead()} />,
    }),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await errorRouter.load();
  const unavailable = renderToStaticMarkup(<RouterProvider router={errorRouter} />);
  expect(unavailable).toContain(m.subject_view_unavailable());
  expect(unavailable).not.toContain(m.subject_view_changed());
  expect(unavailable).not.toContain('dependency_unavailable');
  expect(unavailable).toContain(m.subject_view_retry());
  expect(unavailable).toContain(m.subject_view_restart());
  const restart = unavailable.match(/<a\b[^>]*href="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
  expect(restart).toBe(entry.replace('cursor=old&', ''));
  expect(errorRouter.state.location.href).toBe(entry);
  const recovered = await retryRead();
  if (recovered.kind !== 'page') throw new Error('Expected the recovered native page.');
  expect(subjectBody(recovered.page)?.subject.id).toBe(recordedPage.subject);
  const recoveredHtml = renderPage(recovered.page);
  expect(recoveredHtml).toContain('The Little Prince (Reynal &amp; Hitchcock, 1943)');
  expect(recoveredHtml).not.toContain('data-slot="invitation"');
  expect(requests).toHaveLength(2);
  for (const request of requests) {
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/v1/pages:read');
    expect(request.headers.has('authorization')).toBe(false);
  }
  expect(await requests[1]!.json()).toEqual(await requests[0]!.json());

  // The existing large-data fake fixture uses the same default template and real URL continuation.
  const preview = await loadSubjectPage(client, continuationSubject.id);
  if (preview.kind !== 'page') throw new Error('Expected the large-data fixture page.');
  content = (
    <SubjectPage
      page={preview.page}
      locale="en"
      messages={messages}
      tabs={subjectTabs(preview.page)}
      tabLabels={labels}
      renderJsonLd={false}
    />
  );
  const bounded = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(bounded).toContain('First edition 12');
  expect(bounded).not.toContain('First edition 13');
  expect(bounded).toContain(`${subjectHref(continuationSubject, 'en').href}/editions`);
  const full = await loadViewPages(client, continuationSubject.id, 'editions');
  if (full.kind !== 'page') throw new Error('Expected the complete editions view.');
  const frame = subjectFrame(full.overview, 'en');
  if (!frame) throw new Error('Expected the subject identity from the existing overview read.');
  content = (
    <SubjectViewPage
      page={full.page}
      locale="en"
      messages={messages}
      view="editions"
      label={labels.names.editions}
      nextHref={`${subjectHref(continuationSubject, 'en').href}/editions?cursor=${full.next}`}
      frame={
        <SubjectFrame
          frame={frame}
          locale="en"
          unlabelled={messages.unlabelled}
          tabs={subjectTabs(full.overview)}
          tabLabels={labels}
          view="editions"
        />
      }
      renderJsonLd={false}
    />
  );
  const complete = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  expect(complete.match(/data-slot="subject-header"/g)).toHaveLength(1);
  expect(complete.match(/<h[12][^>]*>Editions<\/h[12]>/g)).toHaveLength(1);
  expect(complete).toContain('First edition 24');
  expect(complete.match(/data-slot="continue-group"/g)).toHaveLength(1);
  expect(complete).toContain('cursor=continuation-next');
  expect(complete).not.toContain('data-slot="next-page"');
  expect(complete).toMatch(/aria-current="page"[^>]*href="[^"]*\/editions"/);
  queryClient.clear();
});
