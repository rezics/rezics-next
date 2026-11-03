import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import {
  documentText,
  fromPlainText,
  normalizeDocument,
  serializeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import {
  projectWriting,
  WritingInspection,
  writingInspectionLimits,
  type InspectionFacts,
  type SnapshotPhase,
} from '../src/threads/writing-inspection';

const facts: InspectionFacts = {
  pendingUploads: 0,
  attachmentIssues: [],
  refusal: null,
  unknown: false,
  sending: false,
};
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const blockBody = (content: DocumentNode[]) =>
  normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: withDocumentIds({ type: 'doc', content }),
  });
function projected(body: unknown, title: string | null = null, readiness = facts) {
  const result = projectWriting(body, title, readiness);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.problem);
  return result.projection;
}

test('codec units preserve exact Unicode, identifiers, mention identity, media and long link meaning', () => {
  const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
  const href = 'https://example.test/' + 'a'.repeat(16000);
  const body = blockBody([
    {
      type: 'heading',
      attrs: { id: 'retained-heading', level: 2 },
      content: [{ type: 'text', text: '日本語 👩🏽‍💻 e\u0301' }],
    },
    {
      type: 'paragraph',
      attrs: { id: 'retained-body' },
      content: [
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href } }] },
        { type: 'hardBreak' },
        { type: 'mention', attrs: { accountId } },
      ],
    },
    {
      type: 'image',
      attrs: { id: 'retained-image', src: '/media/0192f3a0-6c1e-7b2a-9d4e-000000000002/original', alt: '圖' },
    },
  ]);
  const before = JSON.stringify(body);
  const projection = projected(body, '😀e\u0301');
  expect(projection.body).toBe(body);
  expect(JSON.stringify(body)).toBe(before);
  expect(projection.summary.textCodePoints).toBe([...documentText(body)].length);
  expect(projection.summary.jsonBytes).toBe(bytes(before));
  expect(projection.summary.canonicalBytes).toBe(bytes(serializeDocument(body)));
  expect(projection.summary.titleCodeUnits).toBe(4);
  expect(projection.summary.titleRemaining).toBe(508);
  expect(projection.summary.images).toBe(1);
  expect(projection.summary.mentions).toBe(1);
  expect(projection.summary.links).toBe(1);
  expect(projection.body.doc.content![1]!.content![0]!.marks![0]!.attrs!.href).toBe(href);
  expect(before).toContain(accountId);
  expect(projection.outline[0]!.id).toBe('retained-heading');
  expect(projection.outline[0]!.label).toContain('e\u0301');
  expect(projectWriting(fromPlainText('Text profile'), null, facts)).toEqual({ ok: false, problem: 'profile' });
});

