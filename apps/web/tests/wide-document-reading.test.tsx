import { afterAll, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import { documentVersion, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { preparedPostReading, readingSecret } from '../src/stories/post-reading-fixtures';
import { ThreadPostReadingBody } from '../src/threads/post-reading-body';
import type { ThreadPost } from '../src/threads/reads';
import { admitWriting, PortableWritingError, portableWritingLimits } from '../src/threads/portable-writing';
import {
  extractSelectedCode,
  MAX_WIDE_CODE_BYTES,
  MAX_WIDE_DOCUMENT_BLOCKS,
  registerWideDocumentBlocks,
} from '../src/threads/wide-document-reading';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());

const exactCode = 'const literal = "<script>keep</script>";\t// 文字\r\n\r\nconsole.log("مرحبا");\r\n';

function codeNode(text: string, marks?: DocumentNode['marks']): DocumentNode {
  return {
    type: 'codeBlock',
    attrs: { language: 'typescript' },
    content: [{ type: 'text', text, ...(marks ? { marks } : {}) }],
  };
}

function tableNode(children?: DocumentNode[]): DocumentNode {
  return {
    type: 'table',
    attrs: { caption: 'Feature comparison' },
    content: [
      {
        type: 'tableRow',
        content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Feature' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Notes' }] }] },
        ],
      },
      {
        type: 'tableRow',
        content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Width' }] }] },
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Scrollable' }] }] },
        ],
      },
      ...(children ? [{ type: 'tableRow', content: children }] : []),
    ],
  };
}

function snapshot(content: DocumentNode[]): DocumentSnapshot {
  return { version: documentVersion, profile: 'blocks', doc: { type: 'doc', content } };
}

function codeTextFromNode(node: DocumentNode): string {
  const chunks: string[] = [];
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === 'text') chunks.push(current.text ?? '');
    else for (const child of [...(current.content ?? [])].reverse()) stack.push(child);
  }
  return chunks.join('');
}

function withCode(post: ThreadPost, text: string): ThreadPost {
  const content = post.body.doc.content!.map((node) =>
    node.type === 'codeBlock'
      ? { ...node, content: [{ type: 'text', text }] }
      : node.type === 'table'
        ? { ...node, attrs: { ...node.attrs, caption: 'Feature comparison' } }
        : node,
  );
  return { ...post, body: { ...post.body, doc: { ...post.body.doc, content } } };
}

function button(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label,
    ) ?? null
  );
}

test('wide reading registers bounded disclosed blocks and keeps codec admission limits', () => {
  for (const count of [1, 16, 64, 65]) {
    const registered = registerWideDocumentBlocks(snapshot(Array.from({ length: count }, (_, index) => codeNode(`line ${index}`))));
    expect(registered).toHaveLength(Math.min(count, MAX_WIDE_DOCUMENT_BLOCKS));
    expect(registered.map((item) => item.order)).toEqual([...registered.map((item) => item.order)].sort((a, b) => a - b));
  }

  const selected = registerWideDocumentBlocks(snapshot([codeNode('first block'), codeNode(exactCode)]))[1]!;
  expect(extractSelectedCode(selected)).toBe(exactCode);
  const spoilerDocument = snapshot([codeNode('hidden', [{ type: 'spoiler' }])]);
  expect(registerWideDocumentBlocks(spoilerDocument)).toHaveLength(0);
  expect(registerWideDocumentBlocks(spoilerDocument, new Set([0]))[0]?.codeBytes).toBe('hidden'.length);

  const imageTable = tableNode([
    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: 'media-id' } }] }] },
  ]);
  expect(registerWideDocumentBlocks(snapshot([tableNode(), imageTable]))).toHaveLength(1);
  expect(registerWideDocumentBlocks(snapshot([codeNode('x'.repeat(MAX_WIDE_CODE_BYTES + 1))]))[0]?.codeBytes).toBe(
    MAX_WIDE_CODE_BYTES + 1,
  );

  const deep: Record<string, unknown> = {};
  let cursor = deep;
  for (let depth = 0; depth <= portableWritingLimits.depth; depth += 1) {
    cursor.child = {};
    cursor = cursor.child as Record<string, unknown>;
  }
  expect(() => admitWriting(JSON.stringify(deep), 'json')).toThrow(PortableWritingError);
  expect(() => admitWriting(JSON.stringify(deep), 'json')).toThrow('depth');
  expect(() => admitWriting('x'.repeat(portableWritingLimits.fileBytes + 1), 'json')).toThrow('size');
});

