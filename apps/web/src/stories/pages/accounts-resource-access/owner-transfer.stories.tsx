import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, within } from 'storybook/test';
import { ResourceAccessPage } from '../../../accounts/resource-access/page';
import { transferOwner, realmOwnerRole } from '../../../accounts/resource-access/owner-transfer.ts';
import type { AccessSnapshot, AccessState, AccessIO } from '../../../accounts/resource-access/data';
import { m } from '../../../paraglide/messages.js';
import { snapshot, managerId, readerId } from './fixtures';

/** Presentation-only HTTP responses exercise the real local transport, never simulate native proof. */
function Example({
  scenario = 'current',
}: {
  scenario?: 'current' | 'lost' | 'denied' | 'long' | 'unresolved' | 'deleted';
}) {
  const [setup] = useState(() => {
    const page: AccessSnapshot = {
      ...structuredClone(snapshot),
      resource: { ...snapshot.resource, type: 'community.realm' },
      roles: [{ id: realmOwnerRole, actions: ['realm:read', 'realm:manage', 'access:grant'], delegable: true }],
      grants: [
        {
          ...snapshot.grants[0]!,
          kind: 'role',
          role: realmOwnerRole,
          subject: { kind: 'account', id: managerId },
          actions: ['realm:read', 'realm:manage', 'access:grant'],
        },
      ],
    };
    if (scenario === 'long') {
      const source = page.identities[0]!;
      const recipient = page.identities[1]!;
      if (source.state !== 'active' || recipient.state !== 'active')
        throw new Error('Expected active illustrative identities');
      page.identities[0] = { ...source, displayName: 'Mira · 管理者 · ' + 'Responsable de la communauté '.repeat(8) };
      page.identities[1] = { ...recipient, displayName: 'Aki · 新しい所有者 · ' + '독서 모임 관리자 '.repeat(12) };
    }
    if (scenario === 'unresolved') page.identities = page.identities.filter((item) => item.id !== managerId);
    if (scenario === 'deleted') page.identities[0] = { id: managerId, kind: 'actor', state: 'deleted' };
    const initial: AccessState = { status: 'ready', page: structuredClone(page) };
    let denied = false;
    const receipts = new Map<string, unknown>();
    const read = async (): Promise<AccessState> =>
      denied ? { status: 'denied' } : { status: 'ready', page: structuredClone(page) };
    const io: AccessIO = {
      read,
      save: async () => ({ status: 'refused' }),
      lookup: async () => page.identities.find((identity) => identity.id === readerId) ?? null,
      transfer: (input) =>
        transferOwner('https://kernel.invalid', 'Bearer story', input, read, (async (_url, init) => {
          if (scenario === 'denied') {
            denied = true;
            return Response.json({ type: 'forbidden' }, { status: 403 });
          }
          const key = new Headers(init?.headers).get('idempotency-key')!;
          if (receipts.has(key)) return Response.json(receipts.get(key));
          page.grants = [{ ...page.grants[0]!, subject: { kind: 'account', id: readerId }, valid: '[2026-10-31,)' }];
          const receipt = {
            roleGrant: {
              resource: input.resource,
              subject: { kind: 'account', id: readerId },
              role: realmOwnerRole,
              valid: page.grants[0]!.valid,
            },
          };
          receipts.set(key, receipt);
          if (scenario === 'lost') throw new Error('Response lost after effect');
          return Response.json(receipt);
        }) as typeof fetch),
    };
    return { initial, io };
  });
  return <ResourceAccessPage initial={setup.initial} io={setup.io} />;
}
const meta = {
  title: 'Account/Resource access ownership',
  id: 'pages-account-resource-access-ownership',
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
async function confirm(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.access_grant_actions() }));
  await userEvent.click(await screen.findByText(m.access_transfer_owner(), { selector: '[role="menuitem"], button' }));
  await userEvent.type(canvas.getByLabelText(m.access_handle()), 'aki');
  await userEvent.click(canvas.getByRole('button', { name: m.access_find_account() }));
  await userEvent.click(canvas.getByRole('button', { name: m.access_transfer_owner() }));
  const dialog = within(await screen.findByRole('alertdialog'));
  await expect(dialog.getByText(/Mira/)).toHaveTextContent('Aki');
  await userEvent.click(dialog.getByRole('button', { name: m.access_transfer_owner() }));
}
export const TransferOwnership: Story = {
  play: async ({ canvasElement }) => {
    await confirm(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_saved());
    await expect(canvas.getByText('Aki', { exact: true })).toBeVisible();
  },
};
export const LostResponse: Story = {
  args: { scenario: 'lost' },
  play: async ({ canvasElement }) => {
    await confirm(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_uncertain());
    await userEvent.click(canvas.getByRole('button', { name: m.access_retry_operation() }));
    await expect(canvas.getByRole('status')).toHaveTextContent(m.access_saved());
  },
};
export const AuthorityLost: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    await confirm(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('Mira', { exact: true })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: m.access_grant_actions() })).not.toBeInTheDocument();
  },
};

// Illustrative current review, not a native transfer or a recorded capture.
async function review({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: m.access_grant_actions() }));
  await userEvent.click(await screen.findByText(m.access_transfer_owner(), { selector: '[role="menuitem"], button' }));
  await userEvent.type(canvas.getByLabelText(m.access_handle()), 'aki');
  await userEvent.click(canvas.getByRole('button', { name: m.access_find_account() }));
  await userEvent.click(canvas.getByRole('button', { name: m.access_transfer_owner() }));
  const element = await screen.findByRole('alertdialog');
  const dialog = within(element);
  await expect(dialog.getByText(m.access_identity_resource_id())).toBeVisible();
  for (const value of [
    snapshot.resource.id,
    'community.realm',
    String(snapshot.resource.route),
    managerId,
    readerId,
    snapshot.grants[0]!.valid,
  ]) {
    const exact = dialog.getByText(value, { exact: true, selector: 'dd' });
    await expect(exact).toBeVisible();
    await expect(exact.closest('details')).toBeNull();
    await expect(exact).toHaveClass('select-all', 'break-all');
    await expect(exact.scrollWidth).toBeLessThanOrEqual(exact.clientWidth + 1);
    exact.focus();
    await expect(exact).toHaveFocus();
  }
  await expect(dialog.getByText((text) => text.includes(m.access_transfer_responsibility()))).toBeVisible();
  await expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
}
export const CurrentTransferReview: Story = { play: review };
export const LongTransferReviewPhone: Story = {
  name: 'Long Transfer Review',
  args: { scenario: 'long' },
  globals: {},
  play: review,
};
export const LongTransferReviewDesktop: Story = {
  tags: ['!dev'],
  args: { scenario: 'long' },
  globals: {},
  play: review,
};
export const UnresolvedOwnerReview: Story = { args: { scenario: 'unresolved' }, play: review };
export const DeletedOwnerReview: Story = { args: { scenario: 'deleted' }, play: review };