test('three admitted scales are linear in nodes, keep one document, and bound lists without hiding omissions', () => {
  const originalFetch = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = Object.assign(
    () => {
      reads++;
      throw new Error('Inspection must be local');
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  try {
    for (const size of [1024, 65536, 1048576]) {
      const body = fromPlainText('界'.repeat(Math.floor(size / 3)), 'blocks');
      const result = projectWriting(body, null, facts);
      if (bytes(JSON.stringify(body)) > writingInspectionLimits.bytes) {
        expect(result).toEqual({ ok: false, problem: 'size' });
      } else {
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.projection.body).toBe(body);
          expect(result.projection.summary.nodes).toBe(3);
          expect(result.projection.summary.textCodePoints).toBe(Math.floor(size / 3));
        }
      }
    }
    for (const count of [100, 1000, 10000]) {
      const body = fromPlainText(Array(count).fill('x').join('\n'), 'blocks');
      const p = projected(body, null, {
        ...facts,
        attachmentIssues: Array.from({ length: 32 }, (_, n) => ({ id: String(n), state: 'unavailable' })),
      });
      expect(p.summary.nodes).toBe(1 + 2 * count);
      expect(p.outline.length).toBe(100);
      expect(p.outlineTotal).toBe(count);
      expect(p.issues.length).toBe(20);
      expect(p.issueTotal).toBe(32);
    }
    const media = blockBody(
      Array.from({ length: 32 }, (_, n) => ({
        type: 'image',
        attrs: { id: `image-${n}`, src: `native-${n}`, alt: '' },
      })),
    );
    expect(projected(media).summary.imageRemaining).toBe(0);
    expect(projected(media).body).toBe(media);
    expect(reads).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('oversize, deeply nested, cyclic and unsupported snapshots reject whole without recovery mutation', () => {
  const oversized = fromPlainText('x'.repeat(writingInspectionLimits.bytes), 'blocks');
  expect(projectWriting(oversized, null, facts)).toEqual({ ok: false, problem: 'size' });
  let nested: DocumentNode = { type: 'paragraph', attrs: { id: 'leaf' } };
  for (let n = 0; n < 1000; n++) nested = { type: 'blockquote', attrs: { id: `q-${n}` }, content: [nested] };
  expect(
    projectWriting(
      { version: 'rezics-document-v1', profile: 'blocks', doc: { type: 'doc', content: [nested] } },
      null,
      facts,
    ),
  ).toEqual({ ok: false, problem: 'depth' });
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(projectWriting(cyclic, null, facts)).toEqual({ ok: false, problem: 'document' });
  const unknown = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: { type: 'doc', content: [{ type: 'unknown', text: 'recover me' }] },
  };
  expect(projectWriting(unknown, null, facts)).toEqual({ ok: false, problem: 'document' });
  expect(unknown.doc.content[0]!.text).toBe('recover me');
  const empty = projected(fromPlainText('', 'blocks'), '', {
    ...facts,
    unknown: true,
    pendingUploads: 1,
    refusal: 'Server refusal',
  });
  expect(empty.issues.map((item) => item.kind)).toEqual(['empty', 'title-empty', 'unknown', 'upload', 'refusal']);
});

test('revision replacement cancels measurement, cache reuse is exact, and abort irreversibly retires callbacks', async () => {
  const owner = new AbortController();
  let body = fromPlainText('one', 'blocks');
  let revision = 0;
  let phase: SnapshotPhase = 'ready';
  let snapshots = 0;
  const inspection = new WritingInspection({
    signal: owner.signal,
    binding: 'thread-a',
    current: () => true,
    revision: () => revision,
    snapshot: () => {
      snapshots++;
      return { body, phase };
    },
    title: () => null,
    facts: () => facts,
    editor: () => null,
  });
  inspection.open();
  const capture = inspection.snapshot().projection;
  const priorToken = inspection.token();
  inspection.close();
  inspection.open();
  expect(inspection.snapshot().projection).toBe(capture);
  revision++;
  body = fromPlainText('two', 'blocks');
  inspection.changed();
  expect(inspection.snapshot().phase).toBe('stale');
  expect(inspection.snapshot().projection).toBeNull();
  inspection.repair('old-block');
  expect(inspection.returnFocus()).toBe(false);
  phase = 'pending';
  inspection.refresh();
  expect(inspection.snapshot().problem).toBe('pending');
  phase = 'failed';
  inspection.refresh();
  expect(inspection.snapshot().problem).toBe('recovery');
  phase = 'ready';
  inspection.refresh();
  expect(inspection.snapshot().projection!.body).toBe(body);
  expect(inspection.matches(priorToken)).toBe(false);
  inspection.repair('old-block', false, priorToken);
  expect(inspection.snapshot().open).toBe(true);
  inspection.close();
  snapshots = 0;
  for (let n = 0; n < 100; n++) {
    revision++;
    inspection.changed();
  }
  expect(snapshots).toBe(0); // Input notification performs no snapshot read or document walk.
  owner.abort();
  await new Promise((resolve) => setTimeout(resolve, writingInspectionLimits.idleMs + 10));
  expect(snapshots).toBe(0);
  inspection.open();
  inspection.refresh();
  inspection.repair('anything');
  expect(inspection.snapshot().phase).toBe('retired');
  expect(inspection.snapshot().projection).toBeNull();
});

test('connected new-thread, reply and inline edit inspect exact unsent writing, repair focus and retain original deliberate command', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
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
  const { PostComposer, InlinePostEditor } = await import('../src/threads/composer');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const session = { state: 'signed-in' as const, subject: 'writer', csrfToken: 'private-csrf' };
  const commands: { body: DocumentSnapshot; idempotencyKey: string; parentId?: string; revisionId?: string }[] = [];
  const body = blockBody([
    {
      type: 'paragraph',
      attrs: { id: 'exact-current-node' },
      content: [{ type: 'text', text: 'Unsent 日本語 e\u0301 👩🏽‍💻' }],
    },
  ]);
  const serialized = serializeDocument(body);
  let mode: 'new' | 'reply' | 'edit' = 'new';
  const pageRoot = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => pageRoot,
    path: '/',
    component: () =>
      mode === 'edit' ? (
        <InlinePostEditor
          initialBody={body}
          containerId="thread"
          revisionId="source-revision"
          idempotencyKey="edit-key"
          onSubmit={async (command) => {
            commands.push(command);
            return { ok: false, reason: 'unavailable' };
          }}
          onCancel={() => undefined}
          onSuccess={() => undefined}
        />
      ) : (
        <PostComposer
          initialBody={body}
          initialKey="original-key"
          titleRequired={mode === 'new'}
          {...(mode === 'new' ? { boardId: 'board' } : { containerId: 'thread', replyTargetId: 'exact-parent' })}
          onSubmit={async (command) => {
            commands.push(command);
            return { ok: false, reason: 'unavailable' };
          }}
          onSuccess={() => undefined}
        />
      ),
  });
  const router = createRouter({
    routeTree: pageRoot.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  const settle = async (predicate: () => boolean) => {
    for (let n = 0; n < 160 && !predicate(); n++)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    expect(predicate()).toBe(true);
  };
  const button = (text: string) =>
    [...window.document.querySelectorAll('button')].find((item) => item.textContent?.trim() === text)!;
  const click = async (text: string) => {
    await act(async () => {
      button(text).click();
    });
  };
  try {
    for (const kind of ['new', 'reply', 'edit'] as const) {
      mode = kind;
      commands.length = 0;
      client.setQueryData(sessionQuery.queryKey, session);
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider key={kind} router={router} />
          </QueryClientProvider>,
        ),
      );
      await settle(() => Boolean(host.querySelector('.ProseMirror')) && Boolean(button(m.thread_inspection_open())));
      if (kind === 'new')
        await act(async () => {
          const input = host.querySelector('input:not([type="hidden"])')! as unknown as HTMLInputElement;
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'Unsent title');
          input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
        });
      await click(m.thread_inspection_open());
      await settle(() => Boolean(window.document.querySelector('[data-private-writing-inspection]')));
      const preview = window.document.querySelector('[data-private-writing-inspection]')!;
      expect(preview.textContent).toContain('Unsent 日本語 e\u0301 👩🏽‍💻');
      expect(preview.textContent).not.toContain('private-csrf');
      expect(preview.querySelectorAll('[data-slot="document-body"]').length).toBe(1);
      expect(preview.querySelectorAll('[contenteditable="true"]').length).toBe(0);
      expect(commands.length).toBe(0);
      await click(m.thread_inspection_repair());
      await settle(() => !window.document.querySelector('[role="dialog"]'));
      expect(window.document.activeElement).toBe(host.querySelector('.ProseMirror'));
      const anchor = window.document.getSelection()?.anchorNode;
      const anchorElement = anchor instanceof window.HTMLElement ? anchor : anchor?.parentElement;
      expect(anchorElement?.closest('[data-block-id]')?.getAttribute('data-block-id')).toBe('exact-current-node');
      await click(kind === 'edit' ? m.thread_edit_save() : m.thread_write_send());
      await settle(() => commands.length === 1);
      expect(serializeDocument(commands[0]!.body)).toBe(serialized);
      if (kind === 'reply') expect(commands[0]!.parentId).toBe('exact-parent');
      if (kind === 'edit') expect(commands[0]!.revisionId).toBe('source-revision');
      await click(m.thread_inspection_open());
      await settle(() => Boolean(window.document.querySelector('[data-private-writing-inspection]')));
      expect(window.document.body.textContent).toContain(m.thread_inspection_unknown());
      await click(m.thread_inspection_return());
      await settle(() => !window.document.querySelector('[role="dialog"]'));
      await click(kind === 'edit' ? m.thread_edit_save() : m.thread_write_retry());
      await settle(() => commands.length === 2);
      expect(commands[1]!.idempotencyKey).toBe(commands[0]!.idempotencyKey);
      expect(serializeDocument(commands[1]!.body)).toBe(serialized);
      await click(m.thread_inspection_open());
      await settle(() => Boolean(window.document.querySelector('[data-private-writing-inspection]')));
      const privateNode = window.document.querySelector('[data-private-writing-inspection]')!;
      await act(async () => {
        client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
        expect(privateNode.textContent).toBe('');
        client.setQueryData(sessionQuery.queryKey, session);
      });
      expect(window.document.body.textContent).not.toContain('Unsent 日本語');
      expect(host.textContent).toContain(m.thread_authoring_session_changed());
    }
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
