import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, StrictMode, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fromMarkdown, fromPlainText, parseDocument, withDocumentIds, type DocumentNode } from '@rezics/document';
import * as start from '../.storybook/react-start';
import * as outlines from '../src/threads/post-reading-outline';
import { PostReadingBody } from '../src/threads/post-reading-body';
import { PostReadingPosition } from '../src/threads/post-reading-position';
import { preparedPostReading } from '../src/stories/post-reading-fixtures';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const snapshot = (content: DocumentNode[]) => parseDocument({
  version: 'rezics-document-v1', profile: 'blocks', doc: withDocumentIds({ type: 'doc', content }),
});
const heading = (label: string, level = 2): DocumentNode => ({
  type: 'heading', attrs: { level }, content: [{ type: 'text', text: label }],
});

test('one bounded projection preserves visible hierarchy, duplicate positions, Unicode and truthful overflow', () => {
  for (const count of [1, 32, 100]) {
    const body = snapshot(Array.from({ length: count }, (_, index) => heading(`Section ${index}`, index % 3 + 1)));
    const outline = outlines.projectReadingOutline(body);
    expect(outline.entries).toHaveLength(count);
    expect(outline.byPosition.size).toBe(count);
    expect(outline.eligible).toBe(count);
    expect(outline.overflow).toBe(0);
  }
  const body = snapshot([
    heading('Root', 1), heading('Twin'), heading('Twin', 3),
    heading(`漢字${'é😀'.repeat(70)}`),
    { type: 'heading', attrs: { level: 2 }, content: [
      { type: 'text', text: 'Secret heading', marks: [{ type: 'spoiler' }] },
    ] },
    { type: 'heading', attrs: { level: 2 }, content: [
      { type: 'text', text: 'Visible link', marks: [{ type: 'link', attrs: { href: 'https://secret.test', title: 'Private title' } }] },
      { type: 'mention', attrs: { accountId: '0192f3a0-6c1e-7b2a-9d4e-000000000001' } },
    ] },
    { type: 'image', attrs: { src: 'private-image', alt: 'Private alt', conceal: true } },
    { type: 'codeBlock', content: [{ type: 'text', text: '# Not a heading\n'.repeat(10000) }] },
    ...Array.from({ length: 100 }, (_, index) => heading(`More ${index}`)),
  ]);
  const outline = outlines.projectReadingOutline(body);
  expect(outline.entries).toHaveLength(100);
  expect(outline.eligible).toBe(105);
  expect(outline.overflow).toBe(5);
  expect(outline.entries.slice(0, 3).map(({ depth }) => depth)).toEqual([0, 1, 2]);
  expect(outline.entries[1]!.position).not.toBe(outline.entries[2]!.position);
  expect(Array.from(outline.entries[3]!.label)).toHaveLength(120);
  expect(outline.entries[3]!.label.endsWith('…')).toBe(true);
  expect(JSON.stringify(outline)).not.toMatch(/Secret heading|Private alt|Private title|secret.test|private-image/);
  expect(outlines.projectReadingOutline(body, new Set([0])).eligible).toBe(106);
  expect(outlines.projectReadingOutline(fromPlainText('Ordinary reading')).entries).toEqual([]);
  for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es']) {
    const html = renderToStaticMarkup(<PostReadingBody document={body} locale={locale} />);
    expect(html).toContain('<h1');
    expect(html).not.toContain('data-slot="post-reading-sections"'); // script-free full reading
  }
});

test('existing admission still rejects oversized and over-depth snapshots before section projection', async () => {
  const { projectWriting, writingInspectionLimits } = await import('../src/threads/writing-inspection');
  const facts = { pendingUploads: 0, attachmentIssues: [], refusal: null, unknown: false, sending: false };
  const candidate = (node: DocumentNode) => ({
    version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [node] },
  });
  expect(projectWriting(candidate(heading('x'.repeat(writingInspectionLimits.bytes + 1))), null, facts))
    .toEqual({ ok: false, problem: 'size' });
  let nested = heading('Too deep');
  for (let index = 0; index < writingInspectionLimits.depth; index++) nested = { type: 'blockquote', content: [nested] };
  expect(projectWriting(candidate(nested), null, facts)).toEqual({ ok: false, problem: 'depth' });
  const image = mock(() => <span>Admitted image</span>);
  renderToStaticMarkup(<PostReadingBody document={snapshot([{ type: 'image', attrs: { src: 'native-id', alt: 'Original alt' } }])}
    renderImage={image} />);
  expect(image).toHaveBeenCalledWith({ mediaId: 'native-id', alt: 'Original alt' });
});

