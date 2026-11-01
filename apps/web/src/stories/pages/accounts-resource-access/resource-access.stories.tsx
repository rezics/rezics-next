import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { ResourceAccessPage } from '../../../accounts/resource-access/page';
import {
  loadAccess,
  writeAccess,
  lookupIdentity,
  type AccessIO,
  type AccessState,
  type Change,
} from '../../../accounts/resource-access/data';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import { snapshot } from './fixtures';

function Example({
  status = 'ready',
  scenario = 'current',
}: {
  status?: AccessState['status'];
  scenario?: 'current' | 'empty' | 'lost' | 'refused' | 'realm' | 'scheduled' | 'deleted-unknown' | 'organization';
}) {
  const [setup] = useState(() => {
    let page = structuredClone(snapshot);
    if (scenario === 'empty') page.grants = [];
    if (scenario === 'deleted-unknown') {
      page.identities[1]!.state = 'deleted';
      page.grants.push({
        ...page.grants[0]!,
        subject: { kind: 'account', id: '0192f3a0-6c1e-7b2a-a001-000200000099' },
        manageable: false,
      });
    }
    if (scenario === 'organization') {
      page.identities[1]!.kind = 'organization';
      page.grants = (['owner', 'member'] as const).map((role) => ({
        ...page.grants[0]!,
        subject: { kind: 'organization', id: page.identities[1]!.id, role },
      }));
    }
    if (scenario === 'scheduled')
      page.grants = [
        {
          ...page.grants[0]!,
          state: 'scheduled',
          startsAt: '2026-12-01T00:00:00.000Z',
          valid: '["2026-12-01 00:00:00+00",)',
        },
      ];
    if (scenario === 'realm') {
      page.resource.type = 'community.realm';
      page.mutationState = 'realm_guard_unavailable';
      page.actions = [];
      page.roles = [{ id: 'community.realm.standing', actions: ['realm:join', 'realm:participate'], delegable: false }];
      page.grants = [
        {
          ...page.grants[0]!,
          kind: 'role',
          subject: { kind: 'realm', id: page.resource.id, role: 'member' },
          role: 'community.realm.member',
          actions: ['realm:read', 'realm:participate'],
          manageable: false,
        },
      ];
    }
    const initial: AccessState = status === 'ready' ? { status, page: structuredClone(page) } : { status };
    const receipts = new Map<string, unknown>();
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === 'GET') {
          if (url.pathname === '/v1/accounts') return Response.json({ accounts: [page.identities[1]], next: null });
          return status === 'ready'
            ? Response.json(page)
            : Response.json({ type: 'not_found' }, { status: status === 'denied' ? 404 : 503 });
        }
        if (scenario === 'refused') return Response.json({ type: 'forbidden' }, { status: 403 });
        const key = request.headers.get('idempotency-key')!;
        if (receipts.has(key)) return Response.json(receipts.get(key));
        const body = (await request.json()) as Pick<Change, 'subject' | 'valid'> &
          Partial<Pick<Change, 'actions' | 'role'>>;
        if (url.pathname.endsWith(':revoke')) page.grants = [];
        else {
          const row = {
            state: 'active' as const,
            kind: url.pathname.includes('roleGrants') ? ('role' as const) : ('direct' as const),
            subject: body.subject,
            actions: body.actions ?? page.roles[0]!.actions,
            role: body.role ?? null,
            valid: body.valid,
            startsAt: null,
            endsAt: null,
            manageable: true,
          };
          page.grants = url.pathname.endsWith(':change') ? [row] : [...page.grants, row];
        }
        const receipt = { grant: body };
        receipts.set(key, receipt);
        if (scenario === 'lost') throw new Error('Story: response lost after effect');
        return Response.json(receipt, { status: url.pathname.includes(':') ? 200 : 201 });
      }) as typeof fetch,
    });
    const io: AccessIO = {
      read: (cursor) => loadAccess(client, 'Bearer story', page.resource.id, cursor),
      save: (change) => writeAccess(client, 'Bearer story', change),
      lookup: (handle) => lookupIdentity(client, 'Bearer story', handle),
    };
    return { initial, io };
  });
  return <ResourceAccessPage initial={setup.initial} io={setup.io} />;
}

