import { expect, mock, test } from 'bun:test';
import { type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createKernelClient } from '@rezics/client';
import { createFakeKernelFetch, createRecordedKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { continuationSubject } from '../src/kernel/fake/view-continuation';
import { subjectTabs } from '../src/features/pages/views';
import { subjectPageMessages, viewTabLabels } from '../src/features/pages/route-support';
import { subjectHref } from '../src/subject/subject-href';

mock.module('cloudflare:workers', () => ({ env: {} }));
const [
  { loadSubjectPage, SubjectPage },
  { loadViewPages, SubjectFrame, subjectFrame, SubjectViewPage },
  { SubjectHeaderActions },
  { SubjectLibrarySlot },
] = await Promise.all([
  import('../src/features/pages/subject'),
  import('../src/features/pages/subject-frame'),
  import('../src/features/pages/subject-reactions-view'),
  import('../src/library/subject-slot-view'),
]);

test('Subject overview is readable on phones and complete views remain reachable through compact tabs', async () => {
  // The recorded native default composition, with the same owner leaves as the ordinary route.
  const recorded = await loadSubjectPage(
    createKernelClient('https://kernel.invalid', {
      fetch: createRecordedKernelFetch({ 'subject-page': recordedPage }),
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
  queryClient.setQueryData(['exposure', 'anonymous'], exposure.data?.admitted ?? []);
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
