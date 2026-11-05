import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { documentText, fromPlainText, parseDocument, type DocumentNode, type DocumentSnapshot } from '@rezics/document';
import {
  admitWriting,
  exportRawWriting,
  exportWriting,
  PortableWriting,
  portableWritingLimits,
  type LocalWritingFile,
} from '../src/threads/portable-writing';

const file = (text: string, name = 'writing.txt'): LocalWritingFile => ({
  name,
  size: new TextEncoder().encode(text).length,
  text: async () => text,
});
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function harness() {
  const owner = new AbortController();
  let body = fromPlainText('Keep original writing', 'blocks');
  let revision = 0;
  let replaceable = true;
  let phase: 'ready' | 'pending' | 'failed' = 'ready';
  let raw: DocumentNode | null = null;
  let replacements = 0;
  let focused = 0;
  let copies = 0;
  let created = 0;
  let downloadFails = false;
  let copyFails = false;
  const live = new Set<string>();
  const transfer = new PortableWriting(
    {
      current: () => !owner.signal.aborted,
      signal: owner.signal,
      revision: () => revision,
      replaceable: () => replaceable,
      snapshot: () => ({ body, phase, raw }),
      replace: (next) => {
        body = next;
        revision++;
        replacements++;
      },
      focus: () => {
        focused++;
      },
    },
    {
      createURL: () => {
        const url = `blob:prepared-${++created}`;
        live.add(url);
        expect(live.size).toBe(1);
        return url;
      },
      revokeURL: (url) => {
        expect(live.delete(url)).toBe(true);
      },
      download: () => {
        if (downloadFails) throw new Error('Prepared download unavailable');
      },
      copy: async () => {
        copies++;
        if (copyFails) throw new Error('Prepared clipboard unavailable');
      },
    },
  );
  return {
    owner,
    transfer,
    live,
    body: () => body,
    replacements: () => replacements,
    focused: () => focused,
    copies: () => copies,
    edit(notify = true) {
      revision++;
      if (notify) transfer.changed();
    },
    busy() {
      replaceable = false;
    },
    failSnapshot() {
      phase = 'failed';
      raw = { type: 'doc', content: [{ type: 'text', text: 'Latest unnormalizable work' }] };
    },
    pending() {
      phase = 'pending';
    },
    noDownload() {
      downloadFails = true;
    },
    noCopy() {
      copyFails = true;
    },
  };
}

test('installed codecs retain Unicode, supported marks and literal text; the preview never gains media authority', () => {
  const markdown = admitWriting(
    '# Heading\n\n**Strong 漢字** and <b>literal HTML</b>\n\n![Private image](https://foreign.test/private?token=secret)',
    'markdown',
  );
  expect(markdown.body.profile).toBe('blocks');
  expect(markdown.text).toContain('Strong 漢字');
  expect(markdown.text).toContain('<b>literal HTML</b>');
  expect(JSON.stringify(markdown.body)).toContain('bold');
  expect(JSON.stringify(markdown.body)).not.toContain('foreign.test');
  expect(markdown.repairs.attachments).toBe(1);
  const text = admitWriting('**literal**\n尾\n', 'text');
  expect(text.text).toBe('**literal**\n尾\n');
  const portable = exportWriting(markdown.body, 'json');
  expect(documentText(parseDocument(JSON.parse(portable.content)))).toBe(markdown.text);
  expect(admitWriting(JSON.stringify(fromPlainText('Text profile')), 'json').body.profile).toBe('blocks');
});

