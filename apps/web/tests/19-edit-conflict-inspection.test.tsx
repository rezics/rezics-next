import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ComponentProps } from 'react';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { CurrentPost, EditFailure } from '../src/threads/actions';
import {
  ConflictInspection,
  conflictInspectionLimits,
  projectConflictDocument,
  type ConflictPresentation,
} from '../src/threads/edit-conflict-inspection';

// Prepared documents and definitive results; no native response or identity is fabricated by the UI.
const body = (label: string, count = 1) =>
  fromPlainText(
    Array.from(
      { length: count },
      (_, index) => `${label} ${index + 1} 終わり https://example.test/${'long'.repeat(30)}`,
    ).join('\n'),
    'blocks',
  );
const post = (document: DocumentSnapshot | null = body('Current')) =>
  ({
    id: 'post',
    threadId: 'thread',
    revisionId: 'returned-revision',
    securityRevision: 'security',
    body: document,
    mediaIds: [],
    availability: 'available',
    licence: 'CC-BY-4.0',
    createdAt: '2026-11-01T01:02:03Z',
    revisedAt: '2026-11-02T02:03:04Z',
  }) as CurrentPost;
function binding(document = body('Retained')) {
  const controller = new AbortController();
  let reading = { body: document, revision: 0 };
  let admitted = true;
  const presentation: ConflictPresentation = {
    ...reading,
    authority: {},
    signal: controller.signal,
    inspectable: true,
    read: () => (admitted ? reading : null),
  };
  return {
    presentation,
    controller,
    change: (next: typeof reading) => {
      reading = next;
    },
    retire: () => {
      admitted = false;
    },
  };
}

test('1/10/100 blocks have linear label work, retain references and conceal spoilers', () => {
  for (const count of [1, 10, 100]) {
    const source = body('Retained', count);
    const projection = projectConflictDocument(source);
    expect(projection.state).toBe('ready');
    if (projection.state !== 'ready') throw new Error('Expected admitted fixture');
    expect(projection.body).toBe(source);
    expect(projection.sections).toHaveLength(count);
    expect(projection.nodes).toBe(count * 2);
    expect(projection.sections.every((section) => [...section.label].length <= 96)).toBe(true);
    expect(projection.sections.at(-1)?.offset).toBe(count - 1);
  }
  const spoiler: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'spoiler' },
          content: [
            { type: 'text', text: 'Visible ' },
            { type: 'text', text: 'Concealed secret', marks: [{ type: 'spoiler' }] },
          ],
        },
        {
          type: 'extensionBlock',
          attrs: {
            id: 'component',
            definition: 'https://example.test/component',
            version: 1,
            payload: {},
            fallback: 'Fallback secret',
          },
        },
      ],
    },
  };
  // The installed codec determines extension support. A separate valid spoiler always pins non-disclosure.
  const supported = { ...spoiler, doc: { type: 'doc', content: [spoiler.doc.content![0]!] } };
  const projected = projectConflictDocument(supported);
  expect(projected.state).toBe('ready');
  if (projected.state === 'ready') {
    expect(projected.sections[0]?.label).toBe('Visible');
    expect(projected.sections[0]?.concealed).toBe(true);
  }
});

test('the installed byte boundary is exact, including UTF-8 and overflow without truncation', () => {
  const empty = fromPlainText('x', 'blocks');
  const overhead = new TextEncoder().encode(JSON.stringify(empty)).byteLength - 1;
  const exact = fromPlainText('x'.repeat(conflictInspectionLimits.bytes - overhead), 'blocks');
  const projection = projectConflictDocument(exact);
  expect(projection.state).toBe('ready');
  expect(projection.bytes).toBe(conflictInspectionLimits.bytes);
  const overflow = fromPlainText('x'.repeat(conflictInspectionLimits.bytes - overhead + 1), 'blocks');
  expect(projectConflictDocument(overflow).state).toBe('too-large');
  const cjk = fromPlainText('漢'.repeat(Math.floor((conflictInspectionLimits.bytes - overhead) / 3) + 1), 'blocks');
  expect(projectConflictDocument(cjk).state).toBe('too-large');
  expect(projectConflictDocument({ ...empty, version: 'future' } as unknown as DocumentSnapshot).state).toBe(
    'unsupported',
  );
});