test('mounted published reader jumps, dismisses, returns and retires current/revision/viewer targets without requests', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/#post-retained', width: 1280, height: 900 });
  const globals = {
    window, document: window.document, navigator: window.navigator, location: window.location,
    HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, Element: window.Element,
    Node: window.Node, Document: window.Document, DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const prior = new Map([...Object.keys(globals), 'fetch', 'IntersectionObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const network = mock(() => { throw new Error('Sections must not fetch'); });
  const observer = mock(() => { throw new Error('No scroll observer is needed'); });
  globalThis.fetch = network as unknown as typeof fetch;
  Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: observer });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createRootRoute, createRouter, createMemoryHistory, RouterProvider } = await import('@tanstack/react-router');
  const { ThreadReading } = await import('../src/threads/thread-reading');
  const { ThreadReadingPost } = await import('../src/routes/threads/$id_.$slug');
  const { ExactRevisionView } = await import('../src/threads/exact-revision-view');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { default: userEvent } = await import(createRequire(require.resolve('storybook/test')).resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  setLocale('en', { reload: false });
  const supplied = preparedPostReading(1);
  const body = fromMarkdown('# Opening\n\nIntro >!ordinary secret!<\n\n## Twin\n\nFirst\n\n### Twin\n\nSecond\n\n## Public >!private title!<\n\nEnding', 'blocks');
  const post = { ...supplied.post, body };
  const page = { ...supplied.page, posts: { ...supplied.page.posts, posts: [post] } };
  const revision = supplied.revision.state === 'ready' ? { ...supplied.revision, revision: post } : supplied.revision;
  const identity = { postId: post.id, revisionId: post.revisionId };
  let update!: (view: { exact?: boolean; current?: boolean }) => void;
  function Journey() {
    const [view, setView] = useState<{ exact?: boolean; current?: boolean }>({ current: true });
    update = setView;
    return view.exact ? <ExactRevisionView identity={identity} page={revision} /> : <ThreadReading
      page={page} pageCurrent={view.current ?? true} Post={ThreadReadingPost} session="signed-out"
      personal={undefined} returnTo="/en/" signedOut="" renderHeader={() => <h1>Published visit</h1>}
      onMutation={async () => {}} onPageRefresh={async () => page} />;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const route = createRootRoute({ component: Journey });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (name: string) => Array.from(window.document.querySelectorAll('button')).find(node =>
    node.textContent === name || node.getAttribute('aria-label') === name)!;
  const sections = () => window.document.querySelector<HTMLElement>('nav[aria-label="Sections"]')!;
  const click = async (element: Element) => { await act(async () => { await user.click(element); }); };
  const projection = spyOn(outlines, 'projectReadingOutline');
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>));
    const reading = () => host.querySelector<HTMLElement>('[data-slot="post-reading-body"]')!;
    const originalTargets = Array.from(reading().querySelectorAll<HTMLHeadingElement>('h1,h2,h3'));
    const margins: string[] = [];
    const scrolls = originalTargets.map(target => {
      const scroll = mock(() => { margins.push(target.style.scrollMarginBlockStart); });
      target.scrollIntoView = scroll;
      return scroll;
    });
    const projected = projection.mock.calls.length;
    expect(projected).toBeGreaterThan(0);
    window.scrollTo({ top: 310 });
    const scrollBack = spyOn(window, 'scrollTo');
    await click(button(m.post_sections_title()));
    expect(sections().textContent).not.toContain('private title');
    expect(sections().querySelectorAll('li')).toHaveLength(3);
    await click(sections().querySelectorAll('button')[2]!);
    expect(scrolls[2]).toHaveBeenCalledTimes(1);
    expect(margins[0]).toContain('calc(6rem');
    expect(originalTargets[2]!.style.scrollMarginBlockStart).toBe('');
    expect(window.document.activeElement).toBe(originalTargets[2]);
    expect(window.location.hash).toBe('#post-retained');
    await click(button(m.post_sections_return()));
    expect(scrollBack).toHaveBeenLastCalledWith({ left: 0, top: 310, behavior: 'instant' });
    expect(window.document.activeElement).toBe(reading());
    expect(button(m.post_sections_return())).toBeUndefined();
    await click(button(m.post_sections_title()));
    await act(async () => { await user.keyboard('{Escape}'); });
    expect(window.document.activeElement).toBe(button(m.post_sections_title()));
    expect(projection.mock.calls.length).toBe(projected);
    // The live renderer, rather than opening Sections, supplies disclosure changes.
    const revealButtons = Array.from(reading().querySelectorAll('button')).filter(node => node.getAttribute('aria-label') === m.thread_reveal_spoiler());
    await click(revealButtons[1]!);
    await click(button(m.post_sections_title()));
    expect(sections().textContent).toContain('Public private title');
    await click(button(m.post_sections_close()));
    const oldIds = originalTargets.map(node => node.id).filter(Boolean);
    await act(async () => update({ exact: true }));
    expect(Array.from(reading().querySelectorAll('h1,h2,h3')).some(node => oldIds.includes(node.id))).toBe(false);
    expect(button(m.post_sections_return())).toBeUndefined();
    expect(reading().querySelector('.document-spoiler-revealed')).toBeNull();
    await act(async () => update({ current: false }));
    expect(button(m.post_sections_title())).toBeUndefined();
    await act(async () => update({ current: true }));
    expect(button(m.post_sections_return())).toBeUndefined();
    expect(reading().querySelector('.document-spoiler-revealed')).toBeNull();
    // Disappeared target: truthful unavailable status and current reader fallback, never another heading.
    const removed = reading().querySelector<HTMLHeadingElement>('h2')!;
    await click(button(m.post_sections_title()));
    removed.remove();
    await click(sections().querySelectorAll('button')[1]!);
    expect(host.textContent).toContain(m.post_sections_unavailable());
    expect(window.document.activeElement).toBe(reading());
    // The same snapshot under another viewer/source visit cannot revive labels or return state.
    let source = {};
    await act(async () => root.render(<PostReadingBody document={body} readerIdentity={source} />));
    const headingReveal = reading().querySelector('h2 button')!;
    await click(headingReveal);
    await click(button(m.post_sections_title()));
    expect(sections().textContent).toContain('private title');
    const oldSource = source;
    source = {};
    await act(async () => root.render(<PostReadingBody document={body} readerIdentity={source} />));
    await act(async () => root.render(<PostReadingBody document={body} readerIdentity={oldSource} />));
    await click(button(m.post_sections_title()));
    expect(sections().textContent).not.toContain('private title');
    await click(button(m.post_sections_close()));
    for (const count of [1, 32, 100, 103]) {
      const scale = snapshot(Array.from({ length: count }, (_, index) => heading(`Scale ${index}`)));
      await act(async () => root.render(<StrictMode><PostReadingBody document={scale} /></StrictMode>));
      expect(host.querySelectorAll('h2[id]')).toHaveLength(Math.min(count, 100));
      await click(button(m.post_sections_title()));
      expect(sections().querySelectorAll('li')).toHaveLength(Math.min(count, 100));
      if (count > 100) expect(sections().textContent).toContain(m.post_sections_overflow({ count: 3 }));
      await click(button(m.post_sections_close()));
    }
    expect(network).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  } finally {
    projection.mockRestore();
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    await window.happyDOM.close();
    for (const [key, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('queued jump and return cannot run after retirement, including a guard that later becomes current', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/' });
  const container = window.document.createElement('div');
  container.style.overflowY = 'auto';
  container.scrollTop = 60;
  const root = window.document.createElement('section');
  root.tabIndex = -1;
  const target = window.document.createElement('h2');
  target.tabIndex = -1;
  root.append(target);
  container.append(root);
  window.document.body.append(container);
  const jump = mock(() => {});
  target.scrollIntoView = jump;
  const returning = spyOn(window, 'scrollTo');
  try {
    const live = new PostReadingPosition();
    live.setRoot(root);
    live.connect();
    live.bind(0, target);
    live.open();
    live.choose(0);
    expect(live.complete()).toBe('jumped');
    container.scrollTop = 90;
    live.requestReturn();
    expect(live.complete()).toBe('returned');
    expect(container.scrollTop).toBe(60);
    live.retire();
    for (const kind of ['jump', 'return']) {
      let current = true;
      const position = new PostReadingPosition();
      position.setRoot(root);
      position.setGuard(() => current);
      position.connect();
      position.bind(0, target);
      expect(position.open()).toBe(true);
      position.choose(0);
      if (kind === 'return') {
        expect(position.complete()).toBe('jumped');
        expect(position.canReturn).toBe(true);
        expect(position.requestReturn()).toBe(true);
      }
      const jumps = jump.mock.calls.length;
      const returns = returning.mock.calls.length;
      current = false;
      expect(position.complete()).toBeNull();
      current = true;
      position.connect();
      expect(position.complete()).toBeNull();
      expect(position.targetCount).toBe(0);
      expect(position.canReturn).toBe(false);
      expect(jump.mock.calls.length).toBe(jumps);
      expect(returning.mock.calls.length).toBe(returns);
    }
  } finally { await window.happyDOM.close(); }
});
