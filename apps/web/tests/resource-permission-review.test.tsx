import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { interval, type AccessIO, type AccessSnapshot, type Change } from '../src/accounts/resource-access/data';
import { permissionSnapshot, snapshot } from '../src/stories/pages/accounts-resource-access/fixtures';

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

test('permission filtering, review, and confirmation preserve exact native actions and interval values', async () => {
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const canvas = within(host);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const page = structuredClone(permissionSnapshot);
  const saves: Change[] = [];
  const io: AccessIO = {
    read: mock(async () => ({ status: 'ready' as const, page: structuredClone(page) })),
    save: mock(async (change: Change) => {
      saves.push(structuredClone(change));
      return { status: 'saved' as const };
    }),
    lookup: mock(async () => structuredClone(snapshot.identities[1]!)),
  };
  const click = async (name: string, scope = canvas) => {
    await act(async () => user.click(scope.getByRole('button', { name })));
  };
  try {
    await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
    const row = within(canvas.getByRole('heading', { level: 3, name: 'Aki' }).closest('li')!);
    await click(m.access_grant_actions(), row);
    await act(async () =>
      user.click(within(window.document.body as unknown as HTMLElement).getByText(m.access_edit_grant())),
    );

    const permission = canvas.getByLabelText(m.access_action());
    const filter = canvas.getByLabelText(m.access_search_permissions());
    await act(async () => user.selectOptions(permission, 'context:adopt'));
    await act(async () => user.type(filter, 'accept'));
    expect((permission as HTMLSelectElement).value).toBe('context:adopt');
    expect(io.save).not.toHaveBeenCalled();
    await act(async () =>
      fireEvent.change(canvas.getByLabelText(m.access_ends()), { target: { value: '2027-01-01T12:30' } }),
    );
    const proposedInterval = interval(
      (canvas.getByLabelText(m.access_starts()) as HTMLInputElement).value,
      '2027-01-01T12:30',
    )!;
    await click(m.access_review_title());
    let review = canvas.getByRole('region', { name: m.access_review_title() });
    expect(within(review).getByText(m.access_permission_context_accept())).toBeTruthy();
    expect(within(review).getByText('context:accept', { selector: 'code' })).toBeTruthy();
    expect(within(review).getByText(m.access_permission_context_adopt())).toBeTruthy();
    expect(within(review).getByText('context:adopt', { selector: 'code' })).toBeTruthy();
    expect(within(review).getByText(proposedInterval, { selector: 'code' })).toBeTruthy();
    expect(io.save).not.toHaveBeenCalled();

    await click(m.access_review_edit());
    expect((permission as HTMLSelectElement).value).toBe('context:adopt');
    expect((canvas.getByLabelText(m.access_ends()) as HTMLInputElement).value).toBe('2027-01-01T12:30');
    await act(async () => user.selectOptions(permission, 'context:accept'));
    expect(canvas.queryByRole('button', { name: m.access_review_confirm() })).toBeNull();
    await act(async () => user.selectOptions(permission, 'context:adopt'));
    await click(m.access_review_title());
    review = canvas.getByRole('region', { name: m.access_review_title() });
    await click(m.access_review_confirm(), within(review));
    expect(saves[0]).toMatchObject({
      operation: 'change',
      kind: 'direct',
      actions: ['context:adopt'],
      previous: { role: null, actions: ['context:accept'], valid: page.grants[0]!.valid },
      valid: proposedInterval,
    });

    await click(m.access_add_grant());
    await act(async () => user.selectOptions(canvas.getByLabelText(m.access_recipient()), 'active_accounts'));
    await act(async () => user.selectOptions(canvas.getByLabelText(m.access_grant_kind()), 'direct'));
    await act(async () => user.selectOptions(canvas.getByLabelText(m.access_action()), 'context:accept'));
    await click(m.access_review_title());
    review = canvas.getByRole('region', { name: m.access_review_title() });
    expect(within(review).getAllByText(m.access_active_accounts()).length).toBeGreaterThan(0);
    expect(within(review).getByText(m.access_permission_context_accept())).toBeTruthy();
    await click(m.access_review_confirm(), within(review));
    expect(saves.map((change) => change.actions)).toEqual([['context:adopt'], ['context:accept']]);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('installed governance, author, and ballot roles show their returned expansion; unknown names retain their identifiers', async () => {
  const governanceActions = [
    'access:grant',
    'gate:any',
    'exposure:open',
    'exposure:close',
    'exposure:manage_read',
    'account:assign_reserved_handle',
    'account:suspend',
    'account:reinstate',
    'account:set_rate_tier',
    'account:verify_agent',
    'account:renew_cleanup',
    'account:read_erasure',
    'client:manage',
    'organization:create',
    'subject:create',
    'subject:batch_write',
    'source_statistic:write',
    'source_fence:read',
    'source_fence:takedown',
    'media:import_from_url',
    'definitions:publish',
    'definitions:activate',
    'presentation:publish',
    'presentation:activate',
    'context:create',
    'statement:propose',
    'context:accept',
    'context:adopt',
    'subject:merge',
    'moderation:hide',
    'moderation:takedown',
    'moderation:read_reports',
    'post:erase',
    'media:erase',
    'offer:create',
    'payout_statement:mark_paid',
    'space:create',
    'space:restore',
    'realm:create',
    'realm:restore',
    'realm:approve_claim',
    'zone:create',
  ];
  const cases: {
    resourceType: string;
    role: string;
    label: string;
    actions: string[];
  }[] = [
    {
      resourceType: 'semantic.context',
      role: 'platform.governance',
      label: m.access_role_governance(),
      actions: governanceActions,
    },
    {
      resourceType: 'semantic.revision',
      role: 'semantic.revision.author',
      label: m.access_role_revision_author(),
      actions: ['statement:delete', 'statement:restore'],
    },
    {
      resourceType: 'semantic.subject',
      role: 'semantic.subject.classification_ballot_standing',
      label: m.access_role_ballot_standing(),
      actions: ['classification_ballot:set', 'classification_ballot:read_own'],
    },
    {
      resourceType: 'semantic.subject',
      role: 'future.review_role',
      label: m.access_role_installed(),
      actions: ['future:first', 'future:second'],
    },
  ];
  for (const item of cases) {
    const host = window.document.createElement('div') as unknown as HTMLDivElement;
    window.document.body.append(host);
    const root = createRoot(host);
    const canvas = within(host);
    const page: AccessSnapshot = structuredClone(snapshot);
    page.resource.type = item.resourceType;
    page.roles = [{ id: item.role, actions: item.actions, delegable: false }];
    page.actions = [];
    page.grants = [
      {
        ...snapshot.grants[0]!,
        kind: 'role',
        role: item.role,
        actions: item.actions,
        manageable: false,
      },
    ];
    const io: AccessIO = {
      read: mock(async () => ({ status: 'ready' as const, page })),
      save: mock(async () => ({ status: 'refused' as const })),
      lookup: mock(async () => null),
    };
    try {
      await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
      const row = within(canvas.getByRole('heading', { level: 3, name: 'Aki' }).closest('li')!);
      expect(row.getAllByText(item.label).length).toBeGreaterThan(0);
      for (const action of item.actions) expect(row.getByText(action, { selector: 'code' })).toBeTruthy();
      if (item.role === 'platform.governance')
        expect(row.getByText(m.access_permission_account_suspend())).toBeTruthy();
      if (item.role === 'future.review_role') {
        expect(row.getByText('future:first', { selector: 'code' })).toBeTruthy();
        expect(row.getByText('future:second', { selector: 'code' })).toBeTruthy();
        expect(row.getAllByText(m.access_permission_unknown()).length).toBe(2);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('a native conflict refreshes the visible row and requires a fresh review', async () => {
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const canvas = within(host);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const page = structuredClone(permissionSnapshot);
  const saves: Change[] = [];
  const io: AccessIO = {
    read: mock(async () => ({ status: 'ready' as const, page: structuredClone(page) })),
    save: mock(async (change: Change) => {
      saves.push(structuredClone(change));
      if (saves.length === 1) {
        page.grants[0] = { ...page.grants[0]!, actions: ['context:adopt'] };
        return { status: 'conflict' as const };
      }
      return { status: 'saved' as const };
    }),
    lookup: mock(async () => null),
  };
  const click = async (name: string, scope = canvas) => {
    await act(async () => user.click(scope.getByRole('button', { name })));
  };
  const editCurrent = async () => {
    const row = within(canvas.getByRole('heading', { level: 3, name: 'Aki' }).closest('li')!);
    await click(m.access_grant_actions(), row);
    await act(async () => user.click(within(window.document.body).getByText(m.access_edit_grant())));
    return canvas.getByLabelText(m.access_action());
  };
  try {
    await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
    const permission = await editCurrent();
    await act(async () => user.selectOptions(permission, 'context:adopt'));
    await click(m.access_review_title());
    await click(m.access_review_confirm(), within(canvas.getByRole('region', { name: m.access_review_title() })));
    expect(canvas.getByRole('status').textContent).toBe(m.access_conflict());
    expect(canvas.getAllByText('context:adopt', { selector: 'code' }).length).toBeGreaterThan(0);
    expect(saves).toHaveLength(1);

    const currentPermission = await editCurrent();
    await act(async () => user.selectOptions(currentPermission, 'context:accept'));
    await click(m.access_review_title());
    const review = canvas.getByRole('region', { name: m.access_review_title() });
    expect(within(review).getByText(m.access_permission_context_accept())).toBeTruthy();
    expect(saves).toHaveLength(1);
    await click(m.access_review_confirm(), within(review));
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ actions: ['context:accept'], previous: { actions: ['context:adopt'] } });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('removal review names the exact direct permission or returned role bundle before dispatch', async () => {
  const cases = [
    { kind: 'direct' as const, role: null, actions: ['context:accept'] },
    {
      kind: 'role' as const,
      role: 'semantic.context.owner',
      actions: ['context:accept', 'context:adopt', 'access:grant', 'context:delete', 'context:restore'],
    },
  ];
  for (const item of cases) {
    const host = window.document.createElement('div') as unknown as HTMLDivElement;
    window.document.body.append(host);
    const root = createRoot(host);
    const canvas = within(host);
    const user = userEvent.setup({ document: window.document as unknown as Document });
    const page = structuredClone(permissionSnapshot);
    page.grants = [
      {
        ...snapshot.grants[0]!,
        kind: item.kind,
        role: item.role,
        actions: item.actions,
        manageable: true,
      },
    ];
    const saves: Change[] = [];
    const io: AccessIO = {
      read: mock(async () => ({ status: 'ready' as const, page: structuredClone(page) })),
      save: mock(async (change: Change) => {
        saves.push(structuredClone(change));
        return { status: 'saved' as const };
      }),
      lookup: mock(async () => null),
    };
    try {
      await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
      const row = within(canvas.getByRole('heading', { level: 3, name: 'Aki' }).closest('li')!);
      await act(async () => user.click(row.getByRole('button', { name: m.access_grant_actions() })));
      await act(async () => user.click(within(window.document.body).getByText(m.access_revoke())));
      const dialog = within(within(window.document.body as unknown as HTMLElement).getByRole('alertdialog'));
      expect(
        dialog.getAllByText(item.kind === 'role' ? m.access_named_role() : m.access_direct_action()).length,
      ).toBeGreaterThan(0);
      for (const action of item.actions) expect(dialog.getByText(action, { selector: 'code' })).toBeTruthy();
      expect(saves).toHaveLength(0);
      await act(async () => user.click(dialog.getByRole('button', { name: m.access_revoke() })));
      expect(saves[0]).toMatchObject({
        operation: 'revoke',
        kind: item.kind,
        role: item.role,
        actions: item.actions,
        subject: snapshot.grants[0]!.subject,
        valid: snapshot.grants[0]!.valid,
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  }
});

test('returned nondelegable roles are disabled and cannot enter a review or dispatch', async () => {
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const canvas = within(host);
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const page = structuredClone(permissionSnapshot);
  page.actions = ['context:accept', 'context:adopt'];
  page.roles[0]!.delegable = false;
  const save = mock(async () => ({ status: 'saved' as const }));
  const io: AccessIO = {
    read: mock(async () => ({ status: 'ready' as const, page })),
    save,
    lookup: mock(async () => null),
  };
  try {
    await act(async () => root.render(<ResourceAccessPage initial={{ status: 'ready', page }} io={io} />));
    await act(async () => user.click(canvas.getByRole('button', { name: m.access_add_grant() })));
    await act(async () => user.selectOptions(canvas.getByLabelText(m.access_recipient()), 'active_accounts'));
    const role = canvas.getByLabelText(m.access_role()) as HTMLSelectElement;
    expect(role.querySelector('option[value="semantic.context.owner"]')?.disabled).toBe(true);
    await act(async () => fireEvent.change(role, { target: { value: 'semantic.context.owner' } }));
    await act(async () => user.click(canvas.getByRole('button', { name: m.access_review_title() })));
    expect(canvas.getByRole('alert').textContent).toBe(m.access_form_invalid());
    expect(canvas.queryByRole('button', { name: m.access_review_confirm() })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
