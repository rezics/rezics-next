import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, createContext, useContext, type ReactNode } from 'react';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import * as start from '../.storybook/react-start';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import { addonProfileFixture, addonProfileId, addonWorkId } from '../src/kernel/fake/catalogue-addon-profile';
import {
  addonPublicCorrectionHref,
  addonPublicIntentFits,
  parseAddonPublicVisit,
  type AddonPublicOrigin,
} from '../src/features/catalogue/addon-public-visit';
import { candidateContext } from '../src/subject/candidates';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const base = `/en/subjects/${addonProfileId}/harbor-northern-lights/addon`;
const origin = (): AddonPublicOrigin => ({
  subject: addonProfileId,
  type: 'wd:Q209163',
  context: candidateContext,
  definition: addonProfileFixture().current.subject.release,
  returnHref: base.slice(0, -'/addon'.length),
});
const parse = (href: string) =>
  parseAddonPublicVisit(new URL(href, 'https://site.test').search, addonProfileId, 'en', base);

test('Addon outer intent is closed, same-Subject and same-locale, with complete encoded character and UTF-8 budgets', () => {
  const observed = origin();
  expect(parse(addonPublicCorrectionHref(base, observed))).toEqual({ kind: 'origin', origin: observed });
  expect(parse(base)).toBeUndefined();
  for (const value of [
    { ...observed, subject: addonWorkId },
    { ...observed, type: 'schema:VideoGame' },
    { ...observed, realm: addonWorkId },
    { ...observed, returnHref: observed.returnHref.replace('/en/', '/ja/') },
    { ...observed, returnHref: observed.returnHref.replace(addonProfileId, addonWorkId) },
    { ...observed, returnHref: observed.returnHref + '?via=' + encodeURIComponent(observed.returnHref) },
    { ...observed, returnHref: observed.returnHref + '?realm=' + addonWorkId + '&realm=' + addonWorkId },
    { ...observed, returnHref: observed.returnHref + '#connections' },
    { ...observed, returnHref: 'https://site.test' + observed.returnHref },
    { ...observed, definition: 'sha256:invalid' },
    { ...observed, selection: { field: 'schema:genre' } },
    { ...observed, returnHref: observed.returnHref + '界'.repeat(700) },
  ])
    expect(parse(`${base}?${new URLSearchParams({ origin: JSON.stringify(value) })}`)).toEqual({ kind: 'invalid' });
  const valid = addonPublicCorrectionHref(base, observed);
  for (const href of [
    valid + '&origin=!',
    valid + '&publicReturn=x',
    valid + '&work=a&work=b',
    base + '?origin=%E0%A4%A',
    base + '?context=' + candidateContext,
  ])
    expect(parse(href)).toEqual({ kind: 'invalid' });
  expect(
    parse(
      `${base}?${new URLSearchParams({ origin: JSON.stringify(observed).replace('"subject":', '"subject":"duplicate","subject":') })}`,
    ),
  ).toEqual({ kind: 'invalid' });
  expect(addonPublicIntentFits('界'.repeat(700))).toBe(false);
  expect(addonPublicIntentFits('a'.repeat(2048))).toBe(true);
  expect(parseAddonPublicVisit('', addonProfileId, 'en', base + '界'.repeat(220))).toEqual({ kind: 'invalid' });
  expect(addonPublicCorrectionHref(base, { ...observed, returnHref: observed.returnHref + '界'.repeat(700) })).toBe(
    base + '?origin=!',
  );
  const unicodeBase = base + '界'.repeat(180);
  expect(addonPublicCorrectionHref(unicodeBase, observed)).toBe(unicodeBase + '?origin=!');
  expect(
    parseAddonPublicVisit(new URL(valid, 'https://site.test').search, addonProfileId, 'en', base + 'x'.repeat(1800)),
  ).toEqual({ kind: 'invalid' });
});

