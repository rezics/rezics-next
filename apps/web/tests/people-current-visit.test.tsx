import { createRequire } from 'node:module';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { planReads, platformRegistry, type CompositionDocument, type SelectedContext } from '@rezics/composition';
import { PeopleProfileEntry } from '../src/features/catalogue/people-profile-entry';
import { PeopleCurrentVisitView } from '../src/features/catalogue/people-current-visit-view';
import {
  peopleCurrentVisitGlobalHref,
  peopleCurrentVisitReturnHref,
  validatePeopleCurrentVisitSearch,
} from '../src/features/catalogue/people-current-visit';
import { peoplePersonId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import { m } from '../src/paraglide/messages.js';
import { subjectHref } from '../src/subject/subject-href';

mock.module('cloudflare:workers', () => ({ env: {} }));

const personId = '00000000-0000-4000-8000-000000000201';
const contextId = '00000000-0000-4000-8000-000000000202';
const realmId = '00000000-0000-4000-8000-000000000203';
const locale = 'en';
const options = { locale: locale as never };

function searchOf(href: string): Record<string, unknown> {
  return Object.fromEntries(new URL(href, 'https://rezics.invalid').searchParams.entries());
}

test('mounted Person entry carries its admitted origin and mounts the existing editor only after an explicit Global choice', () => {
  const entry = renderToStaticMarkup(
    <PeopleProfileEntry
      id={personId}
      label="Mira Sato"
      locale={locale}
      currentVisit={{
        context: contextId,
        realm: realmId,
        definition: 'released:sha256-story-release',
        reader: 'source-reader-8',
        sourceAddress: `/en/subjects/${personId}/mira-sato?context=${contextId}&realm=${realmId}`,
      }}
    />,
  );
  const encodedHref = /href="([^"]+)"/u.exec(entry)?.[1];
  expect(encodedHref).toBeDefined();
  const href = encodedHref!.replaceAll('&amp;', '&');
  const location = new URL(href, 'https://rezics.invalid');
  const admitted = validatePeopleCurrentVisitSearch(searchOf(href), personId, locale);
  expect(admitted.kind).toBe('origin');
  if (admitted.kind !== 'origin') return;
  expect(admitted.origin).toMatchObject({ id: personId, context: contextId, realm: realmId });

  let editorMounts = 0;
  const gate = (visit: ReturnType<typeof validatePeopleCurrentVisitSearch>) =>
    renderToStaticMarkup(
      <PeopleCurrentVisitView
        locale={locale}
        pathname={location.pathname}
        visit={visit}
        renderEditor={(origin) => {
          editorMounts += 1;
          return <div data-slot="existing-people-profile-editor" data-origin={origin?.id ?? 'legacy'} />;
        }}
      />,
    );
  const unsupported = gate(admitted);
  expect(unsupported).toContain(m.people_current_visit_unsupported({}, options));
  expect(unsupported).toContain('#person-biography');
  expect(unsupported).not.toContain('existing-people-profile-editor');
  expect(editorMounts).toBe(0);

  const choice = peopleCurrentVisitGlobalHref(location.pathname, admitted.origin);
  const selected = validatePeopleCurrentVisitSearch(searchOf(choice), personId, locale);
  const globalVisit = gate(selected);
  expect(globalVisit).toContain(m.people_current_visit_global_selected({}, options));
  expect(globalVisit).toContain('existing-people-profile-editor');
  expect(globalVisit).toContain(`data-origin="${personId}"`);
  expect(editorMounts).toBe(1);

  const legacy = gate(validatePeopleCurrentVisitSearch({}, personId, locale));
  expect(legacy).toContain('data-origin="legacy"');
  expect(editorMounts).toBe(2);
});

