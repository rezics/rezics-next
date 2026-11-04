import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccessState, Change, Identity } from '../src/accounts/resource-access/data';
import { snapshot } from '../src/stories/pages/accounts-resource-access/fixtures';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/accounts/resource-access' });
const globals = Object.fromEntries(
  'document navigator HTMLElement HTMLInputElement HTMLButtonElement HTMLFormElement Element Node NodeFilter Document ShadowRoot DocumentFragment MutationObserver ResizeObserver Event KeyboardEvent FocusEvent MouseEvent PointerEvent CSS'
    .split(' ')
    .map((key) => [key, Reflect.get(window, key)]),
);
Object.assign(globals, {
  window,
  IS_REACT_ACT_ENVIRONMENT: true,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { within, userEvent, fireEvent } = await import('storybook/test');
const { ResourceAccessPage } = await import('../src/accounts/resource-access/page');
const { m } = await import('../src/paraglide/messages.js');
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous)
    descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
});

for (const boundary of ['handle', 'kind', 'cancel', 'resource', 'actor'] as const)
  test(`lookup cannot outlive ${boundary}; retry preserves the draft and saves the reviewed recipient`, async () => {
    const host = window.document.createElement('div') as unknown as HTMLDivElement;
    window.document.body.append(host);
    const root = createRoot(host);
    const canvas = within(host);
    const user = userEvent.setup({ document: window.document as unknown as Document });
    const click = async (name: string) => {
      await act(async () => user.click(canvas.getByRole('button', { name })));
    };
    const page = structuredClone(snapshot);
    let pending = Promise.withResolvers<Identity | null>();
    const lookup = mock(() => (pending = Promise.withResolvers<Identity | null>()).promise);
    const save = mock(async (_change: Change) => ({ status: 'saved' as const }));
    const io = { lookup, save, read: async (): Promise<AccessState> => ({ status: 'ready', page }) };
    try {
      await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
      await click(m.access_add_grant());
      await act(async () => user.type(canvas.getByLabelText(m.access_handle()), 'old'));
      await click(m.access_find_account());
      const old = pending;
      if (boundary === 'handle') await act(async () => user.clear(canvas.getByLabelText(m.access_handle())));
      else if (boundary === 'kind')
        await act(async () => user.selectOptions(canvas.getByLabelText(m.access_recipient()), 'organization'));
      else {
        if (boundary === 'cancel') {
          await click(m.access_cancel());
          const prompt = within(window.document.body as unknown as HTMLElement).getByRole('alertdialog');
          await act(async () => user.click(within(prompt).getAllByRole('button')[1]!));
        }
        else {
          if (boundary === 'resource') page.resource.id = '0192f3a0-6c1e-7b2a-a001-000100000099';
          else page.authority.accountId = page.identities[1]!.id;
          await click(m.access_reload());
          const prompt = within(window.document.body as unknown as HTMLElement).getByRole('alertdialog');
          await act(async () => user.click(within(prompt).getAllByRole('button')[1]!));
        }
        await click(m.access_add_grant());
      }
      await act(async () => user.clear(canvas.getByLabelText(m.access_handle())));
      await act(async () => user.type(canvas.getByLabelText(m.access_handle()), 'current'));
      await act(async () => user.selectOptions(canvas.getByLabelText(m.access_grant_kind()), 'direct'));
      await act(async () => user.selectOptions(canvas.getByLabelText(m.access_action()), 'collection:update'));
      await act(async () =>
        fireEvent.change(canvas.getByLabelText(m.access_ends()), { target: { value: '2027-01-01T12:30' } }),
      );
      await click(m.access_find_account());
      await act(async () => pending.reject(new Error('Read unavailable')));
      expect(canvas.getByRole('alert').textContent).toBe(m.access_unavailable());
      expect((canvas.getByLabelText(m.access_ends()) as HTMLInputElement).value).toBe('2027-01-01T12:30');
      await click(m.access_find_account());
      if (boundary !== 'handle') await act(async () => old.reject(new Error('Stale failure')));
      expect((canvas.getByRole('button', { name: m.access_review_title() }) as HTMLButtonElement).disabled).toBe(true);
      const current = {
        ...snapshot.identities[1]!,
        kind: boundary === 'kind' ? ('organization' as const) : ('actor' as const),
      };
      await act(async () => pending.resolve(current));
      if (boundary === 'handle') await act(async () => old.resolve(snapshot.identities[0]!));
      await click(m.access_review_title());
      expect(save).not.toHaveBeenCalled();
      await click(m.access_review_confirm());
      expect(save.mock.calls[0]?.[0]).toMatchObject({
        resourceId: page.resource.id,
        actions: ['collection:update'],
        subject: { kind: boundary === 'kind' ? 'organization' : 'account', id: current.id },
      });
      await click(m.access_grant_actions());
      await act(async () =>
        user.click(within(window.document.body as unknown as HTMLElement).getByText(m.access_edit_grant())),
      );
      await click(m.access_review_title());
      expect(save).toHaveBeenCalledTimes(1);
      await click(m.access_review_confirm());
      expect(save.mock.calls[1]?.[0]).toMatchObject({
        subject: snapshot.grants[0]!.subject,
        previous: { valid: snapshot.grants[0]!.valid },
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