test('opaque payloads, foreign media, credential links and command envelopes cannot enter preview or exports', () => {
  const body: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'text' },
          content: [
            {
              type: 'text',
              text: 'Visible link',
              marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://user:password@foreign.test/path' } }],
            },
          ],
        },
        { type: 'image', attrs: { id: 'image', src: '/media/foreign-id/original', alt: 'Image description' } },
        {
          type: 'extensionBlock',
          attrs: {
            id: 'component',
            definition: 'private',
            version: 'v1',
            fallback: 'Fallback',
            payload: { csrfToken: 'private-token', idempotencyKey: 'sealed-command', receipt: 'private-receipt' },
          },
        },
      ],
    },
  };
  const admitted = admitWriting(JSON.stringify(body), 'json');
  expect(admitted.repairs).toEqual({ attachments: 1, components: 1, links: 1 });
  expect(admitted.text).toBe('Visible link\nImage description\nFallback');
  for (const content of [
    JSON.stringify(admitted.body),
    exportWriting(body, 'json').content,
    exportWriting(body, 'text').content,
  ]) {
    for (const secret of ['foreign-id', 'password', 'private-token', 'sealed-command', 'private-receipt', 'payload'])
      expect(content).not.toContain(secret);
    expect(content).toContain('Fallback');
  }
  expect(JSON.stringify(admitted.body)).toContain('bold');
  expect(() => admitWriting(JSON.stringify({ ...body, idempotencyKey: 'forged-command' }), 'json')).toThrow('document');
  const bearerLink = structuredClone(body);
  bearerLink.doc.content![0]!.content![0]!.marks![1]!.attrs!.href = 'https://site.test/path?session=private';
  expect(admitWriting(JSON.stringify(bearerLink), 'json').repairs.links).toBe(1);
  const raw = exportRawWriting(body.doc);
  expect(raw.filename).toEndWith('.raw-recovery.json');
  expect(raw.content).toContain('Image description');
  expect(raw.content).toContain('Fallback');
  expect(raw.content).not.toContain('private-token');
  expect(() => admitWriting(raw.content, 'json')).toThrow('document');
});

test('1 KiB, 64 KiB and 1 MiB project linearly, while byte overflow and expansion refuse without truncation', async () => {
  for (const size of [1024, 64 * 1024, 1024 * 1024]) {
    const source = 'x'.repeat(size);
    const admitted = admitWriting(source, 'text');
    expect(admitted.inputBytes).toBe(size);
    expect(admitted.text.length).toBe(size);
    expect(admitted.nodes).toBe(3);
    expect(exportWriting(admitted.body, 'text').content).toBe(source);
  }
  const projections = [16, 1024, 8192].map((count) => admitWriting(Array(count).fill('line').join('\n'), 'text'));
  expect(projections.map((value) => value.nodes)).toEqual([33, 2049, 16385]);
  expect(() => admitWriting('界'.repeat(350000), 'text')).toThrow('size');
  expect(() => admitWriting('\n'.repeat(65536), 'text')).toThrow('expanded');
  const h = harness();
  let reads = 0;
  await h.transfer.select(null);
  await h.transfer.select({
    name: 'large.txt',
    size: portableWritingLimits.fileBytes + 1,
    text: async () => {
      reads++;
      return '';
    },
  });
  expect(reads).toBe(0);
  expect(h.transfer.snapshot().error).toBe('size');
  await h.transfer.select({
    name: 'network.url',
    size: 0,
    text: async () => {
      reads++;
      return '';
    },
  });
  expect(reads).toBe(0);
  expect(h.transfer.snapshot().error).toBe('type');
  await h.transfer.select({
    ...file('one read'),
    text: async () => {
      reads++;
      return 'one read';
    },
  });
  expect(reads).toBe(1);
});

test('deep JSON, invalid IDs, versions and unknown nodes fail closed without changing writing', async () => {
  const valid = fromPlainText('base', 'blocks');
  for (const mutate of [
    (body: any) => {
      body.version = 'unknown';
    },
    (body: any) => {
      body.doc.content[0].attrs.id = '';
    },
    (body: any) => {
      body.doc.content.push(body.doc.content[0]);
    },
    (body: any) => {
      body.doc.content[0].type = 'unknownNode';
    },
    (body: any) => {
      body.doc.content[0].attrs.session = 'private';
    },
  ]) {
    const body = structuredClone(valid);
    mutate(body);
    expect(() => admitWriting(JSON.stringify(body), 'json')).toThrow('document');
  }
  const nested = '['.repeat(80) + '0' + ']'.repeat(80);
  expect(() => admitWriting(nested, 'json')).toThrow('depth');
  const h = harness();
  await h.transfer.select(file('{broken', 'work.json'));
  expect(h.transfer.snapshot().error).toBe('json');
  expect(documentText(h.body())).toBe('Keep original writing');
  await h.transfer.select({
    name: 'lost.txt',
    size: 12,
    text: async () => {
      throw new Error('Prepared unreadable file');
    },
  });
  expect(h.transfer.snapshot().error).toBe('read');
});

