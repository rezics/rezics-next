import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import type { ChangeReactionInput } from '../src/threads/reaction-request';
import * as start from '../.storybook/react-start';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const sends: { data: ChangeReactionInput; headers: HeadersInit }[] = [];
let settle!: (result: { ok: false; reason: 'unavailable' }) => void;
mock.module('../src/threads/reactions', () => ({
  changeReaction: async (request: { data: ChangeReactionInput; headers: HeadersInit }) => {
    sends.push(request);
    if (sends.length === 1) return new Promise<{ ok: false; reason: 'unavailable' }>((resolve) => (settle = resolve));
    return { ok: false, reason: 'unavailable' };
  },
  readReaction: async () => ({ ok: false, reason: 'unavailable' }),
}));

// Composed controls keep their mounted state when a route or preview rebuilds an equal component registry.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/one/reading' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

function Probe() {
  const [count, setCount] = useState(0);
  return (
    <button type="button" data-slot="probe" onClick={() => setCount(count + 1)}>
      {`count ${count}`}
    </button>
  );
}

test('a composed control keeps its mounted state when its parent rebuilds an equal registry', async () => {
  const { createRoot } = await import('react-dom/client');
  const { CompositionRender } = await import('../src/features/pages/render');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  // The document and definitions are the same objects on every render; only the registry object is rebuilt.
  const pageDocument = { root: { props: {} }, content: [{ type: 'Probe', props: { id: 'probe' } }] };
  const definitions = [{ type: 'Probe' }];
  const render = () =>
    act(async () => {
      root.render(<CompositionRender document={pageDocument} definitions={definitions} components={{ Probe }} />);
    });

  await render();
  const button = host.querySelector<HTMLButtonElement>('button[data-slot="probe"]')!;
  await act(async () => button.click());
  expect(button.textContent).toBe('count 1');

  await render();
  expect(host.querySelector('button[data-slot="probe"]')).toBe(button);
  expect(button.textContent).toBe('count 1');
  await act(async () => root.unmount());
});

test('the default ThreadList keeps the original pending and uncertain reaction through equal route preview and Zone registries', async () => {
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { CompositionRender } = await import('../src/features/pages/render');
  const { PageData, dataComponents } = await import('../src/features/pages/data');
  const { layoutComponents, pageDefinitions } = await import('../src/features/pages/layout');
  const { SubjectCommunityContext } = await import('../src/features/pages/subject-community-view');
  const { m } = await import('../src/paraglide/messages.js');
  const id = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'original-csrf' });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const document = { root: { props: {} }, content: [{ type: 'ThreadList', props: { id: 'discussion', limit: 5 } }] };
  const community = {
    regions: {
      discussion: {
        state: 'ready' as const,
        context: { subjectId: subject, subjectLabel: 'Subject', place: { kind: 'global' as const, id: subject } },
        reactionsAsOf: { epoch: 1, position: '5' },
        next: null,
        threads: [
          {
            id,
            title: 'Discussion',
            authorId: 'author',
            boardId: subject,
            createdAt: '2026-11-04T00:00:00.000Z',
            summary: 'A native reading',
            licence: 'CC0-1.0',
            postRevisionId: id,
            reactions: { like: 2 },
            viewerReaction: null,
            actions: { reply: 'available' as const, reaction: 'available' as const, watch: null, overflow: false },
          },
        ],
      },
    },
    authors: {},
    now: '2026-11-04T00:00:00.000Z',
    reader: 'reader',
    sourceKey: 'same-native-reading',
  };
  const render = () =>
    act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SubjectCommunityContext.Provider value={community}>
            <PageData
              locale="en"
              subject={subject}
              subjectLabel="Subject"
              document={document}
              reads={{}}
              messages={{
                unknown: 'Unknown',
                none: 'None',
                unlabelled: 'Untitled',
                sources: 'Sources',
                aliases: 'Aliases',
                search: 'Search',
              }}
            >
              <CompositionRender
                document={document}
                definitions={pageDefinitions}
                components={{ ...layoutComponents, ...dataComponents }}
              />
            </PageData>
          </SubjectCommunityContext.Provider>
        </QueryClientProvider>,
      );
    });
  try {
    await render();
    const chip = host.querySelector<HTMLButtonElement>('[data-slot="reaction-chip"]')!;
    expect(chip).not.toBeNull();
    await act(async () => chip.click());
    expect(sends).toHaveLength(1);
    for (const _surface of ['route', 'preview', 'Zone']) {
      await render();
      expect(host.querySelector('[data-slot="reaction-chip"]')).toBe(chip);
      expect(chip.disabled).toBe(true);
      expect(sends).toHaveLength(1);
    }
    await act(async () => settle({ ok: false, reason: 'unavailable' }));
    await render();
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === m.editorial_retry(),
    )!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(sends[1]?.data).toMatchObject({ target: 'thread', id, kind: 'like', expectedReader: 'reader' });
    expect(new Headers(sends[1]?.headers).get('X-CSRF-Token')).toBe('original-csrf');
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
