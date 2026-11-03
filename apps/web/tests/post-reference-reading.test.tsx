import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseDocument, withDocumentIds, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import * as start from '../.storybook/react-start';
import { PostReadingBody, ThreadPostReadingBody } from '../src/threads/post-reading-body';
import { projectPostReading } from '../src/threads/post-reference-list';
import { preparedPostReading } from '../src/stories/post-reading-fixtures';
import { m } from '../src/paraglide/messages.js';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const snapshot = (content: DocumentNode[]): DocumentSnapshot =>
  parseDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: withDocumentIds({ type: 'doc', content }),
  });
const link = (text: string, href: string, title?: string): DocumentNode => ({
  type: 'paragraph',
  content: [
    {
      type: 'text',
      text,
      marks: [{ type: 'link', attrs: { href, ...(title ? { title } : {}) } }],
    },
  ],
});
const entryName = (number: number, label: string) => m.post_references_entry({ number, label });

test('one disclosure-aware projection bounds authored occurrences and preserves exact destinations', () => {
  for (const count of [1, 16, 64, 67]) {
    const body = snapshot(Array.from({ length: count }, () => link('same label', 'https://same.example/x?q=1#part')));
    const projection = projectPostReading(body);
    expect(projection.references.eligible).toBe(count);
    expect(projection.references.entries).toHaveLength(Math.min(count, 64));
    expect(projection.references.overflow).toBe(Math.max(0, count - 64));
    expect(new Set(projection.references.entries.map(({ position }) => position)).size).toBe(Math.min(count, 64));
    expect(new Set(projection.references.entries.map(({ href }) => href)).size).toBe(1);
  }

  const hidden = 'The hidden reference label';
  const hiddenHref = 'https://private.example/hidden?token=private#part';
  const body = snapshot([
    link('Contact', 'mailto:reader@example.test?subject=Question%20one'),
    link('A matching display label', 'https://source.example/article?edition=a#quoted'),
    link('A matching display label', 'https://source.example/article?edition=b#quoted'),
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: hidden,
          marks: [
            { type: 'link', attrs: { href: hiddenHref, title: 'Hidden title' } },
            { type: 'spoiler' },
          ],
        },
      ],
    },
    link('Unsupported scheme', 'javascript:alert(1)'),
    {
      type: 'paragraph',
      content: [
        {
          type: 'mention',
          attrs: { accountId: '0192f3a0-6c1e-7b2a-9d4e-000000000001' },
          marks: [{ type: 'link', attrs: { href: 'https://mention.example/profile' } }],
        },
        { type: 'image', attrs: { src: 'media-id', alt: 'Image links are outside this list' } },
      ],
    },
  ]);
  const projection = projectPostReading(body);
  expect(projection.references.entries.map(({ href }) => href)).toEqual([
    'mailto:reader@example.test?subject=Question%20one',
    'https://source.example/article?edition=a#quoted',
    'https://source.example/article?edition=b#quoted',
  ]);
  expect(projection.references.entries[0]).toMatchObject({ destination: 'email', location: '' });
  expect(projection.references.entries[1]).toMatchObject({ destination: 'web', location: 'source.example' });
  expect(JSON.stringify(projection.references)).not.toContain(hidden);
  expect(JSON.stringify(projection.references)).not.toContain(hiddenHref);
  expect(JSON.stringify(projection.references)).not.toContain('mention.example');
  expect(JSON.stringify(projection.references)).not.toContain('Unsupported scheme');
  expect(projectPostReading(body, new Set([0])).references.eligible).toBe(4);

  const unicode = snapshot([link(`${'漢字é👩🏽‍🚀'.repeat(40)}`, 'https://unicode.example/long')]);
  const label = projectPostReading(unicode).references.entries[0]!.label;
  expect(Array.from(label)).toHaveLength(120);
  expect(label.endsWith('…')).toBe(true);
});

test('script-free reading keeps ordinary safe anchors, authored titles and repeated source targets', () => {
  const body = snapshot([
    link('Literal <img src=x onerror=alert(1)> label', 'https://source.example/a?x=1&y=2#part', 'Authored title'),
    link('Literal <img src=x onerror=alert(1)> label', 'https://source.example/a?x=1&y=2#part', 'Authored title'),
    link('Unsupported link', 'data:text/html,unsafe'),
  ]);
  const html = renderToStaticMarkup(<PostReadingBody document={body} />);
  expect(html).toContain('href="https://source.example/a?x=1&amp;y=2#part"');
  expect(html).toContain('title="Authored title"');
  expect(html).toContain('rel="noopener noreferrer nofollow ugc"');
  expect(html).not.toContain('data:text/html');
  expect(html).not.toContain('<img src=x');
  expect(html).not.toContain('>References</button>');
  const ids = [...html.matchAll(/id="(reading-[^"]+-r-\d+)"/gu)].map((match) => match[1]);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

async function mountPublishedReader(body: DocumentSnapshot) {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/#post-retained', width: 1280, height: 900 });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (media: string) => ({
      media,
      matches: false,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    }),
  });
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.scrollTo = () => {};
  const values: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
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
  const prior = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    prior.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container);
  const initial = preparedPostReading(1).post;
  let identity: object = {};
  let replace = () => {};
  function Reader() {
    const [visit, setVisit] = useState(identity);
    replace = () => {
      const next = {};
      identity = next;
      setVisit(next);
    };
    return (
      <>
        <button id="replace-reader" onClick={() => replace()}>
          Replace reader
        </button>
        <ThreadPostReadingBody
          post={{ ...initial, body }}
          mentions={{}}
          readerIdentity={visit}
          isReaderCurrent={() => true}
        />
      </>
    );
  }
  await act(async () => root.render(<Reader />));
  return {
    window,
    document: window.document,
    container,
    root,
    replace: () => replace(),
    async restore() {
      await act(async () => root.unmount());
      container.remove();
      for (const [key, descriptor] of prior) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.abort();
    },
  };
}