test('inspection, keep-current and exact revision confirmation never replace newer or retired writing', async () => {
  const h = harness();
  await h.transfer.select(file('Preview only'));
  expect(h.replacements()).toBe(0);
  h.transfer.cancel();
  expect(h.replacements()).toBe(0);
  expect(h.focused()).toBe(1);
  await h.transfer.select(file('Stale preview'));
  h.edit(false); // Confirm itself must compare revision, even without a render notification.
  h.transfer.confirm();
  expect(h.transfer.snapshot().error).toBe('changed');
  expect(h.replacements()).toBe(0);
  const changedRead = gate<string>();
  const changedSelection = h.transfer.select({ name: 'changed.txt', size: 4, text: () => changedRead.promise });
  h.edit(false);
  changedRead.resolve('Late');
  await changedSelection;
  expect(h.transfer.snapshot().preview).toBeNull();
  expect(h.transfer.snapshot().error).toBe('changed');
  const late = gate<string>();
  const selected = h.transfer.select({ name: 'late.txt', size: 4, text: () => late.promise });
  await h.transfer.select(file('Newer file'));
  late.resolve('Late');
  await selected;
  expect(h.transfer.snapshot().preview?.text).toBe('Newer file');
  h.transfer.confirm();
  expect(documentText(h.body())).toBe('Newer file');
  const cancelled = gate<string>();
  const selection = h.transfer.select({ name: 'cancelled.txt', size: 8, text: () => cancelled.promise });
  h.transfer.cancel();
  cancelled.resolve('Cancelled');
  await selection;
  expect(h.transfer.snapshot().preview).toBeNull();
  const retired = gate<string>();
  const old = h.transfer.select({ name: 'private.txt', size: 7, text: () => retired.promise });
  h.owner.abort();
  retired.resolve('Private');
  await old;
  expect(h.transfer.snapshot().preview).toBeNull();
  h.transfer.confirm();
  expect(h.replacements()).toBe(1);
});

test('one object URL, honest copy/download fallback, failed snapshot recovery and unknown custody', async () => {
  const h = harness();
  h.transfer.export('json');
  expect(h.live.size).toBe(1);
  h.transfer.export('text');
  expect(h.live.size).toBe(1);
  h.edit();
  expect(h.live.size).toBe(0);
  h.noDownload();
  h.transfer.export('json');
  expect(h.transfer.snapshot().error).toBe('download');
  expect(h.live.size).toBe(0);
  await h.transfer.copy();
  expect(h.copies()).toBe(1);
  expect(h.transfer.snapshot().copied).toBe(true);
  h.noCopy();
  await h.transfer.copy();
  expect(h.transfer.snapshot().copied).toBe(false);
  expect(h.transfer.snapshot().error).toBe('copy');
  expect(h.transfer.snapshot().download?.content).toContain('Keep original writing');
  await h.transfer.select(file('Do not replace a sealed command'));
  h.busy();
  h.transfer.confirm();
  expect(h.replacements()).toBe(0);
  expect(h.transfer.snapshot().error).toBe('busy');
  h.transfer.export('text');
  expect(h.transfer.snapshot().download?.content).toBe('Keep original writing');
  h.pending();
  h.transfer.export('json');
  expect(h.transfer.snapshot().error).toBe('pending');
  h.failSnapshot();
  h.transfer.export('json');
  expect(h.transfer.snapshot().error).toBe('recovery');
  h.transfer.export('raw');
  expect(h.transfer.snapshot().download?.content).toContain('Latest unnormalizable work');
  expect(h.transfer.snapshot().download?.kind).toBe('raw');
  h.owner.abort();
  expect(h.transfer.snapshot().download).toBeNull();
});