test('the public Subject Person entry carries its actual origin and waits for Global choice before reading the profile', async () => {
  const { SubjectPage } = await import('../src/features/pages/subject');
  const { subjectPageMessages } = await import('../src/features/pages/route-support');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const fixture = peopleProfileFixture('ready', locale, 'person');
  fixture.person.subject.context = contextId;
  const selectedContext: SelectedContext = {
    id: contextId,
    population: { kind: 'realm', id: realmId, title: 'Harbour readers' },
  };
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'SubjectHeader', props: { id: 'header' } }],
  };
  const plan = planReads(platformRegistry, document, { subject: peoplePersonId, context: selectedContext });
  const page = {
    subject: peoplePersonId,
    profile: 'fixture',
    template: { scope: 'generic' as const, key: null },
    document,
    context: selectedContext,
    requestedReader: 'public-reader-visit-9',
    catalogue: {
      state: 'released' as const,
      type: 'schema:Person',
      digest: 'sha256:person-release-9',
      definitions: fixture.release,
    },
    reads: Object.fromEntries(
      Object.keys(plan.reads).map((key) => [key, { status: 200, body: fixture.person }]),
    ),
  };
  const source = new URLSearchParams({ context: contextId, realm: realmId });
  const sourceAddress = `${subjectHref({ id: peoplePersonId, label: 'Mira Sato' }, locale).href}?${source}`;
  const serverClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pageMarkup = renderToStaticMarkup(
    <QueryClientProvider client={serverClient}>
      <SubjectPage
        page={page}
        locale={locale}
        messages={subjectPageMessages(locale)}
        currentHref={sourceAddress}
        renderJsonLd={false}
      />
    </QueryClientProvider>,
  );
  const encodedEntry = /href="([^"]*\/people\?visit=[^"]*)"/u.exec(pageMarkup)?.[1];
  expect(encodedEntry).toBeDefined();
  const entryHref = encodedEntry!.replaceAll('&amp;', '&');
  const entry = new URL(entryHref, 'https://rezics.invalid');
  const admitted = validatePeopleCurrentVisitSearch(searchOf(entryHref), peoplePersonId, locale);
  expect(admitted.kind).toBe('origin');
  if (admitted.kind !== 'origin') return;
  expect(admitted.origin).toMatchObject({
    context: contextId,
    realm: realmId,
    locale,
    definition: 'released:sha256:person-release-9',
    reader: 'public-reader-visit-9',
    returnAddress: sourceAddress,
  });

  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.test${entry.pathname}${entry.search}` });
  const globals = {
    window,
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLSelectElement',
        'Element',
        'Node',
        'MutationObserver',
        'ResizeObserver',
        'Document',
        'DocumentFragment',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { CandidateReaderBoundary } = await import('../src/subject/candidate-lifetime');
  const { PeopleProfileEditor } = await import('../src/features/catalogue/people-profile-view');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const testing = createRequire(require.resolve('storybook/test'));
  const { waitFor } = await import(testing.resolve('@testing-library/dom'));
  setLocale(locale, { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let reads = 0;
  const transport = {
    ...fixture.transport,
    load: async () => {
      reads++;
      return fixture.transport.load();
    },
  };
  const renderRoute = (visit: ReturnType<typeof validatePeopleCurrentVisitSearch>, address: string) =>
    root.render(
      <QueryClientProvider client={client}>
        <CandidateReaderBoundary
          observed={{ state: 'signed-in', subject: 'current-reader', csrfToken: 'session-token' }}
          address={address}
        >
          <PeopleCurrentVisitView
            locale={locale}
            pathname={entry.pathname}
            visit={visit}
            renderEditor={(origin) =>
              origin ? (
                <PeopleProfileEditor
                  id={peoplePersonId}
                  locale={locale}
                  currentVisit={origin}
                  returnHref={peopleCurrentVisitReturnHref(origin)}
                  session="signed-in"
                  transport={transport}
                  propose={fixture.propose}
                  review={fixture.review}
                  onNavigate={() => {}}
                />
              ) : null
            }
          />
        </CandidateReaderBoundary>
      </QueryClientProvider>,
    );
  try {
    await import('react').then(({ act }) => act(async () => renderRoute(admitted, entry.href)));
    expect(host.textContent).toContain(m.people_current_visit_unsupported({}, options));
    expect(reads).toBe(0);

    const choice = host.querySelector('a[href*="correction=global"]');
    expect(choice).not.toBeNull();
    const choiceHref = new URL(choice!.getAttribute('href')!, window.location.href).href;
    const selected = validatePeopleCurrentVisitSearch(searchOf(choiceHref), peoplePersonId, locale);
    expect(selected).toMatchObject({ kind: 'origin', correction: 'global' });
    await import('react').then(({ act }) => act(async () => renderRoute(selected, choiceHref)));
    await waitFor(() => expect(reads).toBe(1));
    expect(host.textContent).toContain(m.people_current_visit_global_selected({}, options));
  } finally {
    await import('react').then(({ act }) => act(async () => root.unmount()));
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