function button(root: ParentNode, name: string) {
  const match = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.getAttribute('aria-label') === name || element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`Missing button: ${name}`);
  return match;
}

test('published reader inspects one occurrence, returns without changing its fragment, and retires pending copy feedback', async () => {
  const firstHref = 'https://source.example/first?edition=one#section';
  const secondHref = 'https://source.example/second?edition=two#section';
  const body = snapshot([
    link('Same authored label', firstHref),
    link('Same authored label', secondHref),
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Hidden source',
          marks: [{ type: 'link', attrs: { href: 'https://private.example/hidden' } }, { type: 'spoiler' }],
        },
      ],
    },
  ]);
  const mounted = await mountPublishedReader(body);
  let resolveFirstWrite = () => {};
  const writes: string[] = [];
  Object.defineProperty(mounted.window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText(value: string) {
        writes.push(value);
        return new Promise<void>((resolve) => {
          resolveFirstWrite = resolve;
        });
      },
    },
  });
  try {
    const originalHash = mounted.window.location.hash;
    const launcher = button(mounted.container, m.post_references_title());
    await act(async () => launcher.click());
    const navigation = mounted.document.querySelector<HTMLElement>(`nav[aria-label="${m.post_references_title()}"]`)!;
    expect(navigation.textContent).not.toContain('Hidden source');
    const rows = Array.from(navigation.querySelectorAll<HTMLButtonElement>('button'));
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual([
      entryName(1, 'Same authored label'),
      entryName(2, 'Same authored label'),
    ]);
    await act(async () => rows[0]!.click());
    const dialog = mounted.document.querySelector<HTMLElement>('[role="dialog"]')!;
    const address = dialog.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(address.value).toBe(firstHref);
    expect(dialog.querySelector<HTMLAnchorElement>('a')?.href).toBe(firstHref);

    await act(async () => button(dialog, m.post_references_copy()).click());
    expect(writes).toEqual([firstHref]);
    expect(dialog.textContent).toContain(m.post_references_copy_pending());
    await act(async () => button(dialog, m.post_references_back()).click());
    const nextRow = mounted.document
      .querySelector<HTMLElement>(`nav[aria-label="${m.post_references_title()}"]`)
      ?.querySelectorAll<HTMLButtonElement>('button')[1];
    await act(async () => nextRow?.click());
    await act(async () => resolveFirstWrite());
    expect(mounted.document.body.textContent).not.toContain(m.post_references_copy_success());
    expect(mounted.document.querySelector('textarea')?.value).toBe(secondHref);

    Object.defineProperty(mounted.window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) },
    });
    const secondDialog = mounted.document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => button(secondDialog, m.post_references_copy()).click());
    expect(secondDialog.textContent).toContain(m.post_references_copy_denied());
    await act(async () => button(secondDialog, m.post_references_select()).click());
    expect(secondDialog.querySelector('textarea')).toBe(mounted.document.activeElement);
    Object.defineProperty(mounted.window.navigator, 'clipboard', { configurable: true, value: undefined });
    await act(async () => button(secondDialog, m.post_references_copy()).click());
    expect(secondDialog.textContent).toContain(m.post_references_copy_unavailable());
    await act(async () => button(secondDialog, m.post_references_select()).click());
    expect(secondDialog.querySelector('textarea')).toBe(mounted.document.activeElement);

    const secondOccurrenceId = mounted.container.querySelector<HTMLAnchorElement>(`a[href="${secondHref}"]`)!.id;
    await act(async () => button(secondDialog, m.post_references_return()).click());
    const closedDialog = mounted.document.querySelector<HTMLElement>('[role="dialog"]');
    if (closedDialog) {
      await act(async () => closedDialog.dispatchEvent(new mounted.window.Event('transitionend', { bubbles: true })));
    }
    expect(mounted.window.location.hash).toBe(originalHash);
    expect((mounted.document.activeElement as HTMLElement | null)?.getAttribute('id')).toBe(secondOccurrenceId);

    await act(async () => button(mounted.container, m.post_references_title()).click());
    const list = mounted.document.querySelector<HTMLElement>(`nav[aria-label="${m.post_references_title()}"]`)!;
    await act(async () => button(list, entryName(1, 'Same authored label')).click());
    let resolveReplacedWrite = () => {};
    Object.defineProperty(mounted.window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText() {
          return new Promise<void>((resolve) => {
            resolveReplacedWrite = resolve;
          });
        },
      },
    });
    const replacementDialog = mounted.document.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => button(replacementDialog, m.post_references_copy()).click());
    expect(replacementDialog.textContent).toContain(m.post_references_copy_pending());

    await act(async () => {
      mounted.replace();
    });
    await act(async () => resolveReplacedWrite());
    expect(mounted.container.querySelector('textarea')).toBeNull();
    expect(mounted.container.textContent).not.toContain(m.post_references_return_previous());
    expect(mounted.document.body.textContent).not.toContain(m.post_references_copy_success());
  } finally {
    await mounted.restore();
  }
});