test('real composer imports only on confirmation, keeps rich editing and exact unknown retry, then redacts account replacement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 1280, height: 900 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { PostComposer } = await import('../src/threads/composer');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in' as const, subject: 'prepared-writer', csrfToken: 'private-credential' };
  client.setQueryData(sessionQuery.queryKey, session);
  const commands: unknown[] = [];
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <PostComposer
        initialKey="original-current-visit-key"
        containerId="thread-1"
        initialBody={fromPlainText('Original rich writing', 'blocks')}
        onSubmit={async (command) => {
          commands.push(command);
          return { ok: false, reason: 'unavailable' };
        }}
        onSuccess={() => undefined}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const settle = async (predicate: () => boolean) => {
    for (let n = 0; n < 120 && !predicate(); n++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    expect(predicate()).toBe(true);
  };
  const button = (label: string) =>
    [...host.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)!;
  const click = async (label: string) =>
    act(async () => {
      expect(button(label)).toBeDefined();
      expect(button(label).disabled).toBe(false);
      button(label).click();
    });
  const choose = async (selected: LocalWritingFile) =>
    act(async () => {
      const input = host.querySelector('input[type="file"][accept^=".json"]')!;
      Object.defineProperty(input, 'files', { value: [selected], configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await settle(() => Boolean(host.querySelector('.ProseMirror')) && Boolean(button(m.thread_portable_files())));
    await click(m.thread_portable_files());
    await choose(file('![Imported description](https://foreign.invalid/private?token=credential)', 'image.md'));
    await settle(() => Boolean(button(m.thread_portable_replace())));
    expect(host.querySelector('[data-private-writing] img')).toBeNull();
    expect(host.querySelector('[data-private-writing]')!.textContent).toContain('Imported description');
    expect(host.querySelector('[data-private-writing]')!.innerHTML).not.toContain('foreign.invalid');
    await click(m.thread_portable_keep());
    await choose(file('**Imported rich text**', 'work.md'));
    await settle(() => Boolean(button(m.thread_portable_replace())));
    expect(host.querySelector('.ProseMirror')!.textContent).toContain('Original rich writing');
    await click(m.thread_portable_keep());
    expect(host.querySelector('.ProseMirror')!.textContent).toContain('Original rich writing');
    await choose(file('**Imported rich text**', 'work.md'));
    await click(m.thread_portable_replace());
    await settle(() => Boolean(host.querySelector('.ProseMirror strong')));
    expect(host.querySelector('.ProseMirror strong')!.textContent).toBe('Imported rich text');
    expect(window.document.activeElement).toBe(host.querySelector('.ProseMirror'));
    expect(commands).toHaveLength(0);
    await click(m.thread_portable_export_json());
    const output = host.querySelector('textarea')!;
    expect(output.value).toContain('bold');
    expect(output.value).not.toContain(session.csrfToken);
    expect(output.value).not.toContain('idempotencyKey');
    await click(m.thread_write_send());
    await settle(() => commands.length === 1 && Boolean(button(m.thread_write_retry())));
    expect(button(m.thread_portable_choose()).disabled).toBe(true);
    await click(m.thread_write_retry());
    expect(commands).toHaveLength(2);
    expect(commands[1]).toBe(commands[0]);
    const privateExport = host.querySelector('[data-private-writing]')!;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      expect(privateExport.textContent).toBe('');
      expect(output.value).toBe('');
      client.setQueryData(sessionQuery.queryKey, session);
    });
    expect(host.textContent).not.toContain('Imported rich text');
    expect(host.textContent).toContain(m.thread_authoring_session_changed());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
