import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { act } from 'react';
import type { CurrentPost, EditFailure } from '../src/threads/actions';

test('stale editing reviews before replacement, keeps the full correction, and separates unknown outcomes', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/compose' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
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
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { InlinePostEditor } = await import('../src/threads/composer');
  const { sessionQuery } = await import('../src/session/query');
  const { fromPlainText } = await import('@rezics/document');
  const { m } = await import('../src/paraglide/messages.js');
  const require = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(require.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: window.document });
  const fetcher = mock(() => Promise.reject(new Error('Unexpected recovery read')));
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: Object.assign(fetcher, { preconnect() {} }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const owner = { state: 'signed-in' as const, subject: 'author', csrfToken: 'original-session' };
  const localMedia = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
  const draft = fromPlainText('Unsaved correction', 'blocks');
  draft.doc.content?.push({ type: 'image', attrs: { src: localMedia, alt: 'Selected image' } });
  const current = {
    body: fromPlainText('Admitted current correction', 'blocks'),
    mediaIds: [],
    revisionId: 'current-revision',
    availability: 'available',
    licence: 'CC-BY-4.0',
  } as CurrentPost;
  const commands: Parameters<React.ComponentProps<typeof InlinePostEditor>['onSubmit']>[0][] = [];
  let outcome: EditFailure = { ok: false, reason: 'stale', currentPost: current };
  const publishCommands: typeof commands = [];
  const senders: string[] = [];
  let cancelled = false;
  const button = (label: string, scope: ParentNode = document) =>
    [...scope.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.trim() === label)!;
  const click = async (label: string, scope?: ParentNode) => act(async () => button(label, scope).click());
  const editor = () => host.querySelector<HTMLElement>('.ProseMirror[contenteditable="true"]');
  const popup = () => document.querySelector<HTMLElement>('[role="alertdialog"]');
  const settle = async (ready: () => boolean) => {
    for (let n = 0; n < 180 && !ready(); n++)
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      });
    expect(ready()).toBe(true);
  };
  const mount = async (remount = true, publish = false, sender = 'original') => {
    if (remount) await act(async () => root.render(null));
    client.setQueryData(sessionQuery.queryKey, owner);
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <InlinePostEditor
            initialBody={draft}
            initialMediaIds={[localMedia]}
            revisionId={sender === 'replacement' ? 'replacement-revision' : 'original-revision'}
            allowPublish={publish}
            idempotencyKey="original-key"
            containerId="thread"
            onSubmit={async (command) => {
              senders.push(sender);
              commands.push(structuredClone(command));
              return outcome;
            }}
            onPublish={async (command) => {
              senders.push(sender);
              publishCommands.push(structuredClone(command));
              return outcome;
            }}
            onCancel={() => (cancelled = true)}
            onSuccess={() => undefined}
          />
        </QueryClientProvider>,
      ),
    );
    await settle(() => !!editor());
  };
  try {
    await mount();
    await click(m.thread_edit_save());
    await click(m.thread_edit_review_current());
    await settle(() => !!popup());
    await settle(() => document.activeElement === button(m.thread_edit_keep_editing(), popup()!));
    await click(m.thread_edit_keep_editing(), popup()!);
    await settle(() => !popup() && document.activeElement === editor());
    await click(m.thread_edit_review_current());
    await act(async () =>
      button(m.thread_edit_keep_editing(), popup()!).dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    await settle(() => !popup() && document.activeElement === editor());
    expect(cancelled).toBe(false);
    await click(m.thread_edit_save());
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[1]!.mediaIds).toEqual([localMedia]);
    await click(m.thread_edit_review_current());
    await click(m.thread_edit_replace_current(), popup()!);
    await settle(() => !popup() && !!editor()?.textContent?.includes('Admitted current correction'));
    outcome = { ok: false, reason: 'unavailable' };
    await click(m.thread_edit_save());
    expect(commands[2]).toMatchObject({ body: current.body, revisionId: current.revisionId, mediaIds: [] });
    expect(commands[2]!.idempotencyKey).not.toBe(commands[0]!.idempotencyKey);
    expect(host.textContent).not.toContain(m.thread_edit_review_current());
    await click(m.thread_recovery_retry_original());
    expect(commands[3]).toEqual(commands[2]);
    outcome = { ok: false, reason: 'stale', currentPost: { ...current, body: null } };
    await mount();
    await click(m.thread_edit_save());
    await click(m.thread_edit_review_current());
    expect(popup()!.textContent).toContain(m.thread_edit_current_unavailable());
    expect(popup()!.textContent).not.toContain('Admitted current correction');
    expect(button(m.thread_edit_replace_current(), popup()!).disabled).toBe(true);
    await click(m.thread_edit_keep_editing(), popup()!);
    expect(editor()!.textContent).toContain('Unsaved correction');
    // Publish replay retains its original action, sender and revision even after replacement props and local edits.
    outcome = { ok: false, reason: 'unavailable' };
    await mount(true, true, 'original-publish');
    await click(m.own_drafts_publish());
    const published = structuredClone(publishCommands[0]!);
    await act(async () => {
      await user.click(editor()!);
      await user.keyboard(' newer local correction');
    });
    await mount(false, false, 'replacement');
    expect(button(m.thread_edit_save()).disabled).toBe(true);
    await click(m.thread_recovery_retry_original());
    expect(publishCommands).toEqual([published, published]);
    expect(senders.slice(-2)).toEqual(['original-publish', 'original-publish']);
    expect(published.revisionId).toBe('original-revision');
    expect(JSON.stringify(published.body)).not.toContain('newer local correction');
    outcome = { ok: false, reason: 'invalid' };
    await click(m.thread_recovery_retry_original());
    expect(editor()!.textContent).toContain('newer local correction');
    expect(button(m.thread_edit_save()).disabled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    mock.restore();
    await window.happyDOM.close();
  }
});