test('replacement binds the exact draft, current identity, body and original admission permanently', () => {
  const current = post();
  for (const update of [
    (local: ReturnType<typeof binding>) => local.change({ body: local.presentation.body, revision: 1 }),
    (local: ReturnType<typeof binding>) => local.change({ body: body('New reference'), revision: 0 }),
    (local: ReturnType<typeof binding>) => local.retire(),
    (local: ReturnType<typeof binding>) => local.controller.abort(),
  ]) {
    const local = binding();
    const visit = new ConflictInspection(current, local.presentation);
    expect(visit.replacement(current, local.presentation)).toBe(current);
    update(local);
    expect(visit.replacement(current, local.presentation)).toBeNull();
    local.change({ body: local.presentation.body, revision: 0 });
    expect(visit.replacement(current, local.presentation)).toBeNull();
    expect(visit.current).toBeUndefined();
    expect(visit.draftProjection).toBeUndefined();
  }
  for (const changed of [
    { ...current },
    { ...current, id: 'other-post' },
    { ...current, revisionId: 'new-revision' },
    { ...current, body: null },
    { ...current, availability: 'erased', body: null },
  ] as CurrentPost[]) {
    const local = binding();
    const visit = new ConflictInspection(current, local.presentation);
    expect(visit.replacement(changed, local.presentation)).toBeNull();
  }
  const local = binding();
  expect(new ConflictInspection(post(null), local.presentation).replacement(post(null), local.presentation)).toBeNull();
  const absent = post(null);
  expect(new ConflictInspection(absent, local.presentation).replacement(absent, local.presentation)).toBeNull();
  const visit = new ConflictInspection(current, local.presentation);
  expect(visit.validate(current, { ...local.presentation, authority: {} })).toBe('retired');
});

let window: any;
let restore: () => Promise<void>;
beforeAll(async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  window = new Window({ url: 'https://site.test/en/thread' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
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
  const previous = new Map(
    [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  mock.module('cloudflare:workers', () => ({ env: {} }));
  restore = async () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
    await window.happyDOM.close();
  };
});
afterAll(async () => {
  await restore?.();
});
const button = (name: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!found) throw new Error(`Missing button: ${name}`);
  return found;
};
const click = async (name: string, scope?: ParentNode) => act(async () => button(name, scope).click());
const popup = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
async function settle(ready: () => boolean) {
  for (let count = 0; count < 200 && !ready(); count++)
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
  expect(ready()).toBe(true);
}

// These are DOM interactions, not browser rendering, accessibility or native endpoint execution.
test('paired indexes are bounded, locally paged, complete and retired before late disclosure or replacement', async () => {
  const { createRoot } = await import('react-dom/client');
  const { EditConflictRecovery } = await import('../src/threads/edit-conflict-recovery');
  const { m } = await import('../src/paraglide/messages.js');
  const host = document.createElement('main');
  const origin = document.createElement('textarea');
  origin.value = 'Retained selection';
  host.append(origin);
  document.body.append(host);
  const mount = document.createElement('div');
  host.append(mount);
  const root = createRoot(mount);
  const local = binding(body('Retained', 100));
  const current = post(body('Current', 100));
  const replace = mock();
  const network = mock(() => Promise.reject(new Error('Unexpected inspection network')));
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(network, { preconnect() {} }),
  });
  const render = async (result: CurrentPost | undefined = current, port = local.presentation) =>
    act(async () =>
      root.render(
        <EditConflictRecovery current={result} presentation={port} onReplace={replace} returningFocus={() => origin} />,
      ),
    );
  try {
    await render();
    origin.focus();
    origin.setSelectionRange(2, 8, 'forward');
    await click(m.thread_edit_review_current());
    await settle(() => !!popup());
    const sides = () => [...popup()!.querySelectorAll<HTMLElement>('[data-conflict-reading]')];
    expect(sides()).toHaveLength(2);
    expect(sides()[0]!.textContent).toContain('Retained 100');
    expect(sides()[1]!.textContent).toContain('Current 100');
    expect(popup()!.querySelectorAll('[data-conflict-section]').length).toBe(20);
    expect(popup()!.querySelectorAll('[data-slot="document-body"]').length).toBe(2);
    expect(sides()[1]!.textContent).toContain(current.createdAt);
    await click(m.thread_inspect_next_sections(), sides()[0]);
    expect(sides()[0]!.querySelector('[data-conflict-section]')?.getAttribute('data-conflict-section')).toBe('10');
    expect(sides()[1]!.querySelector('[data-conflict-section]')?.getAttribute('data-conflict-section')).toBe('0');
    await act(async () => sides()[0]!.querySelector<HTMLButtonElement>('[data-conflict-section="10"]')!.click());
    expect(sides()[0]!.querySelector('[data-slot="document-body"]')!.textContent).toContain('Retained 11');
    expect(sides()[0]!.querySelector('[data-slot="document-body"]')!.textContent).not.toContain('Retained 100');
    await click(m.thread_inspect_full_document(), sides()[0]);
    expect(sides()[0]!.querySelector('[data-slot="document-body"]')!.textContent).toContain('Retained 100');
    expect(replace).not.toHaveBeenCalled();
    await click(m.thread_edit_keep_editing(), popup()!);
    await settle(() => !popup() && document.activeElement === origin);
    expect([origin.selectionStart, origin.selectionEnd]).toEqual([2, 8]);
    await click(m.thread_edit_review_current());
    const lateReplace = button(m.thread_edit_replace_current(), popup()!);
    local.change({ body: local.presentation.body, revision: 1 });
    await act(async () => lateReplace.click());
    expect(replace).not.toHaveBeenCalled();
    await render(current, { ...local.presentation, revision: 1 });
    expect(popup()!.textContent).toContain(m.thread_inspect_draft_changed());
    expect(popup()!.textContent).not.toContain('Retained 100');
    expect(button(m.thread_edit_replace_current(), popup()!).disabled).toBe(true);
    await click(m.thread_edit_keep_editing(), popup()!);
    local.change({ body: local.presentation.body, revision: 0 });
    await render();
    await click(m.thread_edit_review_current());
    const obsolete = button(m.thread_edit_replace_current(), popup()!);
    await act(async () => local.controller.abort());
    await act(async () => obsolete.click());
    await settle(() => !popup());
    expect(replace).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}, 20_000);

