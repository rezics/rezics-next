import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createKernelClient } from '@rezics/client';
import { createPublicationDraft } from '../src/community/publication-subject-picker';
import { changePublication } from '../src/community/publication-controls';
import {
  readPublicationPreparation,
  type PublicationPrepare,
  type PublicationPresentation,
} from '../src/community/realm-publication-preparation';
import { preparationFixture } from './realm-publication-preparation-fixture';
import * as start from '../.storybook/react-start';

const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000040';
const reader = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const head = '0192f3a0-6c1e-7b2a-9d4e-000000000030';
const terminal = '0192f3a0-6c1e-7b2a-9d4e-000000000041';
const work = {
  id: subjectId,
  title: 'Picker disclosure',
  label: 'Picker disclosure',
  labels: { en: 'Picker disclosure' },
  types: ['schema:Book'],
  cover: null,
};
const presentation: PublicationPresentation = {
  label: { state: 'available', value: 'Current native label', language: 'en' },
  cover: {
    state: 'available',
    value: {
      media: terminal,
      width: 320,
      height: 480,
      placeholder: { color: '#123456', thumbhash: '' },
      variants: [{ format: 'webp', width: 320 }],
      focalPoint: null,
      credit: {
        rightsHolder: 'Native image artist',
        via: { name: 'Image source', url: 'https://example.com/source' },
        license: 'CC-BY-4.0',
        obligations: ['Retain this attribution.'],
      },
    },
  },
};
async function shape(verdict: 'adopt' | 'reject' | 'withdraw' | null = 'adopt', display = presentation) {
  const result = await preparationFixture(
    reader,
    () => (verdict === null ? null : head),
    verdict ?? 'adopt',
    display,
  )({ realmId, subjectId });
  if (result.kind !== 'ready') throw new Error('Fixture must be ready');
  result.preparation.subject.currentId = terminal;
  return result.preparation;
}
function nativeClient(handle: (request: Request) => Response | Promise<Response>) {
  return createKernelClient('https://kernel.example', {
    fetch: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => handle(new Request(input, init)), {
      preconnect() {},
    }),
  });
}

test('installed preparation uses one authenticated generated GET and preserves independent producer variants and exact projected bytes', async () => {
  for (const shelfSize of [1, 100, 1000]) {
    const payload = await shape();
    const requests: Request[] = [];
    const client = nativeClient((request) => {
      requests.push(request);
      return Response.json({ preparation: payload });
    });
    const draft = createPublicationDraft(
      realmId,
      async () => ({ kind: 'denied' }),
      () => {},
      () => Array.from({ length: shelfSize }, () => ({ ...work, publicationId: 'unused-shelf-head' })),
      true,
      undefined,
      (input) => readPublicationPreparation(client, 'Bearer curator', input),
    );
    await draft.choose(work);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('GET');
    expect(new URL(requests[0]!.url).pathname).toBe(`/v1/realms/${realmId}/publications/${subjectId}/preparation`);
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer curator');
    const projected = draft.getSnapshot().preparation!;
    expect(projected).toEqual(payload);
    expect(new TextEncoder().encode(JSON.stringify(projected)).byteLength).toBe(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength,
    );
    expect(JSON.stringify(draft.getSnapshot())).not.toContain(work.title);
    draft.retire();
  }
  // Shelf sizes are not detail-field counts. The installed producer has no detail-field collection.
  let status = 503;
  const client = nativeClient(() => Response.json({}, { status }));
  expect(await readPublicationPreparation(client, null, { realmId, subjectId })).toEqual({ kind: 'denied' });
  for (const denied of [401, 403, 404]) {
    status = denied;
    expect(await readPublicationPreparation(client, 'Bearer curator', { realmId, subjectId })).toEqual({
      kind: 'denied',
    });
  }
  status = 503;
  expect(await readPublicationPreparation(client, 'Bearer curator', { realmId, subjectId })).toEqual({
    kind: 'unavailable',
  });
  const aborted = new AbortController();
  aborted.abort();
  let touches = 0;
  const untouched = nativeClient(() => {
    touches++;
    return Response.json({ preparation: {} });
  });
  expect(await readPublicationPreparation(untouched, 'Bearer curator', { realmId, subjectId }, aborted.signal)).toEqual(
    { kind: 'unavailable' },
  );
  expect(touches).toBe(0);
});

