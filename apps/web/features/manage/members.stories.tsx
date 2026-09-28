import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, type AdminRecord, agents, header, members, now, outgoingInvitations, people, realm, roles } from './fixtures.ts';
import { MembersView } from './members-view.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';

const record: AdminRecord = { members: [], roles: [], settings: [] };
const reset = () => { record.members.length = 0; record.roles.length = 0; };
const first = { generation: '12', items: members, nextCursor: null };

const meta = {
  title: 'Manage/Members',
  component: MembersView,
  parameters: { route: { pathname: `/en/manage/r/${realm}/members` } },
  args: { realm, actingSubject: acting.iri, first, agents, roles, invitations: { ok: true, data: outgoingInvitations },
    now, locale: 'en', messages, api: adminApi({ record }) },
  render: (args: ComponentProps<typeof MembersView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><MembersView {...args} /></RealmFrame>,
} satisfies Meta<typeof MembersView>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);
async function openMenu(canvas: ReturnType<typeof within>, name: string, item: string) {
  await userEvent.click(canvas.getByRole('button', { name: `Actions for ${name}` }));
  await userEvent.click(await body().findByRole('menuitem', { name: item }, { timeout: 5000 }));
}

export const Roster: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const rows = within(canvas.getByRole('list', { name: 'Members' })).getAllByRole('listitem');
    await expect(rows).toHaveLength(members.length);
    await expect(rows[0]).toHaveTextContent('Daniel Chen 陈丹尼');
    await expect(rows[0]).toHaveTextContent('Community moderators');
    await expect(rows[3]).toHaveTextContent(/Banned until/);
    await expect(rows[4]).toHaveTextContent('Left');
    await expect(rows[5]).toHaveTextContent('Has not joined');
    await expect(canvas.getByRole('heading', { name: 'Outgoing invitations' })).toBeVisible();
    await expect(canvas.getByText(/Waiting · Expires Oct 1, 2026/)).toBeVisible();
  },
};

export const CancelOutgoingInvitation: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Cancel invitation' }));
    await expect(await canvas.findByText('Cancelled the invitation to Aria Wang 王雅.')).toBeVisible();
    await expect(canvas.getByText(/Cancelled · Expires/)).toBeVisible();
    await expect(record.members).toEqual([expect.objectContaining({ action: 'revoke', invitation: outgoingInvitations.items[0]!.id })]);
  },
};

/** Inviting needs no consent code: the person accepts from their notifications, and joins then. */
export const Invite: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Invite' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Invite someone to join' }, { timeout: 5000 }));
    await expect(dialog.queryByRole('textbox', { name: 'Reason' })).toBeNull();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@lin_mei');
    await userEvent.selectOptions(dialog.getByRole('combobox', { name: 'Invitation stays open for' }), '3 days');
    await userEvent.click(dialog.getByRole('button', { name: 'Send invitation' }));
    await expect(await canvas.findByText(/Lin Mei 林梅 is invited until .+\. They join when they accept\./)).toBeVisible();
    await expect(record.members).toEqual([expect.objectContaining({ actingSubject: acting.iri, member: people.mei,
      expiresInSeconds: 259_200 })]);
  },
};

/** Ban with a duration and a reason; Main records both in the audit log. */
export const BanForThirtyDays: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await openMenu(canvas, 'Sophie Li 李素菲', 'Ban…');
    const dialog = within(await body().findByRole('dialog', { name: 'Ban Sophie Li 李素菲' }, { timeout: 5000 }));
    await expect(dialog.getByText(/aren’t given back when the ban ends/)).toBeInTheDocument();
    await userEvent.selectOptions(dialog.getByRole('combobox', { name: 'For how long' }), '30 days');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Spoilers in three titles after a warning.');
    await userEvent.click(dialog.getByRole('button', { name: 'Ban' }));
    await expect(await canvas.findByText('Sophie Li 李素菲 is banned.')).toBeVisible();
    await expect(record.members).toEqual([expect.objectContaining({ action: 'ban', member: people.sophie,
      durationSeconds: 2_592_000, expectedMembershipGeneration: '1', expectedGeneration: '12', consent: null,
      reason: 'Spoilers in three titles after a warning.' })]);
  },
};