test('concealed current text cannot be revealed by an obsolete click and cancel does not steal newer focus', async () => {
  const { createRoot } = await import('react-dom/client');
  const { EditConflictRecovery } = await import('../src/threads/edit-conflict-recovery');
  const { m } = await import('../src/paraglide/messages.js');
  const local = binding();
  const secret: DocumentSnapshot = {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'secret' },
          content: [{ type: 'text', text: 'Private current', marks: [{ type: 'spoiler' }] }],
        },
      ],
    },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const origin = document.createElement('textarea');
  document.body.append(origin);
  const newer = document.createElement('button');
  document.body.append(newer);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <EditConflictRecovery
          current={post(secret)}
          presentation={local.presentation}
          onReplace={() => {
            throw new Error('Unexpected replacement');
          }}
          returningFocus={() => origin}
        />,
      ),
    );
    await click(m.thread_edit_review_current());
    const reveal = popup()!.querySelector<HTMLButtonElement>('.document-spoiler')!;
    expect(reveal).not.toBeNull();
    expect(popup()!.querySelector('[data-conflict-section]')!.textContent).not.toContain('Private current');
    local.retire();
    await act(async () => reveal.click());
    expect(document.querySelector('.document-spoiler-revealed')).toBeNull();
    await settle(() => !popup());
    // New visit, deliberate cancellation followed by a newer action before finalFocus runs.
    const next = binding();
    await act(async () =>
      root.render(
        <EditConflictRecovery
          current={post()}
          presentation={next.presentation}
          onReplace={() => undefined}
          returningFocus={() => origin}
        />,
      ),
    );
    await click(m.thread_edit_review_current());
    await act(async () => {
      button(m.thread_edit_keep_editing(), popup()!).click();
      newer.focus();
    });
    await settle(() => !popup());
    expect(document.activeElement).toBe(newer);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    origin.remove();
    newer.remove();
  }
}, 20_000);

