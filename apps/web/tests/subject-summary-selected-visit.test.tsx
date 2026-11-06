import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { fromPlainText } from '@rezics/document';
import { createKernelClient } from '@rezics/client';
import { authoredFixture } from '../src/kernel/fake/authored-field';
import { readAuthoredField, type AuthoredAddress, type AuthoredRead } from '../src/features/catalogue/authored-field';
import { candidateContext } from '../src/subject/candidates';
import { subjectVisitReturn, summaryReadingFragment } from '../src/features/pages/subject-visit-navigation';
import { synopsisVisitHref } from '../src/features/pages/subject-summary-reading/visit';
import { subjectHref } from '../src/subject/subject-href';
import definitions from '../src/kernel/recorded/definitions-release.json';
import * as start from '../.storybook/react-start';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const composition = {
  root: { props: {} },
  content: [{ type: 'Summary', props: { id: 'about' } }],
} satisfies CompositionDocument;

test('selected second synopsis traverses authored inspection and fresh return; unsupported and changed visits never substitute a Global default', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/subjects/reading' });
  const globals = {
    ...Object.fromEntries(
      'document navigator HTMLElement HTMLInputElement Element Node Text NodeFilter Document DocumentFragment ShadowRoot DOMParser MutationObserver ResizeObserver Range DOMRect'
        .split(' ')
        .map((name) => [name, Reflect.get(window, name)]),
    ),
    window,
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const fixture = authoredFixture();
  fixture.old.rank = 'preferred';
  const second = structuredClone(fixture.old);
  second.id = '00000000-0000-4000-8000-000000000102';
  const content = { document: '00000000-0000-4000-8000-000000000202', digest: 'c'.repeat(64), language: 'en' };
  second.value = { type: 'value', content };
  second.references = [];
  fixture.publicRead.subject.statements['schema:abstract'] = [fixture.old, second];
  fixture.documents.set(content.document, {
    ...[...fixture.documents.values()][0]!,
    ...content,
    id: content.document,
    candidateId: second.id,
    body: fromPlainText('The exact second synopsis.'),
  });
  const japanese = structuredClone(second);
  japanese.id = '00000000-0000-4000-8000-000000000103';
  const japaneseContent = { document: '00000000-0000-4000-8000-000000000203', digest: 'd'.repeat(64), language: 'ja' };
  const japaneseCitation = 'https://example.test/japanese-synopsis';
  japanese.value = { type: 'value', content: japaneseContent };
  japanese.references = [
    {
      hash: 'japanese-reference',
      parts: [
        { property: { id: 'schema:url', data_type: 'url' }, value: { type: 'value', content: japaneseCitation } },
      ],
    },
  ];
  fixture.publicRead.subject.statements['schema:abstract']!.push(japanese);
  fixture.documents.set(japaneseContent.document, {
    ...[...fixture.documents.values()][0]!,
    ...japaneseContent,
    id: japaneseContent.document,
    candidateId: japanese.id,
    body: fromPlainText('日本語の概要。'),
  });
  let held: { resolve: (read: AuthoredRead) => void; address: AuthoredAddress } | undefined;
  let holdNext = false;
  const noCommand = () => {
    throw new Error('Inspection cannot submit or confirm');
  };
  mock.module('../src/features/catalogue/authored-field-actions', () => ({
    loadAuthoredField: ({ data }: { data: AuthoredAddress }) => {
      if (holdNext) {
        holdNext = false;
        return new Promise<AuthoredRead>((resolve) => {
          held = { resolve, address: data };
        });
      }
      return readAuthoredField(fixture.client, data, 'en', 'Bearer fixture');
    },
    submitAuthoredField: noCommand,
    loadAuthoredReview: noCommand,
    confirmAuthoredField: noCommand,
  }));
  const sourceRequests: unknown[] = [];
  const sourcesClient = createKernelClient('http://sources.test', {
    fetch: (async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const supplied = url.searchParams.get('selectedSynopsis');
      const selected = supplied ? JSON.parse(supplied) : undefined;
      sourceRequests.push(selected);
      const live = fixture.publicRead.subject.statements['schema:abstract']!.find(
        (row) => row.id === selected?.statement,
      );
      const { rezics: _revision, ...fact } = live ?? second;
      const current = live?.value.type === 'value' ? (live.value.content as typeof content) : undefined;
      const matches =
        live &&
        current &&
        selected.document === current.document &&
        selected.digest === current.digest &&
        selected.language === current.language &&
        selected.release === fixture.publicRead.subject.release;
      return new Response(
        JSON.stringify({
          ...fixture.publicRead,
          ...(selected
            ? {
                selectedSynopsis: matches
                  ? {
                      kind: 'matched',
                      fact: { ...fact, value: { type: 'somevalue' } },
                      context: selected.context,
                      release: selected.release,
                    }
                  : { kind: 'changed' },
              }
            : {}),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch,
  });
  const { readSubjectSources } = await import('../src/features/catalogue/subject-sources');
  const sourceRead = ({ data }: { data: { id: string; locale: string; via?: string } }) =>
    readSubjectSources(sourcesClient, data.id, data.locale, undefined, false, data.via);
  let holdSourceRefresh = false;
  let failSourceRefresh = false;
  let releaseSource: (() => void) | undefined;
  mock.module('../src/features/catalogue/subject-sources-actions', () => ({
    loadSubjectSources: sourceRead,
    readCurrentSubjectSources: async (request: Parameters<typeof sourceRead>[0]) => {
      if (failSourceRefresh) return { kind: 'unavailable' };
      const result = await sourceRead(request);
      if (!holdSourceRefresh) return result;
      holdSourceRefresh = false;
      return new Promise<typeof result>((resolve) => {
        releaseSource = () =>
          resolve(
            result.kind === 'ready'
              ? { ...result, page: { ...result.page, title: { text: 'Late retired Sources' } } }
              : result,
          );
      });
    },
  }));
  const queries = await import('../src/features/pages/subject-queries');
  mock.module('../src/features/pages/subject-queries', () => ({
    ...queries,
    subjectRequestReader: async () => null,
  }));
  const { createRoot } = await import('react-dom/client');
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { pageDefinitions } = await import('../src/features/pages/layout');
  const { Route: AuthoredRoute } = await import('../src/routes/subjects/$id_.$slug_.authored');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, {
    state: 'signed-in',
    subject: fixture.transport.reader,
    csrfToken: 'visit-session',
  });
  const href = subjectHref({ id: fixture.id, label: 'The Little Prince' }, 'en').href;
  let visits = 0;
  function Reading() {
    visits++;
    const body = {
      ...fixture.publicRead,
      documents: Object.fromEntries(
        [...fixture.documents.values()].map((document) => [document.candidateId, document]),
      ),
    };
    const plan = planReads(platformRegistry, composition, { subject: fixture.id });
    return (
      <PageData
        locale="en"
        readingView="overview"
        subject={fixture.id}
        document={composition}
        reads={Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body }]))}
        reader={{ spoilerLevel: 0, suitability: 'blur' }}
        viewer={{
          state: 'account',
          account: fixture.transport.reader!,
          context: candidateContext,
          actions: { statementPropose: 'allowed' },
        }}
        messages={{
          unknown: 'Unknown',
          none: 'None',
          unlabelled: 'Unlabelled',
          sources: 'Sources',
          aliases: '',
          search: '',
          spoilerShow: 'Show spoilers',
        }}
      >
        <CompositionRender document={composition} definitions={pageDefinitions} components={dataComponents} />
      </PageData>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const workRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/en/subjects/$id/$slug',
    component: Reading,
  });
  const destination = AuthoredRoute.update({
    id: '/subjects/$id_/$slug_/authored',
    path: '/en/subjects/$id/$slug/authored',
    getParentRoute: () => rootRoute,
    loader: () => ({ id: fixture.id }),
  } as never);
  const { Route: SourcesRoute } = await import('../src/routes/subjects/$id_.$slug_.sources');
  const sources = SourcesRoute.update({
    id: '/subjects/$id_/$slug_/sources',
    getParentRoute: () => rootRoute,
    path: '/en/subjects/$id/$slug/sources',
  } as never);
  window.history.replaceState({}, '', href);
  const router = createRouter({
    routeTree: rootRoute.addChildren([workRoute, destination, sources]),
    history: createBrowserHistory({ window }),
    defaultPendingMinMs: 0,
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  // Browser anchor adapter: follow the actual mounted href through the destination router.
  host.addEventListener('click', (event: any) => {
    const link = event.target.closest('a');
    if (event.defaultPrevented || !link || event.button !== 0 || event.metaKey || event.ctrlKey) return;
    const target = link.getAttribute('href');
    if (target?.startsWith('/en/subjects/')) {
      event.preventDefault();
      void router.navigate({ to: target });
    }
  });
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(30);
    });
  };
  // A held refresh starts only after its native read resolves, which can outlast a fixed settle under load.
  const until = async (ready: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !ready(); attempt++)
      await act(async () => {
        await Bun.sleep(20);
      });
  };
  const navigate = async (to: string) => {
    await act(async () => {
      await router.navigate({ to });
    });
    await settle();
  };
  const click = async (link: Element) => {
    await act(async () => {
      await user.click(link);
    });
    await settle();
  };
  try {
    await act(async () => {
      await router.load();
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    });
    await settle();
    const chooser = host.querySelector('select')!;
    await act(async () => {
      await user.selectOptions(chooser, second.id);
    });
    const evidence = host.querySelector('#subject-summary-evidence')!;
    expect([...evidence.querySelectorAll('a')].some((link) => link.href.includes('via='))).toBe(true);
    expect(evidence.textContent).toContain(m.sources_no_citations());
    const general = [...evidence.querySelectorAll('a')].find(
      (link) => link.textContent === m.subject_synopsis_evidence(),
    )!;
    await click(general);
    expect(host.querySelector('[data-slot="subject-sources-detail"]')).not.toBeNull();
    expect(sourceRequests.at(-1)).toMatchObject({ statement: second.id, document: content.document, language: 'en' });
    expect(host.textContent).toContain(m.sources_no_citations());
    expect(host.textContent).not.toContain('The exact second synopsis.');
    expect(host.textContent).not.toContain(content.document);
    expect(host.innerHTML).not.toContain(content.document);
    expect(host.innerHTML).not.toContain(content.digest);
    const session = (subject: string, token: string) => ({ state: 'signed-in', subject, csrfToken: token });
    holdSourceRefresh = true;
    await act(async () => client.setQueryData(sessionQuery.queryKey, session(fixture.transport.reader!, 'held-a')));
    await until(() => releaseSource !== undefined);
    expect(releaseSource).toBeDefined();
    for (const subject of ['another-reader', fixture.transport.reader!]) {
      await act(async () => client.setQueryData(sessionQuery.queryKey, session(subject, 'held-a')));
      await settle();
      expect(host.querySelector('[data-slot="subject-sources-detail"]')).not.toBeNull();
    }
    await act(async () => releaseSource!());
    await settle();
    expect(host.textContent).not.toContain('Late retired Sources');
    failSourceRefresh = true;
    await act(async () => client.setQueryData(sessionQuery.queryKey, session(fixture.transport.reader!, 'retry-a')));
    await settle();
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.sources_retry())!;
    expect(retry).toBeDefined();
    failSourceRefresh = false;
    await act(async () => {
      retry.focus();
      await user.keyboard('{Enter}');
    });
    await settle();
    expect(sourceRequests.at(-1)).toMatchObject({ statement: second.id, document: content.document });
    expect(
      window.document.activeElement === host.querySelector('[data-slot="view-heading"] h1'),
      window.document.activeElement?.outerHTML,
    ).toBe(true);
    await click([...host.querySelectorAll('a')].find((link) => link.textContent === m.subject_synopsis_return())!);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe(second.id);
    expect(window.document.activeElement?.id).toBe('subject-summary-evidence');
    await act(async () => user.selectOptions(host.querySelector('select')!, japanese.id));
    await settle();
    await click(
      [...host.querySelectorAll('#subject-summary-evidence a')].find(
        (link) => link.textContent === m.subject_synopsis_evidence(),
      )!,
    );
    expect(sourceRequests.at(-1)).toMatchObject({
      statement: japanese.id,
      document: japaneseContent.document,
      language: 'ja',
    });
    expect(host.textContent).toContain(japaneseCitation);
    expect(host.textContent).not.toContain('日本語の概要。');
    await click([...host.querySelectorAll('a')].find((link) => link.textContent === m.subject_synopsis_return())!);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe(japanese.id);
    await act(async () => user.selectOptions(host.querySelector('select')!, second.id));
    await settle();
    const correction = [...host.querySelectorAll('a')].find((link) => link.textContent === m.correction_title())!;
    const selectedAddress = correction.getAttribute('href')!;
    expect(selectedAddress).toContain('via=');
    await click(correction);
    expect(host.textContent).toContain('The exact second synopsis.');
    expect(host.textContent).not.toContain('An aviator meets');
    expect(host.querySelector('.ProseMirror')?.textContent).toBe('');
    expect(fixture.calls.filter((call) => call.path.startsWith('/v1/documents/')).at(-1)?.path).toEndWith(
      '00000000-0000-4000-8000-000000000202',
    );
    expect(host.textContent).toContain(m.authored_no_citations());
    const beforeReturn = visits;
    await click([...host.querySelectorAll('a')].find((link) => link.textContent === m.subject_synopsis_return())!);
    expect(visits).toBeGreaterThan(beforeReturn);
    expect((host.querySelector('select') as HTMLSelectElement).value).toBe(second.id);
    expect(window.document.activeElement?.id).toBe('subject-summary-reading');

    const selection = {
      candidateId: second.id,
      documentId: content.document,
      digest: content.digest,
      language: 'en',
      locale: 'en',
    };
    const fragment = summaryReadingFragment({
      ...selection,
      context: candidateContext,
      release: definitions.digest,
      focus: 'reading',
    })!;
    const selectedVia = `${href}${fragment}`;
    const realm = '00000000-0000-4000-8000-000000000301';
    const realmFragment = summaryReadingFragment({ ...selection, context: realm, realm })!;
    const realmAddress = `${href}/authored?${new URLSearchParams({ property: 'schema:abstract', via: `${href}?realm=${realm}${realmFragment}` })}`;
    const calls = fixture.calls.length;
    await navigate(realmAddress);
    expect(host.textContent).toContain(m.subject_synopsis_global_only());
    expect(host.querySelector('.ProseMirror')).toBeNull();
    expect(fixture.calls.length).toBe(calls);

    await navigate(
      `${href}/authored?${new URLSearchParams({ property: 'schema:abstract', via: selectedVia })}&via=broken`,
    );
    expect(host.textContent).toContain(m.subject_synopsis_visit_invalid());
    expect(fixture.calls.length).toBe(calls);
    second.value = { type: 'value', content: { ...content, digest: 'e'.repeat(64) } };
    await navigate(selectedAddress);
    expect(host.textContent).toContain(m.subject_synopsis_visit_changed());
    expect(host.querySelector('.ProseMirror')).toBeNull();
    const current = [...host.querySelectorAll('a')].find(
      (link) => link.textContent === m.subject_synopsis_current_field(),
    )!;
    expect(current.getAttribute('href')).not.toContain('via=');
    await click(current);
    expect(host.textContent).toContain('An aviator meets');

    second.value = { type: 'value', content };
    holdNext = true;
    await navigate(selectedAddress);
    expect(held).toBeDefined();
    await navigate(realmAddress);
    await act(async () => {
      held!.resolve(await readAuthoredField(fixture.client, held!.address, 'en', 'Bearer fixture'));
    });
    await settle();
    expect(host.textContent).toContain(m.subject_synopsis_global_only());
    expect(host.textContent).not.toContain('The exact second synopsis.');

    const beforeOversized = sourceRequests.length;
    await navigate(`${href}/sources?${new URLSearchParams({ via: selectedVia, extra: 'x'.repeat(2048) })}`);
    expect(sourceRequests.length).toBe(beforeOversized);
    expect(host.textContent).toContain(m.sources_unavailable());
    expect(host.innerHTML).not.toContain(content.document);

    const encodedFragment = summaryReadingFragment({
      ...selection,
      documentId: '字'.repeat(128),
      context: candidateContext,
    });
    expect(encodedFragment).toBeDefined();
    expect(synopsisVisitHref(`${href}/authored`, `${href}${encodedFragment}`, 'en')).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 20_000);
