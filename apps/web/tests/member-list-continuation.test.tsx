import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { Section } from '../src/features/pages/overview';
import type { MemberListRequest } from '../src/features/pages/member-list-query';
import recording from '../src/kernel/recorded/library-collection-members.json';

// Authored for integration execution; uses the real default composition, not a replacement Members renderer.
test('Default composed member continuation announces actual unique additions and retains local keyboard navigation', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/library' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const requests: MemberListRequest[] = [];
  const responses: Array<Section | Promise<Section> | Error> = [];
  mock.module('cloudflare:workers', () => ({ env: {} }));
  mock.module('@tanstack/react-start', () => import('../.storybook/react-start'));
  mock.module('@tanstack/react-start/server', () => import('../.storybook/react-start'));
  mock.module('../src/features/pages/member-list-query', () => ({
    loadMemberList: async ({ data }: { data: MemberListRequest }) => {
      requests.push(data);
      const answer = responses.shift();
      if (!answer) throw new Error('Unexpected member read');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { userEvent } = await import('storybook/test');
  const { planReads, platformRegistry } = await import('@rezics/composition');
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { layoutComponents, PageRoot, pageDefinitions } = await import('../src/features/pages/layout');
  const { memberContinuationDocument } = await import('../src/kernel/fake/composed-member-list');
  const { sessionQuery } = await import('../src/session/query');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const viewer = { state: 'signed-in', subject: 'reader-one', csrfToken: null };
  client.setQueryData(sessionQuery.queryKey, viewer);
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let document = memberContinuationDocument;
  let target = { account: 'member-continuation' };
  let locale = 'en';
  let initial = { members: recording.members.slice(0, 1), next: 'opaque:next/==' };
  const read = Object.values(planReads(platformRegistry, document, { subject: null }).reads)[0]!;
  const page = (members: typeof recording.members, next: string | null): Section => ({
    ok: true,
    read,
    body: { members, next },
  });
  const render = async () => {
    const plan = planReads(platformRegistry, document, { subject: null });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <PageData
            locale={locale}
            document={document}
            pageTarget={target}
            reads={Object.fromEntries(Object.keys(plan.reads).map((key) => [key, { status: 200, body: initial }]))}
            messages={{ unknown: '', none: '', unlabelled: '', sources: '', aliases: '', search: '' }}
          >
            <CompositionRender
              document={document}
              definitions={pageDefinitions}
              components={{ ...layoutComponents, ...dataComponents }}
              root={PageRoot}
            />
          </PageData>
          <a href="#after">After the lists</a>
        </QueryClientProvider>,
      );
    });
  };
  const list = (node = document.content[0]!.props.id) =>
    host.querySelector(`[data-slot="member-list"][data-node="${node}"]`)!;
  const status = (node?: string) => list(node).querySelector('[aria-live="polite"]')!;
  const button = (node?: string) => list(node).querySelector('button')!;
  const flush = async () => {
    await act(async () => {
      await Bun.sleep(0);
    });
  };
  const press = async (trigger = button()) => {
    trigger.focus();
    await act(async () => {
      await userEvent.keyboard('{Enter}');
    });
    await flush();
  };
  const hold = () => {
    let release!: (section: Section) => void;
    responses.push(
      new Promise<Section>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  try {
    await render();
    expect(requests).toHaveLength(0);
    expect(status().textContent).toBe('');
    expect(status('other-members').textContent).toBe('');
    expect(list().getAttribute('aria-live')).toBeNull();
    const trigger = button();
    expect(trigger.className).toContain('min-h-11');
    expect(trigger.className).toContain('min-w-11');
    expect(trigger.className).toContain('whitespace-normal');
    expect(trigger.className).toContain('focus-visible:outline-2');
    expect(trigger.getAttribute('aria-describedby')).toBe(status().id);
    const release = hold();
    await press(trigger);
    expect(status().textContent).toBe('Loading more…');
    expect(trigger.getAttribute('aria-disabled')).toBe('true');
    expect(window.document.activeElement).toBe(trigger);
    await press(trigger); // Repeated activation cannot issue another read.
    expect(requests).toEqual([{ target, locale: 'en', node: 'members', cursor: 'opaque:next/==' }]);
    await act(async () => {
      release(page([recording.members[0]!, recording.members[1]!, recording.members[1]!], 'duplicates'));
    });
    await flush();
    expect(status().textContent).toBe('New visible items in Books: 1. You can load more.');
    expect(status().getAttribute('aria-atomic')).toBe('true');
    expect(window.document.activeElement).toBe(trigger);
    expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength(2);
    expect(list().textContent!.indexOf('Snow Country')).toBeLessThan(list().textContent!.indexOf('The Tale of Genji'));
    expect(status('other-members').textContent).toBe('');

    responses.push(page([recording.members[1]!], 'empty-end'));
    await press();
    expect(status().textContent).toBe('New visible items in Books: 0. You can load more.');
    expect(window.document.activeElement).toBe(trigger);
    responses.push(page([], 'other-end'));
    await press(button('other-members'));
    expect(status('other-members').textContent).toBe('New visible items in Other books: 0. You can load more.');
    const finish = hold();
    await press(trigger);
    const otherTrigger = button('other-members');
    otherTrigger.focus();
    await act(async () => {
      finish(page([], null));
    });
    await flush();
    expect(status().textContent).toBe('New visible items in Books: 0. End of this list.');
    expect(list().querySelector('button')).toBeNull();
    expect(window.document.activeElement).toBe(otherTrigger);
    responses.push(page([], null));
    await press(otherTrigger);
    const end = list('other-members').querySelector('[data-slot="member-list-end"]')!;
    expect(window.document.activeElement).toBe(end);
    await act(async () => {
      await userEvent.tab();
    });
    expect(window.document.activeElement?.textContent).toBe('After the lists');
    expect(requests.map(({ node, cursor }) => ({ node, cursor }))).toEqual([
      { node: 'members', cursor: 'opaque:next/==' },
      { node: 'members', cursor: 'duplicates' },
      { node: 'other-members', cursor: 'opaque:next/==' },
      { node: 'members', cursor: 'empty-end' },
      { node: 'other-members', cursor: 'other-end' },
    ]);

    // Each existing reading boundary retires status and ignores its late response, without moving focus.
    for (const boundary of ['target', 'node', 'section', 'viewer', 'locale']) {
      initial = { ...initial, next: `before-${boundary}` };
      await render();
      const late = hold();
      await press();
      if (boundary === 'target') target = { account: 'another-reader' };
      if (boundary === 'node')
        document = {
          ...document,
          content: document.content.map((node, i) =>
            i ? node : { ...node, props: { ...node.props, id: 'replacement' } },
          ),
        };
      if (boundary === 'section') initial = { ...initial, next: 'fresh-section' };
      if (boundary === 'viewer')
        await act(async () => {
          client.setQueryData(sessionQuery.queryKey, { ...viewer, subject: 'reader-two' });
        });
      if (boundary === 'locale') locale = 'fr';
      await render();
      expect(status().textContent).toBe('');
      const freshTrigger = button();
      freshTrigger.focus();
      await act(async () => {
        late(page([recording.members[2]!], null));
      });
      await flush();
      expect(status().textContent).toBe('');
      expect(list().textContent).not.toContain('The Little Prince');
      expect(list().querySelector('[data-slot="member-list-end"]')).toBeNull();
      expect(window.document.activeElement).toBe(freshTrigger);
    }

    // Native refusal semantics: transient/invalid responses keep rows/cursor; retired readings restart.
    locale = 'en';
    for (const code of [202, 400, 422, 503, 401, 403, 404, 409]) {
      initial = { ...initial, next: `refusal-${code}` };
      await render();
      responses.push({ ok: false, status: code });
      await press();
      if (code === 404) {
        expect(host.querySelector(`[data-node="${document.content[0]!.props.id}"]`)).toBeNull();
        continue;
      }
      expect(status().textContent).toBe(code === 202 ? 'These results are being prepared.' : '');
      expect(list().querySelectorAll('[data-slot="cover-card"]')).toHaveLength([401, 403, 409].includes(code) ? 0 : 1);
      responses.push(page([], null));
      await press();
      expect(requests.at(-1)?.cursor).toBe([401, 403, 409].includes(code) ? undefined : `refusal-${code}`);
      expect(status().textContent).toContain('0. End of this list.');
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    mock.restore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