const meta = {
  title: 'Pages/Account/Resource access',
  component: Example,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentAccess: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: m.access_heading() })).toBeVisible();
    const title = canvas.getByRole('heading', { level: 3, name: 'Aki' });
    const row = within(title.closest('li')!);
    await expect(title).toBeVisible();
    await expect(row.getAllByRole('heading')).toHaveLength(1);
    await expect(row.queryByRole('link')).toBeNull();
    const menu = row.getByRole('button', { name: m.access_grant_actions() });
    await expect(menu.closest('a, h3')).toBeNull();
    menu.focus();
    await expect(menu).toHaveFocus();
    await expect(menu.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
    await expect(menu.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await userEvent.click(canvas.getByRole('button', { name: m.access_grant_actions() }));
    await userEvent.click(await screen.findByText(m.access_edit_grant(), { selector: '[role="menuitem"], button' }));
    await userEvent.selectOptions(canvas.getByLabelText(m.access_action()), 'collection:update');
    await userEvent.click(canvas.getByRole('button', { name: m.access_save() }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_saved());
    await userEvent.click(canvas.getByRole('button', { name: m.access_add_grant() }));
    await userEvent.selectOptions(canvas.getByLabelText(m.access_recipient()), 'active_accounts');
    await userEvent.click(canvas.getByRole('button', { name: m.access_save() }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_saved());
    await expect(canvas.getByText(m.access_active_accounts())).toBeVisible();
  },
};
export const LostResponse: Story = {
  args: { scenario: 'lost' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.access_grant_actions() }));
    await userEvent.click(await screen.findByText(m.access_revoke(), { selector: '[role="menuitem"], button' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    await userEvent.click(dialog.getByRole('button', { name: m.access_revoke() }));
    await expect(canvas.getByRole('button', { name: m.access_retry_operation() })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.access_retry_operation() }));
    await expect(canvas.getByText(m.access_saved())).toBeVisible();
    await expect(canvas.getByText(m.access_empty())).toBeVisible();
  },
};
export const Refused: Story = {
  args: { scenario: 'refused' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: m.access_add_grant() }));
    await userEvent.selectOptions(canvas.getByLabelText(m.access_recipient()), 'active_accounts');
    await userEvent.click(canvas.getByRole('button', { name: m.access_save() }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_refused());
    await expect(canvas.getByText('Aki')).toBeVisible();
  },
};
export const Empty: Story = { args: { scenario: 'empty' } };
export const Denied: Story = { args: { status: 'denied' } };
export const Preparing: Story = { args: { status: 'preparing' } };
export const Unavailable: Story = { args: { status: 'unavailable' } };
export const Loading: Story = { args: { status: 'loading' } };
export const RealmGuard: Story = {
  args: { scenario: 'realm' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const title = canvas.getByRole('heading', {
      level: 3,
      name: `${snapshot.resource.id} · ${m.access_realm_members()}`,
    });
    const row = within(title.closest('li')!);
    await expect(title).toBeVisible();
    await expect(row.getByText(m.access_role_member())).toBeVisible();
    await expect(row.queryByRole('button')).toBeNull();
    await expect(row.queryByRole('link')).toBeNull();
    await expect(canvas.getByText(m.access_realm_guard())).toBeVisible();
  },
};

export const Scheduled: Story = {
  args: { scenario: 'scheduled' },
  play: async ({ canvasElement }) => {
    const row = within(within(canvasElement).getByRole('heading', { level: 3, name: 'Aki' }).closest('li')!);
    await expect(row.getByText(m.access_scheduled())).toBeVisible();
    await expect(row.getByText(m.access_direct_action())).toBeVisible();
    await expect(row.getByText(m.access_permission_read())).toBeVisible();
    await expect(
      row.getByText(
        m.access_valid_interval({
          start: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
            new Date('2026-12-01T00:00:00.000Z'),
          ),
          end: m.access_no_end(),
        }),
      ),
    ).toBeVisible();
    await expect(row.queryByRole('link')).toBeNull();
  },
};

export const DeletedAndUnknown: Story = {
  args: { scenario: 'deleted-unknown' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    const deleted = within(rows[0]!);
    await expect(deleted.getByRole('heading', { level: 3, name: m.access_deleted_account() })).toBeVisible();
    await expect(deleted.getByText(m.access_deleted_account(), { selector: 'p' })).toBeVisible();
    await expect(deleted.queryByText('Aki')).toBeNull();
    await expect(deleted.queryByText('@aki')).toBeNull();
    await expect(
      within(rows[1]!).getByRole('heading', { level: 3, name: '0192f3a0-6c1e-7b2a-a001-000200000099' }),
    ).toBeVisible();
    await expect(within(rows[1]!).queryByRole('button')).toBeNull();
    for (const row of rows) {
      await expect(within(row).getAllByRole('heading')).toHaveLength(1);
      await expect(within(row).queryByRole('link')).toBeNull();
    }
  },
};

export const OrganizationGroups: Story = {
  args: { scenario: 'organization' },
  play: async ({ canvasElement }) => {
    const rows = within(canvasElement).getAllByRole('listitem');
    await expect(rows).toHaveLength(2);
    for (const [index, qualification] of [m.access_org_owners(), m.access_org_members()].entries()) {
      const row = within(rows[index]!);
      await expect(row.getByRole('heading', { level: 3, name: `Aki · ${qualification}` })).toBeVisible();
      await expect(row.queryByRole('link')).toBeNull();
      await expect(row.getByRole('button', { name: m.access_grant_actions() })).toBeEnabled();
    }
  },
};
