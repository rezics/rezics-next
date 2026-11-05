import { createRequire } from 'node:module';
import { expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PeopleProfileEntry } from '../src/features/catalogue/people-profile-entry';
import { PeopleCurrentVisitView } from '../src/features/catalogue/people-current-visit-view';
import {
  peopleCurrentVisitGlobalHref,
  peopleCurrentVisitHref,
  peopleCurrentVisitReturnHref,
  validatePeopleCurrentVisitSearch,
} from '../src/features/catalogue/people-current-visit';
import { peoplePersonId, peopleProfileFixture } from '../src/kernel/fake/catalogue-people-profile';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));

const personId = '00000000-0000-4000-8000-000000000201';
const contextId = '00000000-0000-4000-8000-000000000202';
const realmId = '00000000-0000-4000-8000-000000000203';
const locale = 'en';
const options = { locale: locale as never };

function searchOf(href: string): Record<string, unknown> {
  return Object.fromEntries(new URL(href, 'https://rezics.invalid').searchParams.entries());
}

test('mounted Person entry and editorial menu preserve its origin and gate the existing editor', async () => {
  const entryElement = (
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
    />
  );
  const entry = renderToStaticMarkup(entryElement);
  const encodedHref = /href="([^"]+)"/u.exec(entry)?.[1];
  expect(encodedHref).toBeDefined();
  const href = encodedHref!.replaceAll('&amp;', '&');
  const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
  const menuEntry = collectEditorialEntries(entryElement).entries.find(
    (candidate) => candidate.label === m.people_profile_title({}, options),
  );
  expect(menuEntry?.href).toBe(href);
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

test('the selected Realm keeps the existing profile read idle until deliberate Global choice', async () => {
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const fixture = peopleProfileFixture('ready', locale, 'person');
  const unsupportedHref = peopleCurrentVisitHref({
    id: peoplePersonId,
    label: 'Mira Sato',
    locale,
    context: contextId,
    realm: realmId,
    definition: 'released:sha256:person-release-9',
    reader: 'public-reader-visit-9',
    sourceAddress: `/en/subjects/${peoplePersonId}/mira-sato?context=${contextId}&realm=${realmId}`,
  });
  const unsupportedRoute = new URL(unsupportedHref, 'https://rezics.invalid');
  const unsupported = validatePeopleCurrentVisitSearch(searchOf(unsupportedHref), peoplePersonId, locale);
  expect(unsupported.kind).toBe('origin');
  if (unsupported.kind !== 'origin') return;

  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: `https://site.test${unsupportedRoute.pathname}${unsupportedRoute.search}` });
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
            pathname={unsupportedRoute.pathname}
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
    await import('react').then(({ act }) => act(async () => renderRoute(unsupported, unsupportedRoute.href)));
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
