import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { AccessState, Change, Identity } from '../src/accounts/resource-access/data';
import { snapshot } from '../src/stories/pages/accounts-resource-access/fixtures';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/accounts/resource-access' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, value });
const { createRoot } = await import('react-dom/client');
const { within, userEvent } = await import('storybook/test');
const { ResourceAccessPage } = await import('../src/accounts/resource-access/page');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const locale = getLocale();
setLocale('en', { reload: false });
afterAll(async () => {
  setLocale(locale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous)
    descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
});

for (const boundary of ['handle', 'kind', 'cancel', 'resource', 'actor'] as const)
  test(`lookup cannot outlive ${boundary}; retry preserves the draft and saves the reviewed recipient`, async () => {
    const host = window.document.createElement('div') as unknown as HTMLDivElement;
    window.document.body.append(host);
    const root = createRoot(host),
      canvas = within(host);
    const user = userEvent.setup({ document: window.document as unknown as Document });
    const click = async (name: string) => {
      await act(async () => user.click(canvas.getByRole('button', { name })));
    };
    const page = structuredClone(snapshot);
    let resolve!: (identity: Identity | null) => void, reject!: (error: Error) => void;
    const lookup = mock(
      () =>
        new Promise<Identity | null>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
    );
    const save = mock(async (_change: Change) => ({ status: 'saved' as const }));
    const io = { lookup, save, read: async (): Promise<AccessState> => ({ status: 'ready', page }) };
    try {
      await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
      await click(m.access_add_grant());
      await act(async () => user.type(canvas.getByLabelText(m.access_handle()), 'old'));
      await click(m.access_find_account());
      expect((canvas.getByRole('button', { name: m.access_save() }) as HTMLButtonElement).disabled).toBe(true);
      const oldResolve = resolve,
        oldReject = reject;
      if (boundary === 'handle') await act(async () => user.clear(canvas.getByLabelText(m.access_handle())));
      else if (boundary === 'kind')
        await act(async () => user.selectOptions(canvas.getByLabelText(m.access_recipient()), 'organization'));
      else {
        if (boundary === 'cancel') await click(m.access_cancel());
        else {
          if (boundary === 'resource') page.resource.id = '0192f3a0-6c1e-7b2a-a001-000100000099';
          else page.authority.accountId = page.identities[1]!.id;
          await click(m.access_reload());
        }
        await click(m.access_add_grant());
      }
      await act(async () => user.clear(canvas.getByLabelText(m.access_handle())));
      await act(async () => user.type(canvas.getByLabelText(m.access_handle()), 'current'));
      await act(async () => user.selectOptions(canvas.getByLabelText(m.access_grant_kind()), 'direct'));
      await act(async () => user.selectOptions(canvas.getByLabelText(m.access_action()), 'collection:update'));
      await act(async () => user.type(canvas.getByLabelText(m.access_ends()), '2027-01-01T12:30'));
      const end = (canvas.getByLabelText(m.access_ends()) as HTMLInputElement).value;
      expect(end).toBe('2027-01-01T12:30');
      await click(m.access_find_account());
      await act(async () => reject(new Error('Read unavailable')));
      expect(canvas.getByRole('alert').textContent).toBe(m.access_unavailable());
      expect((canvas.getByLabelText(m.access_ends()) as HTMLInputElement).value).toBe(end);
      await click(m.access_find_account());
      await act(async () =>
        boundary === 'kind' ? oldReject(new Error('Stale failure')) : oldResolve(snapshot.identities[0]!),
      );
      expect((canvas.getByRole('button', { name: m.access_save() }) as HTMLButtonElement).disabled).toBe(true);
      const current = {
        ...snapshot.identities[1]!,
        kind: boundary === 'kind' ? ('organization' as const) : ('actor' as const),
      };
      await act(async () => resolve(current));
      await click(m.access_save());
      expect(save.mock.calls[0]?.[0]).toMatchObject({
        resourceId: page.resource.id,
        actions: ['collection:update'],
        subject: { kind: boundary === 'kind' ? 'organization' : 'account', id: current.id },
      });
      expect(save.mock.calls).toHaveLength(1);
      await click(m.access_grant_actions());
      await act(async () =>
        user.click(within(window.document.body as unknown as HTMLElement).getByText(m.access_edit_grant())),
      );
      await click(m.access_save());
      expect(save.mock.calls[1]?.[0]).toMatchObject({
        subject: snapshot.grants[0]!.subject,
        previous: { valid: snapshot.grants[0]!.valid },
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
