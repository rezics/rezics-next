import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, type AdminRecord, agents, header, members, now, outgoingInvitations, people, realm, roles } from './fixtures.ts';
import { MembersView } from './members-view.tsx';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';
import { chooseMenuItem, chooseOption } from '../stories/choose-option.ts';
import type { Loaded, MemberPage, RoleCommand } from './types.ts';

const record: AdminRecord = { members: [], roles: [], settings: [] };
const roleReads: { search: string; after: string | null; role?: string | null }[] = [];
const reset = () => { record.members.length = 0; record.roles.length = 0; };
const first = { generation: '12', items: members, nextCursor: null };
let releasePendingSearch: (() => void) | null = null;
let releasePendingRefresh: (() => void) | null = null;

function memberPage(search: string, after: string | null, role?: string | null, limit = 50): MemberPage {
  const items = members.map(member => {
    let held = member.roles;
    for (const { change } of record.roles as RoleCommand[]) {
      if (change.kind !== 'assignment' || change.member !== member.member) continue;
      held = held.filter(item => item.id !== change.roleId);
      if (change.assigned) held = [...held, { id: change.roleId,
        name: roles.find(item => item.id === change.roleId)!.name, validUntil: change.validUntil }];
    }
    return { ...member, roles: held };
  }).filter(member => {
    const agent = agents[member.member]!;
    return (!role || member.roles.some(item => item.id === role))
      && (!after || member.member > after)
      && (!search || `${agent.label} @${agent.handle} ${member.member}`.toLowerCase().includes(search.toLowerCase()));
  }).sort((left, right) => left.member < right.member ? -1 : left.member > right.member ? 1 : 0);
  return { generation: record.roles.length ? '13' : '12', items: items.slice(0, limit),
    nextCursor: items.length > limit ? items[limit - 1]!.member : null };
}

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
async function settledOverlay(element: HTMLElement) {
  // Presence precedes Ark's focus handoff and CSS entry animation. Typing before
  // the handoff can send later characters to the initial field instead.
  await waitFor(() => expect(element.contains(document.activeElement)).toBe(true));
  await Promise.all(element.getAnimations().map(animation => animation.finished));
}
async function openDialog(name: string) {
  const element = await body().findByRole('dialog', { name }, { timeout: 5000 });
  await settledOverlay(element);
  return within(element);
}
async function openMenu(canvas: ReturnType<typeof within>, name: string, item: string, input: 'pointer' | 'keyboard' = 'pointer') {
  const trigger = canvas.getByRole('button', { name: `Actions for ${name}` });
  if (input === 'pointer') await userEvent.click(trigger);
  else {
    trigger.focus();
    await userEvent.keyboard('{Enter}');
  }
  const menu = await body().findByRole('menu', {}, { timeout: 5000 });
  if (input === 'pointer') {
    await chooseMenuItem(within(menu), 'menuitem', item);
    return;
  }
  await settledOverlay(menu);
  const choice = within(menu).getByRole('menuitem', { name: item });
  const highlighted = () => menu.querySelector('[data-highlighted]');
  for (let step = 0; step <= within(menu).getAllByRole('menuitem').length && highlighted() !== choice; step++) {
    const previous = highlighted();
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(highlighted()).not.toBe(previous));
  }
  await expect(choice).toHaveAttribute('data-highlighted');
  await userEvent.keyboard('{Enter}');
}
async function choose(dialog: ReturnType<typeof within>, label: string, option: string) {
  const trigger = dialog.getByRole('combobox', { name: label });
  await userEvent.click(trigger);
  await chooseOption(body(), option);
  await waitFor(() => expect(body().queryByRole('listbox')).toBeNull());
  await waitFor(() => expect(trigger).toHaveFocus());
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

export const GiveRoleWithPointer: Story = {
  async play({ canvasElement }) {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Actions for Sophie Li 李素菲' }));
    await chooseMenuItem(body(), 'menuitem', 'Give a role…');
    const dialog = await openDialog('Give Sophie Li 李素菲 a role');
    await expect(dialog.getByRole('button', { name: 'Give role' })).toBeVisible();
  },
};

function menuDialog(input: 'pointer' | 'keyboard', member: string, item: string, title: string): Story {
  return {
    async play({ canvasElement }) {
      await openMenu(within(canvasElement), member, item, input);
      await openDialog(title);
      await expect(body().queryByRole('menu')).toBeNull();
    },
  };
}

export const GiveRoleWithKeyboard: Story = menuDialog('keyboard', 'Sophie Li 李素菲', 'Give a role…', 'Give Sophie Li 李素菲 a role');
export const TakeRoleWithPointer: Story = menuDialog('pointer', 'An Wu 吴安', 'Remove role “Community moderators”…', 'Remove “Community moderators” from An Wu 吴安?');
export const TakeRoleWithKeyboard: Story = menuDialog('keyboard', 'An Wu 吴安', 'Remove role “Community moderators”…', 'Remove “Community moderators” from An Wu 吴安?');
export const BanWithPointer: Story = menuDialog('pointer', 'Sophie Li 李素菲', 'Ban…', 'Ban Sophie Li 李素菲');
export const BanWithKeyboard: Story = menuDialog('keyboard', 'Sophie Li 李素菲', 'Ban…', 'Ban Sophie Li 李素菲');
export const UnbanWithPointer: Story = menuDialog('pointer', 'Jun Zhang 张俊', 'Unban…', 'Unban Jun Zhang 张俊?');
export const UnbanWithKeyboard: Story = menuDialog('keyboard', 'Jun Zhang 张俊', 'Unban…', 'Unban Jun Zhang 张俊?');
export const RemoveMemberWithPointer: Story = menuDialog('pointer', 'An Wu 吴安', 'Remove from Realm…', 'Remove An Wu 吴安 from the Realm?');
export const RemoveMemberWithKeyboard: Story = menuDialog('keyboard', 'An Wu 吴安', 'Remove from Realm…', 'Remove An Wu 吴安 from the Realm?');

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
    const dialog = await openDialog('Invite someone to join');
    await expect(dialog.queryByRole('textbox', { name: 'Reason' })).toBeNull();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@lin_mei');
    await choose(dialog, 'Invitation stays open for', '3 days');
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
    const dialog = await openDialog('Ban Sophie Li 李素菲');
    await expect(dialog.getByText(/aren’t given back when the ban ends/)).toBeInTheDocument();
    await choose(dialog, 'For how long', '30 days');
    await expect(dialog.getByRole('combobox', { name: 'For how long' })).toHaveTextContent('30 days');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Spoilers in three titles after a warning.');
    await expect(dialog.getByRole('textbox', { name: 'Reason' })).toHaveValue('Spoilers in three titles after a warning.');
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
    const dialog = await openDialog('Unban Jun Zhang 张俊?');
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
    const dialog = await openDialog('Ban someone from this Realm');
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
    const dialog = await openDialog('Unban someone in this Realm');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Who' }), '@lin_mei');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Ban was a mistake.');
    await userEvent.click(dialog.getByRole('button', { name: 'Unban' }));
    await expect(await dialog.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('They aren’t banned in this Realm.');
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
    const dialog = await openDialog('Remove An Wu 吴安 from the Realm?');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Stepped down.');
    await userEvent.click(dialog.getByRole('button', { name: 'Remove' }));
    await expect(await dialog.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('This member changed while you were deciding.');
    await expect(dialog.getByRole('textbox', { name: 'Reason' })).toHaveValue('Stepped down.');
  },
};