test('the installed Addon entry, canonical route and supported session keep origin, refuse selected Context and acquire fresh Global/current public readings', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test' + base, width: 390 });
  const names =
    'window document navigator HTMLElement HTMLButtonElement HTMLInputElement HTMLSelectElement HTMLFormElement Element Node Document DocumentFragment ShadowRoot MutationObserver ResizeObserver getComputedStyle requestAnimationFrame cancelAnimationFrame scrollTo matchMedia IS_REACT_ACT_ENVIRONMENT'.split(
      ' ',
    );
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names)
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: name === 'window' ? window : name === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(window, name),
    });
  const { createRoot } = await import('react-dom/client');
  const { within, waitFor } = await import(
    createRequire(require.resolve('storybook/test')).resolve('@testing-library/dom')
  );
  const kernel = await import('../src/kernel/client');
  const originalKernel = { ...kernel };
  const fixture = addonProfileFixture();
  mock.module('../src/kernel/client', () => ({ ...originalKernel, kernelClient: () => fixture.client }));
  const { AddonProfileSession } = await import('../src/features/catalogue/addon-profile-session');
  const { AddonProfileEntry } = await import('../src/features/catalogue/addon-profile-entry');
  const { collectEditorialEntries } = await import('../src/features/catalogue/editorial-entry');
  const { SubjectPage, loadSubjectPage, pageContext } = await import('../src/features/pages/subject');
  const { subjectPageMessages } = await import('../src/features/pages/route-support');
  const { sessionQuery } = await import('../src/session/query');
  const { Route } = await import('../src/routes/subjects/$id_.$slug_.addon');
  const { getLocale, setLocale } = await import('../src/paraglide/runtime');
  const { m } = await import('../src/paraglide/messages');
  const oldLocale = getLocale();
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const reader = '00000000-0000-4000-8000-00000000f101';
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'first' });
  const host = window.document.createElement('main') as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const Content = createContext<ReactNode>(null);
  const router = createRouter({
    routeTree: createRootRoute({ component: () => useContext(Content) }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const render = async (node: ReactNode) =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Content.Provider value={node}>
            <RouterProvider router={router} />
          </Content.Provider>
        </QueryClientProvider>,
      );
      await router.load();
    });
  const observed = origin();
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Expected installed canonical loader');
  const load = (href: string, slug = 'harbor-northern-lights', id = addonProfileId) =>
    loader({
      params: { id, slug },
      location: { searchStr: new URL(href, window.location.origin).search, hash: '' },
    } as never);
  const supported = (visit = parse(addonPublicCorrectionHref(base, observed))) => (
    <AddonProfileSession id={addonProfileId} locale="en" visit={visit} />
  );
  const publicPage = () => {
    const page = structuredClone(recordedPage) as unknown as import('../src/features/pages/subject').SubjectPageData;
    page.subject = addonProfileId;
    page.catalogue = {
      state: 'released',
      type: observed.type,
      digest: observed.definition,
      definitions: fixture.release,
    };
    const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
    for (const [key, read] of Object.entries(plan.reads))
      if (read.kind === 'subject' && read.id === page.subject)
        page.reads[key] = { status: 200, body: structuredClone(fixture.current) };
    return page;
  };
  try {
    await render(
      <AddonProfileEntry id={addonProfileId} label="Harbor: Northern lights" locale="en" origin={observed} />,
    );
    const href = host.querySelector('a')!.getAttribute('href')!;
    await render(
      <SubjectPage
        page={publicPage()}
        locale="en"
        messages={subjectPageMessages()}
        currentHref={observed.returnHref}
        renderJsonLd={false}
      />,
    );
    const publicDom = within(window.document.body);
    await act(async () => publicDom.getByRole('button', { name: m.contribute_title() }).click());
    await act(async () => publicDom.getByText(m.contribute_edit(), { exact: true }).click());
    expect(window.document.querySelector('a[href*="/addon?origin="]')?.getAttribute('href')).toBe(href);

    expect(
      collectEditorialEntries(
        <AddonProfileEntry id={addonProfileId} label="Harbor: Northern lights" locale="en" origin={observed} />,
      ).entries[0]!.href,
    ).toBe(href);
    expect(await load(href)).toMatchObject({ id: addonProfileId, visit: { kind: 'origin', origin: observed } });
    await expect(load(href, 'old-label')).rejects.toMatchObject({ options: { statusCode: 301, href } });
    fixture.current.subject.id = addonWorkId;
    await expect(load(href)).rejects.toMatchObject({
      options: { href: `/en/subjects/${addonWorkId}/harbor-northern-lights/addon?origin=%21` },
    });
    fixture.current.subject.id = addonProfileId;

    const before = fixture.calls.length;
    await render(supported());
    await waitFor(() => expect(host.textContent).toContain(m.addon_base_current_title()));
    expect(fixture.calls.length).toBeGreaterThan(before);
    expect(within(host).getByRole('link', { name: m.addon_origin_return() }).getAttribute('href')).toBe(
      observed.returnHref,
    );
    const nonGlobal = { ...observed, context: addonWorkId };
    const selected = parse(addonPublicCorrectionHref(base, nonGlobal));
    const reads = fixture.calls.length;
    await render(supported(selected));
    expect(host.textContent).toContain(m.addon_origin_unsupported());
    expect(host.querySelector('input, select')).toBeNull();
    expect(fixture.calls).toHaveLength(reads);
    await render(
      supported(
        parse(
          addonPublicCorrectionHref(base, {
            ...observed,
            realm: addonWorkId,
            returnHref: `${observed.returnHref}?realm=${addonWorkId}`,
          }),
        ),
      ),
    );
    expect(host.textContent).toContain(m.addon_origin_unsupported());
    expect(fixture.calls).toHaveLength(reads);
    const globalHref = within(host).getByRole('link', { name: m.addon_origin_global() }).getAttribute('href')!;
    const globalUrl = new URL(globalHref, window.location.origin);
    expect(globalUrl.searchParams.has('origin')).toBe(false);
    // The deliberately unnamed Global address first redirects to the current canonical label.
    await expect(load(globalHref, globalUrl.pathname.split('/')[4])).rejects.toMatchObject({
      options: { statusCode: 301 },
    });
    await render(supported(parse(globalHref)));
    await waitFor(() => expect(host.textContent).toContain(m.addon_base_current_title()));
    expect(fixture.calls.length).toBeGreaterThan(reads);
    const control = within(host).getByRole('button', { name: m.correction_reload() });
    control.focus();
    await act(async () => control.click());
    expect(window.document.activeElement).toBe(control);
    await render(supported());
    fixture.current.subject.release = 'sha256:' + '0'.repeat(64);
    await act(async () => within(host).getByRole('button', { name: m.correction_reload() }).click());
    await waitFor(() => expect(host.textContent).toContain(m.addon_origin_changed()));
    fixture.current.subject.release = observed.definition;
    await act(async () => within(host).getByRole('button', { name: m.correction_reload() }).click());
    expect(host.textContent).toContain(m.addon_origin_changed());
    // Equal-principal credential replacement and origin A/B/A are new existing session lifetimes.
    await render(supported(selected));
    await act(async () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'second' }),
    );
    await render(supported());
    await waitFor(() =>
      expect(within(host).getByRole('heading', { name: m.addon_base_current_title() })).toBeDefined(),
    );
    expect(host.textContent).not.toContain(m.addon_origin_changed());
    for (const subject of ['00000000-0000-4000-8000-00000000f102', reader]) {
      const calls = fixture.calls.length;
      await act(async () =>
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject, csrfToken: 'second' }),
      );
      await waitFor(() =>
        expect(within(host).getByRole('heading', { name: m.addon_base_current_title() })).toBeDefined(),
      );
      expect(fixture.calls.length).toBeGreaterThan(calls);
    }
    await render(supported({ kind: 'invalid' }));
    expect(host.textContent).toContain(m.addon_origin_invalid());
    expect(host.querySelector('input, select')).toBeNull();
    await render(<AddonProfileSession id={addonProfileId} locale="en" />);
    await waitFor(() => expect(host.textContent).toContain(m.addon_base_current_title()));
    let publicReads = 0;
    const publicClient = createKernelClient('https://public.invalid', {
      fetch: (async () => {
        publicReads++;
        return Response.json(publicPage());
      }) as typeof fetch,
    });
    fixture.current.subject.labels.en = 'Current public heading';
    const returned = await loadSubjectPage(publicClient, addonProfileId);
    if (returned.kind !== 'page') throw new Error('Expected fresh public admission');
    await render(
      <SubjectPage page={returned.page} locale="en" messages={subjectPageMessages()} renderJsonLd={false} />,
    );
    expect(publicReads).toBe(1);
    expect(host.textContent).toContain('Current public heading');
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.module('../src/kernel/client', () => originalKernel);
    setLocale(oldLocale, { reload: false });
    await window.happyDOM.abort();
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
});
