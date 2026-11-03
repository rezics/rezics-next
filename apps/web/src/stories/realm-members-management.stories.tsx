import { useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { RealmMembersPage, type MembersCaller } from '../community/members/page';
import type { MemberPageRead, RealmMembersSource } from '../community/members/source';
import { m } from '../paraglide/messages.js';

const realmId = 'illustrative-realm';
const rows = ['account-01', 'account-02'].map((accountId) => ({
  kind: 'disclosed' as const,
  identity: { accountId, reference: accountId, label: 'Alex Chen' },
  episode: `episode-${accountId}`, membership: 'current' as const,
}));
function fixture(state: 'ready' | 'long' | 'sparse' | 'denied' | 'selected-unavailable' | 'pending'): RealmMembersSource {
  const page: MemberPageRead = state === 'denied' ? { kind: 'denied' } : {
    kind: 'ready', page: {
      realm: { id: realmId, label: 'Readers together' }, authority: 'illustrative-current-authority',
      rows: state === 'sparse' ? [] : state === 'long' ? [
        { ...rows[0]!, identity: { ...rows[0]!.identity, label: 'A very long localized display name · '.repeat(8) } },
        { ...rows[1]!, identity: { ...rows[1]!.identity, label: 'Account' } }, { kind: 'concealed' },
      ] : rows,
      next: state === 'sparse' ? 'opaque-next' : null,
    },
  };
  return { pageBound: 20,
    readPage: async (address) => address.cursor === null ? page : { kind: 'ready', page: {
      realm: { id: realmId, label: 'Readers together' }, authority: 'illustrative-current-authority', rows, next: null,
    } },
    readSelected: async (address) => state === 'selected-unavailable' ? { kind: 'unavailable' } : {
      kind: 'ready', ...address,
      identity: rows.find((row) => row.identity.accountId === address.accountId)!.identity,
      membership: state === 'pending' ? 'pending' : 'current',
    },
  };
}
const ready = fixture('ready');
const meta = {
  title: 'Patterns/Community/Realm members management', component: RealmMembersPage,
  args: { realmId, source: ready },
  parameters: { docs: { description: { component:
    'Illustrative connected consumer composition. No native roster or selected operation is installed. Command states and production acceptance remain deferred.' } } },
} satisfies Meta<typeof RealmMembersPage>;
export default meta;
type Story = StoryObj<typeof meta>;
const inspect = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click((await canvas.findAllByRole('button', { name: /account-01/ }))[0]!);
  await expect(await canvas.findByRole('heading', { name: m.realm_members_inspection() })).toHaveFocus();
};
export const Ready: Story = { play: async ({ canvasElement }) => {
  await inspect(canvasElement);
  const canvas = within(canvasElement);
  await expect(canvas.getByText('account-01', { exact: true })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.realm_members_back() }));
  await expect(canvas.getByRole('button', { name: /account-01/ })).toHaveFocus();
} };
export const LongAndPrivateNames: Story = { args: { source: fixture('long') } };
export const Sparse: Story = { args: { source: fixture('sparse') }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole('button', { name: m.realm_members_more() }));
  await expect(await canvas.findByRole('button', { name: /account-02/ })).toBeVisible();
} };
export const Denied: Story = { args: { source: fixture('denied') } };
export const SelectedUnavailable: Story = { args: { source: fixture('selected-unavailable') }, play: async ({ canvasElement }) => {
  await inspect(canvasElement);
  await expect(await within(canvasElement).findByText(m.realm_members_selected_unavailable())).toBeVisible();
} };
export const PendingMembership: Story = { args: { source: fixture('pending') }, play: async ({ canvasElement }) => {
  await inspect(canvasElement);
  await expect(await within(canvasElement).findByText(m.realm_members_pending())).toBeVisible();
} };
function RevokedVisit() {
  const [current, setCurrent] = useState(true);
  const caller = useMemo<MembersCaller>(() => ({ current: () => current }), [current]);
  return <div className="space-y-6">
    <button className="min-h-11 rounded-lg border px-4" onClick={() => setCurrent(false)}>Revoke illustrative authority</button>
    <RealmMembersPage realmId={realmId} source={ready} caller={caller} />
  </div>;
}
export const RevokedWhileOpen: Story = { render: () => <RevokedVisit />, play: async ({ canvasElement }) => {
  await inspect(canvasElement);
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Revoke illustrative authority' }));
  await expect(await canvas.findByText(m.realm_members_retired())).toBeVisible();
  await expect(canvas.queryByText('account-01', { exact: true })).toBeNull();
} };