/** Giving a role shows exactly who gains what before it can be saved. */
export const GiveRoleWithImpact: Story = {
  args: { api: { ...adminApi({ record }), members: async (search, after, role) => {
    roleReads.push({ search, after, role });
    return { ok: true, data: memberPage(search, after, role) };
  } } },
  async play({ canvasElement }) {
    reset();
    roleReads.length = 0;
    const started = Date.now();
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search members' }), 'sophie');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(within(canvas.getByRole('list', { name: 'Members' })).getAllByRole('listitem')).toHaveLength(1));
    const row = within(within(canvas.getByRole('list', { name: 'Members' })).getByRole('listitem'));
    await expect(row.getByText('No role', { exact: true })).toBeVisible();
    await openMenu(canvas, 'Sophie Li 李素菲', 'Give a role…');
    const dialog = await openDialog('Give Sophie Li 李素菲 a role');
    await expect(dialog.getByRole('combobox', { name: 'For how long' })).toHaveTextContent('7 days');
    const impact = await dialog.findByRole('region', { name: 'Who this affects' });
    await expect(await within(impact).findByText('1 member gains: Moderate the queue')).toBeInTheDocument();
    await expect(impact).toHaveTextContent('Sophie Li 李素菲');
    await choose(dialog, 'Role', 'Rules editors');
    await expect(await within(impact).findByText('1 member gains: Publish rules')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Drafting the spoiler policy.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await expect(await canvas.findByText('Sophie Li 李素菲 now holds “Rules editors”.')).toBeVisible();
    await expect(record.roles).toEqual([expect.objectContaining({ digest: 'b'.repeat(64),
      reason: 'Drafting the spoiler policy.', change: expect.objectContaining({ kind: 'assignment', member: people.sophie,
        roleId: roles[1]!.id, assigned: true }) })]);
    const assigned = (record.roles[0] as RoleCommand).change;
    if (assigned.kind !== 'assignment') throw new Error('Expected the actual roster member assignment');
    await expect(Date.parse(assigned.validUntil)).toBeGreaterThan(started + 6 * 86_400_000);
    await expect(Date.parse(assigned.validUntil)).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
    await expect(await row.findByText('Rules editors', { exact: true })).toBeVisible();
    await expect(row.queryByText('No role', { exact: true })).toBeNull();
    await expect(roleReads).toEqual([{ search: 'sophie', after: null, role: undefined },
      { search: 'sophie', after: null, role: undefined }]);
  },
};

export const GiveRoleWithImpactPhone: Story = { ...GiveRoleWithImpact, globals: { viewport: { value: 'phone' } } };
export const GiveRoleWithImpactDesktop: Story = { ...GiveRoleWithImpact, globals: { viewport: { value: 'desktop' } } };

/** An earlier search can finish after the assignment's fresh member read. */
export const AssignmentRefreshWinsPendingSearch: Story = {
  args: { api: { ...adminApi({ record }), members: async (search, after, role) => {
    roleReads.push({ search, after, role });
    const data = memberPage(search, after, role);
    if (roleReads.length === 1) return new Promise<Loaded<MemberPage>>(resolve => {
      releasePendingSearch = () => resolve({ ok: true, data });
    });
    return { ok: true, data };
  } } },
  async play({ canvasElement }) {
    reset();
    roleReads.length = 0;
    releasePendingSearch = null;
    const canvas = within(canvasElement);
    const memberList = within(canvas.getByRole('list', { name: 'Members' }));
    const row = within(memberList.getAllByRole('listitem').find(item => item.textContent?.includes('Sophie Li 李素菲'))!);
    await expect(row.getByText('No role', { exact: true })).toBeVisible();
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Search members' }), 'sophie');
    await userEvent.click(canvas.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(releasePendingSearch).not.toBeNull());
    await openMenu(canvas, 'Sophie Li 李素菲', 'Give a role…');
    const dialog = await openDialog('Give Sophie Li 李素菲 a role');
    const impact = await dialog.findByRole('region', { name: 'Who this affects' });
    await expect(await within(impact).findByText('1 member gains: Moderate the queue')).toBeVisible();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share moderation.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await expect(await row.findByText('Community moderators', { exact: true })).toBeVisible();
    await expect(roleReads).toEqual([{ search: 'sophie', after: null, role: undefined },
      { search: 'sophie', after: null, role: undefined }]);
    await expect(memberList.getAllByRole('listitem')).toHaveLength(1);
    await expect(canvas.getByRole('button', { name: 'Clear search' })).toBeVisible();
    releasePendingSearch!();
    // Opening the row actions observes the settled row after the older read completes.
    await userEvent.click(canvas.getByRole('button', { name: 'Actions for Sophie Li 李素菲' }));
    const menu = await body().findByRole('menu');
    await settledOverlay(menu);
    await expect(row.getByText('Community moderators', { exact: true })).toBeVisible();
    await expect(within(menu).getByRole('menuitem', { name: 'Remove role “Community moderators”…' })).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(memberList.getAllByRole('listitem')).toHaveLength(1);
  },
};

/** Pagination cannot overtake the replacement read started by assigning a role. */
export const AssignmentRefreshBlocksPagination: Story = {
  args: { first: memberPage('', null, undefined, 4), api: { ...adminApi({ record }),
    members: async (search, after, role) => {
      roleReads.push({ search, after, role });
      const data = memberPage(search, after, role, 4);
      if (!after) return new Promise<Loaded<MemberPage>>(resolve => {
        releasePendingRefresh = () => resolve({ ok: true, data });
      });
      return { ok: true, data };
    },
  } },
  async play({ canvasElement }) {
    reset();
    roleReads.length = 0;
    releasePendingRefresh = null;
    const canvas = within(canvasElement);
    const memberList = within(canvas.getByRole('list', { name: 'Members' }));
    await openMenu(canvas, 'Sophie Li 李素菲', 'Give a role…');
    const dialog = await openDialog('Give Sophie Li 李素菲 a role');
    const impact = await dialog.findByRole('region', { name: 'Who this affects' });
    await expect(await within(impact).findByText('1 member gains: Moderate the queue')).toBeVisible();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Share moderation.');
    await userEvent.click(dialog.getByRole('button', { name: 'Give role' }));
    await waitFor(() => expect(releasePendingRefresh).not.toBeNull());
    const more = canvas.getByRole('button', { name: 'Load more' });
    await expect(more).toBeDisabled();
    more.focus();
    await userEvent.keyboard('{Enter}');
    await expect(roleReads).toEqual([{ search: '', after: null, role: undefined }]);
    releasePendingRefresh!();
    await waitFor(() => expect(more).toBeEnabled());
    const sophie = () => within(memberList.getAllByRole('listitem').find(item => item.textContent?.includes('Sophie Li 李素菲'))!);
    await expect(sophie().getByText('Community moderators', { exact: true })).toBeVisible();
    await userEvent.click(more);
    await waitFor(() => expect(memberList.getAllByRole('listitem')).toHaveLength(members.length));
    await expect(roleReads).toEqual([{ search: '', after: null, role: undefined },
      { search: '', after: people.sophie, role: undefined }]);
    for (const member of members) await expect(memberList.getByText(agents[member.member]!.label!, { exact: true })).toBeVisible();
    await expect(sophie().getByText('Community moderators', { exact: true })).toBeVisible();
  },
};

/** Show all lands here: the list stays on that role as it pages. */
export const RoleFilter: Story = {
  args: {
    address: realm,
    roleFilter: { id: roles[0]!.id, name: roles[0]!.name },
    first: memberPage('', null, roles[0]!.id, 1),
    api: { ...adminApi({ record }), members: async (search, after, role) => {
      roleReads.push({ search, after, role });
      return { ok: true, data: memberPage(search, after, role, 1) };
    } },
  },
  async play({ canvasElement }) {
    reset();
    roleReads.length = 0;
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Showing people who hold Community moderators.')).toBeVisible();
    const clear = canvas.getByRole('link', { name: 'Show every member' });
    await expect(clear).toHaveAttribute('href', expect.stringMatching(new RegExp(`/manage/r/${realm}/members$`)));
    await userEvent.click(canvas.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(roleReads).toEqual([{ search: '', after: people.mei, role: roles[0]!.id }]));
    await waitFor(() => expect(within(canvas.getByRole('list', { name: 'Members' })).getAllByRole('listitem')).toHaveLength(2));
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
