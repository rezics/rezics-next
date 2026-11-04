import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, type ReactNode } from 'react';
import type { AccessIO, AccessSnapshot, AccessState, Identity } from '../src/accounts/resource-access/data';
import type { OwnerTransfer } from '../src/accounts/resource-access/owner-transfer.ts';
import { snapshot, managerId, readerId } from '../src/stories/pages/accounts-resource-access/fixtures';

// UNRUN. Actual React renderer assertions; neither Happy DOM nor authored stories establish browser/native proof.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/accounts/resource-access', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  CSS: window.CSS,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { within, userEvent } = await import('storybook/test');
const { ResourceAccessPage } = await import('../src/accounts/resource-access/page');
const { OwnerTransferForm } = await import('../src/accounts/resource-access/owner-transfer.tsx');
const { realmOwnerRole, transferOwner } = await import('../src/accounts/resource-access/owner-transfer.ts');
const { m } = await import('../src/paraglide/messages.js');
const { getLocale, setLocale } = await import('../src/paraglide/runtime.js');
const previousLocale = getLocale();
const user = userEvent.setup({ document: window.document as unknown as Document });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  setLocale('en', { reload: false });
  host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
afterAll(async () => {
  setLocale(previousLocale, { reload: false });
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
const show = async (node: ReactNode) => {
  await act(async () => root.render(node));
};
function activeIdentity(id: string) {
  const identity = snapshot.identities.find((item) => item.id === id);
  if (identity?.state !== 'active') throw new Error('Expected active illustrative identity');
  return identity;
}
function ioFor(page: AccessSnapshot) {
  return {
    read: mock(async (): Promise<AccessState> => ({ status: 'ready', page: structuredClone(page) })),
    save: mock(async () => ({ status: 'refused' as const })),
    lookup: mock(async (): Promise<Identity | null> => structuredClone(snapshot.identities[1]!)),
    transfer: mock(async () => ({ status: 'refused' as const, current: { status: 'denied' as const } })),
  };
}
function realm(): AccessSnapshot {
  const page = structuredClone(snapshot);
  page.resource.type = 'community.realm';
  page.roles = [{ id: realmOwnerRole, actions: ['realm:read', 'access:grant'], delegable: true }];
  page.grants = [
    { ...page.grants[0]!, kind: 'role', role: realmOwnerRole, subject: { kind: 'account', id: managerId } },
  ];
  return page;
}
async function details(element: HTMLElement, expected: Array<string | number>) {
  const summary = within(element).getByText(m.access_identity_details(), { selector: 'summary' });
  const panel = summary.closest('details')!;
  expect(panel.getAttribute('aria-label')).toBe(m.access_identity_details());
  expect(panel.open).toBe(false);
  await act(async () => {
    summary.focus();
    await user.keyboard('{Enter}');
  });
  expect(window.document.activeElement).toBe(summary);
  expect(panel.open).toBe(true);
  const values = [...panel.querySelectorAll('dd')];
  expect(values.map((node) => node.textContent)).toEqual(expected.map(String));
  for (const node of values) {
    expect(node.previousElementSibling?.tagName).toBe('DT');
    expect(node.classList.contains('select-all')).toBe(true);
    expect(node.classList.contains('break-all')).toBe(true);
    expect(node.classList.contains('whitespace-normal')).toBe(true);
    expect(node.tabIndex).toBe(0);
    node.focus();
    expect(window.document.activeElement).toBe(node);
  }
  await act(async () => {
    summary.focus();
    await user.keyboard(' ');
  });
  expect(panel.open).toBe(false);
}

for (const width of [390, 1280])
  test(`full 20-grant/22-identity DTO keeps long labels and references at ${width} without added reads`, async () => {
    window.happyDOM.setWindowSize({ width, height: 900 });
    const page = structuredClone(snapshot);
    const long = '読書会 · Cercle de lecture · 독서 모임 · ' + '共同研究'.repeat(60);
    page.identities.push(
      ...Array.from({ length: 20 }, (_, index) => ({
        ...activeIdentity(readerId),
        id: `0192f3a0-6c1e-7b2a-a001-${String(300000000 + index).padStart(12, '0')}`,
        displayName: `${long} ${index}`,
      })),
    );
    page.grants = page.identities
      .slice(2)
      .map((identity) => ({ ...page.grants[0]!, subject: { kind: 'account', id: identity.id } }));
    page.authority.principalId = readerId;
    const io = ioFor(page);
    await show(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />);
    const canvas = within(host);
    expect(canvas.getByRole('heading', { name: m.library_following_kind_collection() }).textContent).toBe('Collection');
    expect(canvas.getByText(m.access_acting_as({ name: 'Mira' })).closest('details')).toBeNull();
    expect(canvas.getByText(m.access_delegated_by({ name: 'Aki' })).closest('details')).toBeNull();
    const rows = canvas.getAllByRole('heading', { level: 3 }).map((heading) => heading.closest('li')!);
    expect(rows).toHaveLength(20);
    for (const [index, row] of rows.entries()) {
      expect(within(row).getAllByRole('heading')).toHaveLength(1);
      expect(row.querySelector('h3')!.textContent).toBe(`${long} ${index}`);
      expect(row.className).toContain('[&_[data-content-item-slot=title]]:line-clamp-none');
      expect(row.className).toContain('[&_[data-content-item-slot=title]]:[overflow-wrap:anywhere]');
      expect(row.querySelector('a')).toBeNull();
      for (let repeat = 0; repeat < 2; repeat++)
        await details(row, [page.identities[index + 2]!.id, page.grants[index]!.valid]);
    }
    await details(canvas.getByRole('region', { name: m.access_resource() }), [
      page.resource.id,
      page.resource.type,
      page.resource.route,
      managerId,
      readerId,
    ]);
    expect(io.read.mock.calls).toHaveLength(0);
    expect(io.lookup.mock.calls).toHaveLength(0);
    expect(io.save.mock.calls).toHaveLength(0);
    expect(io.transfer.mock.calls).toHaveLength(0);
    // Real wrapping geometry is authored in both canonical browser stories, and remains UNRUN.
  });

test('missing identity is unavailable, only explicit deletion is tombstoned, and exact IDs remain keyboard reachable', async () => {
  const page = structuredClone(snapshot);
  const missing = '0192f3a0-6c1e-7b2a-a001-000200000099';
  page.identities[1]!.state = 'deleted'; // Deliberately retain stale display fields to detect accidental disclosure.
  page.authority.accountId = missing;
  page.authority.principalId = missing;
  page.resource.type = 'illustrative.unsupported_' + 'exact_type_'.repeat(40);
  page.grants.push({ ...page.grants[0]!, subject: { kind: 'account', id: missing }, manageable: false });
  const unnamed = '0192f3a0-6c1e-7b2a-a001-000200000098';
  page.identities.push({ ...activeIdentity(managerId), id: unnamed, handle: null, displayName: null });
  page.grants.push({ ...page.grants[0]!, subject: { kind: 'account', id: unnamed }, manageable: false });
  const io = ioFor(page);
  await show(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />);
  const canvas = within(host);
  const rows = canvas.getAllByRole('heading', { level: 3 }).map((heading) => heading.closest('li')!);
  expect(rows).toHaveLength(3);
  expect(within(rows[0]!).getByRole('heading', { level: 3 }).textContent).toBe(m.access_deleted_account());
  expect(rows[0]!.querySelector('[data-slot="tombstone"]')).not.toBeNull();
  expect(within(rows[1]!).getByRole('heading', { level: 3 }).textContent).toBe(m.access_unknown_account());
  expect(rows[1]!.querySelector('[data-slot="tombstone"]')).toBeNull();
  expect(within(rows[2]!).getByRole('heading', { level: 3 }).textContent).toBe(m.access_unknown_account());
  expect(rows[2]!.querySelector('[data-slot="tombstone"]')).toBeNull();
  expect(within(rows[1]!).queryByRole('button', { name: m.access_grant_actions() })).toBeNull();
  expect(host.innerHTML).not.toContain('Aki');
  expect(host.innerHTML).not.toContain('@aki');
  expect(canvas.getByText(m.access_acting_as({ name: m.access_unknown_account() })).closest('details')).toBeNull();
  expect(canvas.getByText(m.access_delegated_by({ name: m.access_unknown_account() })).closest('details')).toBeNull();
  expect(canvas.getByRole('heading', { name: m.access_resource() })).toBeTruthy();
  await details(rows[1]!, [missing, page.grants[1]!.valid]);
  await details(rows[2]!, [unnamed, page.grants[2]!.valid]);
  await details(canvas.getByRole('region', { name: m.access_resource() }), [
    page.resource.id,
    page.resource.type,
    page.resource.route,
    missing,
    missing,
  ]);
  expect(io.read.mock.calls).toHaveLength(0);
  expect(io.lookup.mock.calls).toHaveLength(0);
});

test('organization and unnamed Realm owner/member groups keep human qualification and exact subject provenance', async () => {
  const page = structuredClone(snapshot);
  page.mutationState = 'realm_guard_unavailable';
  page.actions = [];
  page.roles = [];
  page.grants = (['organization', 'realm'] as const).flatMap((kind) =>
    (['owner', 'member'] as const).map((role) => ({
      ...snapshot.grants[0]!,
      subject: { kind, id: kind === 'realm' ? page.resource.id : readerId, role },
      manageable: false,
    })),
  );
  await show(<ResourceAccessPage initial={{ status: 'ready', page }} io={ioFor(page)} />);
  const canvas = within(host);
  const rows = canvas.getAllByRole('heading', { level: 3 }).map((heading) => heading.closest('li')!);
  expect(rows.map((row) => within(row).getByRole('heading', { level: 3 }).textContent)).toEqual([
    `Aki · ${m.access_org_owners()}`,
    `Aki · ${m.access_org_members()}`,
    m.access_realm_owners(),
    m.access_realm_members(),
  ]);
  expect(canvas.getByText(m.access_realm_guard()).closest('details')).toBeNull();
  for (const [index, row] of rows.entries()) {
    expect(row.querySelector('a')).toBeNull();
    expect(within(row).queryByRole('button', { name: m.access_grant_actions() })).toBeNull();
    await details(row, [index < 2 ? readerId : page.resource.id, page.grants[index]!.valid]);
  }
});

async function selectTransfer() {
  const canvas = within(host);
  await act(async () => user.click(canvas.getByRole('button', { name: m.access_grant_actions() })));
  const item = await within(window.document.body as unknown as HTMLElement).findByText(m.access_transfer_owner(), {
    selector: '[role="menuitem"], button',
  });
  await act(async () => user.click(item));
}
async function reviewTransfer() {
  const canvas = within(host);
  await act(async () => user.type(canvas.getByLabelText(m.access_handle()), 'aki'));
  await act(async () => user.click(canvas.getByRole('button', { name: m.access_find_account() })));
  await act(async () => user.click(canvas.getByRole('button', { name: m.access_transfer_owner() })));
  return within(window.document.body as unknown as HTMLElement).getByRole('alertdialog');
}

test('unavailable reload and current grant/permission retirement remove stale identities and transfer controls', async () => {
  const page = realm();
  let current: AccessState = { status: 'ready', page };
  let finish: ((value: AccessState) => void) | undefined;
  const io = {
    ...ioFor(page),
    read: mock(
      () =>
        new Promise<AccessState>((resolve) => {
          finish = resolve;
        }),
    ),
  };
  await show(<ResourceAccessPage initial={{ status: 'unavailable' }} io={io} />);
  const canvas = within(host);
  expect(canvas.getByRole('alert').textContent).toBe(m.access_unavailable());
  await act(async () => user.click(canvas.getByRole('button', { name: m.access_reload() })));
  await act(async () => finish!(current));
  await selectTransfer();
  expect(canvas.getByRole('heading', { name: m.access_transfer_owner() })).toBeTruthy();
  for (const next of [
    { status: 'ready', page: { ...page, grants: [] } },
    {
      status: 'ready',
      page: {
        ...page,
        roles: page.roles.map((role) => ({ ...role, delegable: false })),
        grants: page.grants.map((grant) => ({ ...grant, manageable: false })),
      },
    },
    { status: 'denied' },
  ] satisfies AccessState[]) {
    current = next;
    await act(async () => user.click(canvas.getByRole('button', { name: m.access_reload() })));
    expect(host.innerHTML).not.toContain(page.resource.id);
    expect(host.innerHTML).not.toContain(managerId);
    expect(canvas.queryByRole('heading', { name: m.access_transfer_owner() })).toBeNull();
    await act(async () => finish!(current));
    expect(canvas.queryByRole('button', { name: m.access_grant_actions() })).toBeNull();
  }
  expect(canvas.queryByRole('heading', { level: 3 })).toBeNull();
  expect(host.innerHTML).not.toContain('Mira');
  expect(io.read.mock.calls).toHaveLength(4);
  expect(io.lookup.mock.calls).toHaveLength(0);
  expect(io.transfer.mock.calls).toHaveLength(0);
});

for (const state of ['missing', 'deleted'] as const)
  test(`transfer review keeps ${state} source honest and exact callback operands visible before confirmation`, async () => {
    const page = realm();
    page.identities = page.identities.filter((identity) => identity.id !== managerId);
    if (state === 'deleted') page.identities.push({ id: managerId, state: 'deleted', kind: 'actor' });
    const io = ioFor(page);
    const onConfirm = mock();
    await show(
      <OwnerTransferForm page={page} grant={page.grants[0]!} io={io} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    const element = await reviewTransfer();
    const dialog = within(element);
    expect(
      dialog
        .getByText((text) =>
          text.includes(state === 'deleted' ? m.access_deleted_account() : m.access_unknown_account()),
        )
        .closest('details'),
    ).toBeNull();
    const values = [...element.querySelectorAll('dd')];
    expect(values.map((node) => node.textContent)).toEqual([
      'Realm',
      page.resource.id,
      page.resource.type,
      String(page.resource.route),
      managerId,
      readerId,
      page.grants[0]!.valid,
    ]);
    for (const value of values) {
      expect(value.closest('details, [hidden]')).toBeNull();
      expect(value.classList.contains('select-all')).toBe(true);
      expect(value.classList.contains('break-all')).toBe(true);
    }
    expect(element.textContent).toContain(m.access_transfer_responsibility());
    expect(onConfirm.mock.calls).toHaveLength(0);
    await act(async () => user.click(dialog.getByRole('button', { name: m.access_transfer_owner() })));
    expect(JSON.stringify(onConfirm.mock.calls[0]![0])).toBe(
      JSON.stringify({
        resource: { id: page.resource.id, route: page.resource.route },
        fromAccountId: managerId,
        toAccountId: readerId,
        previousValid: page.grants[0]!.valid,
      }),
    );
    expect(io.read.mock.calls).toHaveLength(0);
    expect(io.lookup.mock.calls).toHaveLength(1);
  });

test('actual page confirmation and uncertain retry send byte-identical original operands, key and credential without extra reads', async () => {
  const page = realm();
  const originalValid = page.grants[0]!.valid;
  const commands: { body: string; key: string | null; authorization: string | null; input: OwnerTransfer }[] = [];
  let effects = 0;
  const read = mock(async (): Promise<AccessState> => ({ status: 'ready', page: structuredClone(page) }));
  const io: AccessIO = {
    ...ioFor(page),
    read,
    transfer: (input) =>
      transferOwner('https://kernel.test', 'Bearer original', input, read, (async (_url, init) => {
        const headers = new Headers(init?.headers);
        commands.push({
          body: String(init?.body),
          key: headers.get('idempotency-key'),
          authorization: headers.get('authorization'),
          input: structuredClone(input),
        });
        if (commands.length === 1) {
          effects++;
          page.grants = [{ ...page.grants[0]!, subject: { kind: 'account', id: readerId }, valid: '[2026-11-02,)' }];
          throw new Error('Response lost after effect');
        }
        return Response.json({
          roleGrant: {
            resource: input.resource,
            subject: { kind: 'account', id: readerId },
            role: realmOwnerRole,
            valid: page.grants[0]!.valid,
          },
        });
      }) as typeof fetch),
  };
  await show(<ResourceAccessPage initial={{ status: 'ready', page: structuredClone(page) }} io={io} />);
  await selectTransfer();
  const dialog = within(await reviewTransfer());
  expect(commands).toHaveLength(0);
  expect(read.mock.calls).toHaveLength(0);
  await act(async () => user.click(dialog.getByRole('button', { name: m.access_transfer_owner() })));
  const canvas = within(host);
  expect(canvas.getByRole('status').textContent).toBe(m.access_uncertain());
  expect(canvas.getByRole('status').closest('details')).toBeNull();
  expect(canvas.getByRole('heading', { level: 3 }).textContent).toBe('Aki');
  expect(read.mock.calls).toHaveLength(2);
  await details(canvas.getByRole('heading', { level: 3 }).closest('li')!, [readerId, realmOwnerRole, page.grants[0]!.valid]);
  expect(read.mock.calls).toHaveLength(2);
  await act(async () => user.click(canvas.getByRole('button', { name: m.access_retry_operation() })));
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]!.body).toBe(
    JSON.stringify({
      resource: { route: page.resource.route, id: page.resource.id },
      fromAccountId: managerId,
      toAccountId: readerId,
      previousValid: originalValid,
    }),
  );
  expect(commands[0]!.key).toBe(JSON.stringify(commands[0]!.input.key));
  expect(commands[0]!.authorization).toBe('Bearer original');
  expect(read.mock.calls).toHaveLength(4);
  expect(effects).toBe(1);
  expect(canvas.getByRole('status').textContent).toBe(m.access_saved());
  expect(canvas.queryByRole('button', { name: m.access_retry_operation() })).toBeNull();
});
