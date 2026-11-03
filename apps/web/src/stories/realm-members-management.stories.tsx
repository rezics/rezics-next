import { useMemo, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmMembersPage, type MembersCaller } from '../community/members/page';
import type { MemberPageRead, RealmMembersSource } from '../community/members/source';
import { m } from '../paraglide/messages.js';
import { requestRealmMemberAddition } from '../community/space';

const realmId = 'illustrative-realm';
const rows = ['account-01', 'account-02'].map((accountId, index) => ({
  kind: 'disclosed' as const,
  identity: { accountId, reference: accountId, label: 'Alex Chen' },
  membershipInterval: index === 0 ? 'producer-interval-one' : 'producer-interval-two',
  membership: 'current' as const,
}));
function fixture(
  state:
    | 'ready'
    | 'long'
    | 'sparse'
    | 'denied'
    | 'selected-unavailable'
    | 'pending'
    | 'addition-rejected'
    | 'addition-unknown'
    | 'addition-pending',
): RealmMembersSource {
  const page: MemberPageRead =
    state === 'denied'
      ? { kind: 'denied' }
      : {
          kind: 'ready',
          page: {
            realm: { id: realmId, label: 'Readers together' },
            authority: 'illustrative-current-authority',
            rows:
              state === 'sparse'
                ? []
                : state === 'long'
                  ? [
                      {
                        ...rows[0]!,
                        identity: { ...rows[0]!.identity, label: 'A very long localized display name · '.repeat(8) },
                      },
                      { ...rows[1]!, identity: { ...rows[1]!.identity, label: 'Account' } },
                      { kind: 'concealed' },
                    ]
                  : rows,
            next: state === 'sparse' ? 'opaque-next' : null,
          },
        };
  return {
    pageBound: 20,
    readPage: async (address) =>
      address.cursor === null
        ? page
        : {
            kind: 'ready',
            page: {
              realm: { id: realmId, label: 'Readers together' },
              authority: 'illustrative-current-authority',
              rows,
              next: null,
            },
          },
    readSelected: async (address) =>
      state === 'selected-unavailable'
        ? { kind: 'unavailable' }
        : {
            kind: 'ready',
            ...address,
            identity: rows.find((row) => row.identity.accountId === address.accountId)?.identity ?? {
              accountId: address.accountId,
              reference: 'selected-account-reference',
              label: 'Alex Chen',
            },
            membershipInterval: address.membershipInterval ?? null,
            membership: state === 'pending' ? 'pending' : state.startsWith('addition-') ? 'none' : 'current',
            advice: state.startsWith('addition-')
              ? { add: 'available', ban: 'unavailable', unban: 'unavailable' }
              : { add: 'unavailable', ban: 'available', unban: 'available' },
          },
    ...(state.startsWith('addition-')
      ? {
          addMember: (intent) => {
            const response =
              state === 'addition-unknown' ? 'unknown' : state === 'addition-rejected' ? 'rejected' : 'accepted';
            const client = createKernelClient('https://kernel.story.invalid', {
              fetch: Object.assign(
                async () => {
                  if (response === 'unknown') throw new Error('Story response unavailable');
                  if (response === 'rejected')
                    return Response.json(
                      {
                        type: 'https://rezics.com/problems/forbidden',
                        title: 'Forbidden',
                        status: 403,
                        code: 'forbidden',
                        retryable: false,
                        effect_status: 'not_applied',
                        request_id: 'story-command',
                      },
                      { status: 403 },
                    );
                  return Response.json({ workflowId: 'story-workflow' }, { status: 202 });
                },
                { preconnect() {} },
              ),
            });
            return requestRealmMemberAddition(
              client,
              new Request('https://site.story.invalid/action', {
                method: 'POST',
                headers: { authorization: 'Bearer story-manager' },
              }),
              {},
              {
                realmId: intent.realmId,
                accountId: intent.accountId,
                idempotencyKey: intent.idempotencyKey,
              },
            );
          },
        }
      : {}),
  };
}
const ready = fixture('ready');
const meta = {
  title: 'Patterns/Community/Realm members management',
  component: RealmMembersPage,
  args: { realmId, source: ready },
  parameters: {
    docs: {
      description: {
        component:
          'Illustrative connected consumer composition. No native roster or selected operation is installed. Command states and production acceptance remain deferred.',
      },
    },
  },
} satisfies Meta<typeof RealmMembersPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const inspect = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click((await canvas.findAllByRole('button', { name: /account-01/ }))[0]!);
  await expect(await canvas.findByRole('heading', { name: m.realm_members_inspection() })).toHaveFocus();
};
const inspectEnteredAccount = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.type(canvas.getByLabelText(m.realm_bans_inspect_account()), '0192f3a0-6c1e-7b2a-9d4e-000000000301');
  await userEvent.click(canvas.getByRole('button', { name: m.realm_members_lookup_account() }));
};
export const Ready: Story = {
  play: async ({ canvasElement }) => {
    await inspect(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText('account-01', { exact: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_members_back() }));
    await expect(canvas.getByRole('button', { name: /account-01/ })).toHaveFocus();
  },
};
export const LongAndPrivateNames: Story = { args: { source: fixture('long') } };
export const Sparse: Story = {
  args: { source: fixture('sparse') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_members_more() }));
    await expect(await canvas.findByRole('button', { name: /account-02/ })).toBeVisible();
  },
};
export const Denied: Story = { args: { source: fixture('denied') } };
export const SelectedUnavailable: Story = {
  args: { source: fixture('selected-unavailable') },
  play: async ({ canvasElement }) => {
    await inspect(canvasElement);
    await expect(await within(canvasElement).findByText(m.realm_members_selected_unavailable())).toBeVisible();
  },
};
export const PendingMembership: Story = {
  args: { source: fixture('pending') },
  play: async ({ canvasElement }) => {
    await inspect(canvasElement);
    await expect(await within(canvasElement).findByText(m.realm_members_pending())).toBeVisible();
  },
};
export const AdditionRejected: Story = {
  args: { source: fixture('addition-rejected') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await inspectEnteredAccount(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_members_add_member() }));
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.realm_members_add_rejected());
  },
};
export const AdditionUnknown: Story = {
  args: { source: fixture('addition-unknown') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await inspectEnteredAccount(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_members_add_member() }));
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm() }));
    await expect(await canvas.findByText(m.realm_members_unknown_command())).toBeVisible();
    await expect(canvas.getByRole('button', { name: m.realm_members_retry_command() })).toBeVisible();
  },
};
export const AdditionAcceptedPending: Story = {
  args: { source: fixture('addition-pending') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await inspectEnteredAccount(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_members_add_member() }));
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm() }));
    await expect(await canvas.findByText(m.realm_members_add_pending())).toBeVisible();
  },
};
function RevokedVisit() {
  const [current, setCurrent] = useState(true);
  const caller = useMemo<MembersCaller>(() => ({ current: () => current }), [current]);
  return (
    <div className="space-y-6">
      <button className="min-h-11 rounded-lg border px-4" onClick={() => setCurrent(false)}>
        Revoke illustrative authority
      </button>
      <RealmMembersPage realmId={realmId} source={ready} caller={caller} />
    </div>
  );
}
export const RevokedWhileOpen: Story = {
  render: () => <RevokedVisit />,
  play: async ({ canvasElement }) => {
    await inspect(canvasElement);
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Revoke illustrative authority' }));
    await expect(await canvas.findByText(m.realm_members_retired())).toBeVisible();
    await expect(canvas.queryByText('account-01', { exact: true })).toBeNull();
  },
};