test('mounted selected review renders only current generated disclosure, seals unknown intent, reinspects conflicts and retires late focus', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/spaces/atlas' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { act, StrictMode } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { PublicationControls, usePublicationControls } = await import('../src/community/publication-controls-view');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale, overwriteGetLocale } = await import('../src/paraglide/runtime.js');
  const previousLocale = getLocale;
  overwriteGetLocale(() => 'en');
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  query.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: reader, csrfToken: 'csrf' });
  let payload = await shape();
  let commandStatus = 503;
  let reads = 0;
  const writes: { method: string; path: string; body: string; key: string | null; precondition: string | null }[] = [];
  let holdRead: ((response: Response) => void) | undefined;
  let delayRead = false;
  const client = nativeClient(async (request) => {
    if (request.method === 'GET') {
      reads++;
      if (delayRead)
        return new Promise<Response>((resolve) => {
          holdRead = resolve;
        });
      return Response.json({ preparation: payload });
    }
    writes.push({
      method: request.method,
      path: new URL(request.url).pathname,
      body: await request.text(),
      key: request.headers.get('idempotency-key'),
      precondition: request.headers.get('if-match'),
    });
    return Response.json(commandStatus === 200 ? { publication: { publicationId: head } } : {}, {
      status: commandStatus,
    });
  });
  const prepare: PublicationPrepare = (input) => readPublicationPreparation(client, 'Bearer curator', input);
  const send = (input: Parameters<typeof changePublication>[2]) => changePublication(client, 'Bearer curator', input);
  let source = {};
  let control!: ReturnType<typeof usePublicationControls>;
  function Harness() {
    control = usePublicationControls(realmId, send, () => {}, [], true, reader, prepare, source);
    return <PublicationControls control={control} refresh={async () => {}} />;
  }
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const paint = () =>
    act(async () =>
      root.render(
        <StrictMode>
          <QueryClientProvider client={query}>
            <Harness />
          </QueryClientProvider>
        </StrictMode>,
      ),
    );
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
  const click = (label: string) => act(async () => button(label).click());
  try {
    await paint();
    await click(m.realm_publication_curate());
    for (const verdict of [null, 'adopt', 'reject', 'withdraw'] as const) {
      payload = await shape(verdict);
      const before = reads;
      await act(async () => control.choose(work));
      expect(reads - before).toBe(1);
      expect(writes).toHaveLength(0);
      expect(host.textContent).toContain(
        verdict === null
          ? m.realm_publication_no_decision()
          : verdict === 'adopt'
            ? m.realm_publication_current_adopted()
            : verdict === 'reject'
              ? m.realm_publication_current_rejected()
              : m.realm_publication_current_withdrawn(),
      );
      expect(host.textContent).toContain(subjectId);
      expect(host.textContent).toContain(terminal);
      expect(host.textContent).toContain('Current native label');
      expect(host.textContent).not.toContain(work.title);
      expect(host.textContent).toContain('Retain this attribution.');
      expect(host.querySelector('img')?.getAttribute('src')).toContain(terminal);
      expect(button(m.realm_publication_review_withdraw()).disabled).toBe(verdict === null);
    }
    for (const [label, cover] of [
      ['concealed', 'available'],
      ['available', 'concealed'],
      ['empty', 'unavailable'],
      ['unavailable', 'empty'],
    ] as const) {
      payload = await shape('adopt', {
        label: label === 'available' ? presentation.label : { state: label },
        cover: cover === 'available' ? presentation.cover : { state: cover },
      });
      await act(async () => control.inspect());
      expect(host.textContent?.includes('Current native label')).toBe(label === 'available');
      expect(host.querySelector('img') !== null).toBe(cover === 'available');
      expect(host.textContent?.includes('Retain this attribution.')).toBe(cover === 'available');
      expect(
        host.querySelector('[data-publication-label]')?.getAttribute('data-publication-label') ?? 'available',
      ).toBe(label);
      expect(
        host.querySelector('[data-publication-cover]')?.getAttribute('data-publication-cover') ?? 'available',
      ).toBe(cover);
    }
    payload = await shape();
    await act(async () => control.inspect());
    await click(m.realm_publication_review_withdraw());
    expect(writes).toHaveLength(1);
    const original = structuredClone(writes[0]!);
    payload = await shape('withdraw'); // Even a matching current verdict does not resolve a lost write.
    payload.current!.publicationId = terminal;
    for (const command of Object.values(payload.commands))
      if (command) {
        command.expectedHead = terminal;
        command.ifMatch = JSON.stringify(terminal);
      }
    const before = reads;
    await click(m.realm_publication_read());
    expect(reads - before).toBe(1);
    expect(control.outcome?.kind).toBe('unavailable');
    await act(async () => control.change('reject'));
    expect(writes).toHaveLength(1);
    await click(m.realm_publication_curate()); // Closing review keeps the original retry accessible.
    commandStatus = 412;
    await click(m.realm_publication_retry());
    expect(writes[1]).toEqual(original);
    expect(control.preparation).toBeNull();
    await click(m.realm_publication_review());
    expect(writes).toHaveLength(2);
    await click(m.realm_publication_curate());
    commandStatus = 200;
    await click(m.realm_publication_review_reject());
    expect(writes).toHaveLength(3);
    expect(writes[2]!.key).not.toBe(original.key);
    expect(writes[2]!.precondition).toBe(JSON.stringify(terminal));
    // Reinspection is supported after readback; the command still reauthorizes on execution.
    await click(m.realm_publication_read());
    commandStatus = 404;
    await click(m.realm_publication_review_withdraw());
    expect(control.outcome?.kind).toBe('denied');

    await act(async () => control.choose(work));
    const retired = control;
    delayRead = true;
    await act(async () => {
      void control.inspect();
    });
    expect(host.textContent).not.toContain('Current native label');
    button(m.realm_publication_curate()).focus();
    const focused = document.activeElement;
    source = {}; // A replacing source/disclosure observation retires the complete category.
    await paint();
    await act(async () => {
      holdRead!(Response.json({ preparation: payload }));
    });
    expect(control.target).toBeNull();
    expect(button(m.realm_publication_curate()).getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('Current native label');
    expect(document.activeElement === focused || document.activeElement === document.body).toBe(true);
    await act(async () => {
      void retired.change('publish');
      void retired.retry();
    });
    expect(writes).toHaveLength(4);
    expect(
      query
        .getQueryCache()
        .getAll()
        .map((entry) => entry.queryKey),
    ).toEqual([sessionQuery.queryKey]);
  } finally {
    await act(async () => root.unmount());
    query.clear();
    host.remove();
    overwriteGetLocale(previousLocale);
    mock.restore();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