export const Unban: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await openMenu(canvas, 'Jun Zhang 张俊', 'Unban…');
    const dialog = within(await body().findByRole('dialog', { name: 'Unban Jun Zhang 张俊?' }, { timeout: 5000 }));
    await userEvent.click(dialog.getByRole('button', { name: 'Unban' }));
    await expect(dialog.getByText('Write a reason first.')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Appeal accepted.');
    await userEvent.click(dialog.getByRole('button', { name: 'Unban' }));
    await expect(await canvas.findByText('Jun Zhang 张俊 is unbanned.')).toBeVisible();
    await expect(record.members).toEqual([expect.objectContaining({ action: 'unban', durationSeconds: null,
      expectedMembershipGeneration: '3' })]);
  },
};

/** Someone who left can still be banned by handle, at their own membership generation. */
export const BanSomeoneByHandle: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Ban someone' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Ban someone from this Realm' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@nobody_here');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Spam.');
    await userEvent.click(dialog.getByRole('button', { name: 'Ban' }));
    await expect(dialog.getByText('No one has that handle.')).toBeInTheDocument();
    await userEvent.clear(dialog.getByRole('textbox', { name: 'Who' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@aria_wang');
    await userEvent.click(dialog.getByRole('button', { name: 'Ban' }));
    await waitFor(() => expect(record.members).toEqual([expect.objectContaining({ member: people.aria,
      expectedMembershipGeneration: '2', durationSeconds: 604_800 })]));
  },
};

/** Bans of people outside the roster are not listed; unbanning by handle says when there was none. */
export const UnbanSomeoneOutsideTheRoster: Story = {
  args: { api: adminApi({ record, memberFailure: 'denied' }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Unban someone' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Unban someone in this Realm' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@lin_mei');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Ban was a mistake.');
    await userEvent.click(dialog.getByRole('button', { name: 'Unban' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('They aren’t banned in this Realm.');
    await expect(record.members).toEqual([expect.objectContaining({ action: 'unban', member: people.mei,
      expectedMembershipGeneration: '0' })]);
  },
};

/** A stale membership keeps the dialog and what was typed, and says why. */
export const ChangedMeanwhile: Story = {
  args: { api: adminApi({ record, memberFailure: 'stale' }) },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await openMenu(canvas, 'An Wu 吴安', 'Remove from Realm…');
    const dialog = within(await body().findByRole('dialog', { name: 'Remove An Wu 吴安 from the Realm?' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Stepped down.');
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await expect(await dialog.findByRole('alert')).toHaveTextContent('This member changed while you were deciding.');
    await expect(dialog.getByRole('textbox', { name: 'Reason' })).toHaveValue('Stepped down.');
  },
};

/** Giving a role shows exactly who gains what before it can be saved. */
export const GiveRoleWithImpact: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await openMenu(canvas, 'Sophie Li 李素菲', 'Give a role…');
    const dialog = within(await body().findByRole('dialog', { name: 'Give Sophie Li 李素菲 a role' }, { timeout: 5000 }));
    const impact = dialog.getByRole('region', { name: 'Who this affects' });
    await expect(await within(impact).findByText('1 member gains: Moderate the queue')).toBeInTheDocument();
    await expect(impact).toHaveTextContent('Sophie Li 李素菲');
    await userEvent.selectOptions(dialog.getByRole('combobox', { name: 'Role' }), 'Rules editors');
    await expect(await within(impact).findByText('1 member gains: Publish rules')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Drafting the spoiler policy.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await expect(await canvas.findByText('Sophie Li 李素菲 now holds “Rules editors”.')).toBeVisible();
    await expect(record.roles).toEqual([expect.objectContaining({ digest: 'b'.repeat(64),
      reason: 'Drafting the spoiler policy.', change: expect.objectContaining({ kind: 'assignment', member: people.sophie,
        roleId: roles[1]!.id, assigned: true }) })]);
  },
};

export const Search: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search members' }), 'daniel');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(within(canvas.getByRole('list', { name: 'Members' })).getAllByRole('listitem')).toHaveLength(1));
    await userEvent.clear(canvas.getByRole('searchbox', { name: 'Search members' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search members' }), 'nobody{enter}');
    await expect(await canvas.findByRole('heading', { name: 'No members match “nobody”.' })).toBeVisible();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}/members` } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('button', { name: '封禁某人' })).toBeVisible();
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