test('published reader preserves exact code, table semantics, clipboard recovery and visit retirement', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/threads/reader', width: 390, height: 844 });
  const network = mock(async () => {
    throw new Error('Wide document reading must not call a producer.');
  });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    HTMLImageElement: window.HTMLImageElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
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
    fetch: network as unknown as typeof fetch,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  window.fetch = globals.fetch;

  const { createRoot } = await import('react-dom/client');
  const supplied = preparedPostReading(2);
  const post = withCode(supplied.post, exactCode);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  let clipboardWrites: string[] = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void clipboardWrites.push(text) },
  });
  setLocale('en', { reload: false });

  try {
    await act(async () =>
      root.render(
        <ThreadPostReadingBody post={post} mentions={{}} locale="en" readerIdentity="viewer-a" />,
      ),
    );

    const codeRegion = host.querySelector<HTMLElement>('pre.wide-document-code-content');
    expect(codeRegion?.textContent).toBe(exactCode);
    expect(codeRegion?.querySelector('script, img')).toBeNull();
    const wrap = button(host, m.wide_document_code_wrap())!;
    expect(wrap.getAttribute('aria-pressed')).toBe('true');
    await act(async () => wrap.click());
    expect(wrap.getAttribute('aria-pressed')).toBe('false');
    expect(host.querySelector('pre.wide-document-code-content')?.textContent).toBe(exactCode);

    clipboardWrites = [];
    await act(async () => button(host, m.wide_document_code_copy())!.click());
    expect(clipboardWrites).toEqual([exactCode]);
    expect(host.textContent).toContain(m.wide_document_code_copied());

    const codeTrigger = button(host, m.wide_document_code_inspect())!;
    await act(async () => codeTrigger.click());
    let dialog = window.document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(window.document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog?.querySelector('[data-slot="code-block-code"]')?.textContent).toBe(exactCode);
    expect(dialog?.textContent).not.toContain(readingSecret);
    await act(async () => button(dialog!, m.wide_document_inspector_close())!.click());
    expect(window.document.activeElement).toBe(codeTrigger);

    const tableTrigger = button(host, m.wide_document_table_inspect())!;
    await act(async () => tableTrigger.click());
    dialog = window.document.body.querySelector<HTMLElement>('[role="dialog"]');
    const tableRegion = dialog?.querySelector<HTMLElement>('[role="region"]');
    expect(tableRegion?.getAttribute('tabindex')).toBe('0');
    expect(tableRegion?.querySelectorAll('th[scope="col"]').length).toBeGreaterThan(0);
    expect(tableRegion?.querySelector('caption')?.textContent).toBe('Feature comparison');
    expect(dialog?.textContent).not.toContain(readingSecret);
    tableRegion?.focus();
    expect(window.document.activeElement).toBe(tableRegion);
    await act(async () => button(dialog!, m.wide_document_inspector_close())!.click());
    expect(window.document.activeElement).toBe(tableTrigger);

    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error('Clipboard denied');
        },
      },
    });
    await act(async () => button(host, m.wide_document_code_copy())!.click());
    expect(host.textContent).toContain(m.wide_document_code_copy_failed());
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(exactCode);

    Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: undefined });
    await act(async () => button(host, m.wide_document_code_copy())!.click());
    expect(host.textContent).toContain(m.wide_document_code_clipboard_unavailable());
    expect(host.querySelector<HTMLTextAreaElement>('textarea')?.value).toBe(exactCode);

    let releaseWrite: (() => void) | undefined;
    const deferred = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => deferred },
    });
    await act(async () => codeTrigger.click());
    dialog = window.document.body.querySelector<HTMLElement>('[role="dialog"]');
    await act(async () => button(dialog!, m.wide_document_code_copy())!.click());
    expect(dialog?.textContent).toContain(m.wide_document_code_copying());

    const replacement = withCode(
      { ...post, revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000099', sha256: '1'.repeat(64) },
      'replacement revision',
    );
    await act(async () =>
      root.render(
        <ThreadPostReadingBody post={replacement} mentions={{}} locale="en" readerIdentity="viewer-b" />,
      ),
    );
    expect(window.document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(host.textContent).not.toContain(m.wide_document_code_copied());
    await act(async () => {
      releaseWrite?.();
      await deferred;
      await Promise.resolve();
    });
    expect(host.textContent).not.toContain(m.wide_document_code_copied());

    const oversized = withCode(replacement, 'x'.repeat(MAX_WIDE_CODE_BYTES + 1));
    await act(async () => root.render(<ThreadPostReadingBody post={oversized} mentions={{}} locale="en" />));
    expect(button(host, m.wide_document_code_copy())?.disabled).toBe(true);
    expect(host.textContent).toContain(m.wide_document_code_too_large());
    expect(host.querySelector('pre.wide-document-code-content')?.textContent).toHaveLength(
      MAX_WIDE_CODE_BYTES + 1,
    );

    const unavailable = { ...oversized, availability: 'unavailable' } as unknown as ThreadPost;
    await act(async () => root.render(<ThreadPostReadingBody post={unavailable} mentions={{}} locale="en" />));
    expect(button(host, m.wide_document_code_copy())).toBeNull();
    expect(button(host, m.wide_document_code_inspect())).toBeNull();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.happyDOM.abort();
  }
});