test('real editor preserves exact command retry and media, replaces locally, and excludes unknown delivery', async () => {
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { InlinePostEditor } = await import('../src/threads/composer');
  const { sessionQuery } = await import('../src/session/query');
  const { m } = await import('../src/paraglide/messages.js');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = { state: 'signed-in' as const, subject: 'writer', csrfToken: 'original' };
  client.setQueryData(sessionQuery.queryKey, owner);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const media = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
  const retained: DocumentSnapshot = {
    ...body('Retained'),
    doc: {
      type: 'doc',
      content: [
        ...body('Retained').doc.content!,
        { type: 'image', attrs: { id: 'retained-image', src: media, alt: 'Retained image' } },
      ],
    },
  };
  const current = post();
  let result: EditFailure = { ok: false, reason: 'stale', currentPost: current };
  const commands: Parameters<ComponentProps<typeof InlinePostEditor>['onSubmit']>[0][] = [];
  const network = mock(() => Promise.reject(new Error('Unexpected recovery fetch')));
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(network, { preconnect() {} }),
  });
  let readerCurrent = true;
  const readerAuthority = {};
  const mount = async () => {
    await act(async () => root.render(null));
    client.setQueryData(sessionQuery.queryKey, owner);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InlinePostEditor
            initialBody={retained}
            initialMediaIds={[media]}
            revisionId="original-revision"
            idempotencyKey="original-key"
            containerId="thread"
            inspectionAdmission={{ authority: readerAuthority, current: () => readerCurrent }}
            onSubmit={async (command) => {
              commands.push(structuredClone(command));
              return result;
            }}
            onCancel={() => undefined}
            onSuccess={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => !!host.querySelector('.ProseMirror[contenteditable="true"]'));
  };
  try {
    await mount();
    await click(m.thread_edit_save());
    await click(m.thread_edit_review_current());
    expect(popup()!.querySelectorAll('[data-conflict-reading]')).toHaveLength(2);
    expect(popup()!.querySelector('img')).toBeNull();
    expect(popup()!.textContent).toContain('Retained image');
    await click(m.thread_edit_keep_editing(), popup()!);
    await settle(() => !popup());
    await click(m.thread_edit_save());
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[1]!.mediaIds).toEqual([media]);
    await click(m.thread_edit_review_current());
    const sends = commands.length;
    await click(m.thread_edit_replace_current(), popup()!);
    await settle(() => !popup() && !!host.querySelector('.ProseMirror')?.textContent?.includes('Current'));
    expect(commands).toHaveLength(sends);
    result = { ok: false, reason: 'unavailable' };
    await click(m.thread_edit_save());
    expect(commands.at(-1)).toMatchObject({ body: current.body, revisionId: current.revisionId, mediaIds: [] });
    expect(commands.at(-1)!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(host.textContent).not.toContain(m.thread_edit_review_current());
    await click(m.thread_edit_save());
    expect(commands.at(-1)).toEqual(commands.at(-2));
    // A definitive result with no body keeps the local document readable and editable.
    result = { ok: false, reason: 'stale', currentPost: post(null) };
    await mount();
    await click(m.thread_edit_save());
    await click(m.thread_edit_review_current());
    expect(popup()!.textContent).toContain(m.thread_edit_current_unavailable());
    expect(popup()!.textContent).toContain('Retained');
    expect(button(m.thread_edit_replace_current(), popup()!).disabled).toBe(true);
    await click(m.thread_edit_keep_editing(), popup()!);
    result = { ok: false, reason: 'stale', currentPost: current };
    await mount();
    await click(m.thread_edit_save());
    await click(m.thread_edit_review_current());
    const late = button(m.thread_edit_replace_current(), popup()!);
    readerCurrent = false;
    await act(async () => late.click());
    expect(host.querySelector('.ProseMirror')!.textContent).toContain('Retained');
    // Session changes also retire the composed dialog and every private reading.
    await act(async () => client.setQueryData(sessionQuery.queryKey, { ...owner, csrfToken: 'replacement' }));
    await settle(() => !popup());
    expect(host.textContent).not.toContain('Retained');
    expect(network).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
}, 30_000);
