import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { acting, adminApi, type AdminRecord, agents, header, people, realm, roles } from './fixtures.ts';
import { messages } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import { RealmFrame } from './realm-frame.tsx';
import { RolesView } from './roles-view.tsx';

const record: AdminRecord = { members: [], roles: [], settings: [] };
const reset = () => { record.roles.length = 0; };

const meta = {
  title: 'Manage/Roles',
  component: RolesView,
  parameters: { route: { pathname: `/en/manage/r/${realm}/roles` } },
  args: { realm, actingSubject: acting.iri, list: { generation: '12', cap: 32, roles },
    agents, locale: 'en', messages, api: adminApi({ record }) },
  render: (args: ComponentProps<typeof RolesView>) => <RealmFrame realm={realm} header={header} agent={acting}
    locale={args.locale} messages={args.messages}><RolesView {...args} /></RealmFrame>,
} satisfies Meta<typeof RolesView>;
export default meta;
type Story = StoryObj<typeof meta>;

const body = () => within(document.body);

/** Roles read as what they let people do, with who holds them. */
export const PermissionBundles: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const moderators = canvas.getByRole('heading', { name: 'Community moderators' }).closest('li')!;
    await expect(within(moderators).getByRole('list', { name: 'Permissions' })).toHaveTextContent(
      /Moderate the queue.*Manage members/);
    await expect(moderators).toHaveTextContent('Daniel Chen 陈丹尼, An Wu 吴安');
    const editors = canvas.getByRole('heading', { name: 'Rules editors' }).closest('li')!;
    await expect(editors).toHaveTextContent('No one holds this role.');
  },
};

/** Every role holder, including someone who has not joined, appears in the impact preview. */
export const EditWithImpactPreview: Story = {
  args: { api: { ...adminApi({ record }), roles: async () => ({ ok: true, data: {
    generation: '13', cap: 32, roles: [{ ...roles[0]!,
      permissions: ['governance.moderate', 'realm.members.manage', 'governance.rule.publish'] }, roles[1]!],
  } }) } },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit role: Community moderators' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Edit role' }, { timeout: 5000 }));
    await expect(dialog.getByRole('button', { name: 'Save role' })).toBeDisabled();
    await userEvent.click(dialog.getByRole('checkbox', { name: /Publish rules/ }));
    const impact = dialog.getByRole('region', { name: 'Who this affects' });
    await expect(await within(impact).findByText('3 members gain: Publish rules')).toBeInTheDocument();
    await expect(impact).toHaveTextContent('Daniel Chen 陈丹尼, An Wu 吴安, Lin Mei 林梅');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'Moderators maintain the rules too.');
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Save role' })).toBeEnabled());
    await userEvent.click(dialog.getByRole('button', { name: 'Save role' }));
    await expect(await canvas.findByText('Role saved.')).toBeVisible();
    await expect(record.roles).toEqual([expect.objectContaining({ digest: 'b'.repeat(64), expectedGeneration: '12',
      change: { kind: 'role', roleId: roles[0]!.id, name: 'Community moderators',
        permissions: ['governance.moderate', 'realm.members.manage', 'governance.rule.publish'] } })]);
    const card = canvas.getByRole('heading', { name: 'Community moderators' }).closest('li')!;
    await expect(within(card).getByRole('list', { name: 'Permissions' })).toHaveTextContent('Publish rules');
  },
};

/** More than three holders: the card names the first three and links to the filtered members list. */
export const ShowAllHolders: Story = {
  args: { list: { generation: '12', cap: 32, roles: [{ ...roles[0]!,
    holders: [{ member: people.daniel, banned: false }, { member: people.an, banned: false },
      { member: people.mei, banned: false }], moreHolders: true }] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const card = canvas.getByRole('heading', { name: 'Community moderators' }).closest('li')!;
    await expect(card).toHaveTextContent('Daniel Chen 陈丹尼, An Wu 吴安, Lin Mei 林梅');
    const link = within(card).getByRole('link', { name: 'Show everyone who holds Community moderators' });
    await expect(link).toHaveTextContent('Show all');
    await expect(link).toHaveAttribute('href', expect.stringContaining(
      `/manage/r/${realm}/members?role=${roles[0]!.id}`));
  },
};

/** Someone the members list marks banned stays on the card with the same mark. */
export const BannedHolder: Story = {
  args: { list: { generation: '12', cap: 32, roles: [{ ...roles[0]!,
    holders: [{ member: people.jun, banned: true }], moreHolders: false }] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const card = canvas.getByRole('heading', { name: 'Community moderators' }).closest('li')!;
    await expect(card).toHaveTextContent('Jun Zhang 张俊');
    await expect(within(card).getByText('Banned')).toBeVisible();
  },
};

/** A manager who can edit roles but not read members is not shown who holds them. */
export const HoldersNotVisible: Story = {
  args: { list: { generation: '12', cap: 32, roles: [{ ...roles[0]!, holders: null, moreHolders: null }] } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const card = canvas.getByRole('heading', { name: 'Community moderators' }).closest('li')!;
    await expect(within(card).getByText('Holders not visible')).toBeVisible();
    await expect(card).not.toHaveTextContent('Daniel Chen');
    const link = within(card).getByRole('link', { name: 'Members' });
    await expect(link).toHaveAttribute('href', expect.stringMatching(new RegExp(`/manage/r/${realm}/members$`)));
  },
};

/** A Realm at the cap keeps its roles and cannot add another from this page. */
export const AtTheCap: Story = {
  args: { list: { generation: '12', cap: 32, roles: Array.from({ length: 32 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: `Role ${index + 1}`, permissions: [], holders: [], moreHolders: false })) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'New role' })).toBeDisabled();
    await expect(canvas.getByText('This Realm has reached its limit of 32 roles.')).toBeVisible();
  },
};

export const NewRole: Story = {
  args: { list: { generation: '12', cap: 1, roles: [] }, api: {
    ...adminApi({ record }),
    roles: async () => ({ ok: true, data: { generation: '13', cap: 1, roles: [{
      id: '00000000-0000-4000-8000-000000002003', name: 'Translators 译者',
      permissions: ['rating.question-presentation.review'], holders: [], moreHolders: false,
    }] } }),
  } },
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New role' }));
    const dialog = within(await body().findByRole('dialog', { name: 'New role' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Role name' }), 'Translators 译者');
    await userEvent.click(dialog.getByRole('checkbox', { name: /Review question translations/ }));
    await expect(dialog.getByRole('checkbox', { name: /Configure ratings/ })).not.toBeChecked();
    await expect(await dialog.findByText('No one’s permissions change.')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'A team for translation reviews.');
    await userEvent.click(dialog.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(record.roles).toEqual([expect.objectContaining({
      change: expect.objectContaining({ kind: 'role', name: 'Translators 译者', permissions: ['rating.question-presentation.review'] }) })]));
    await expect(await canvas.findByRole('heading', { name: 'Translators 译者' })).toBeVisible();
    await expect(canvas.queryByText('No roles yet')).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'New role' })).toBeDisabled();
    await userEvent.click(canvas.getByRole('button', { name: 'Edit role: Translators 译者' }));
    const edit = within(await body().findByRole('dialog', { name: 'Edit role' }));
    await expect(edit.getByRole('textbox', { name: 'Role name' })).toHaveValue('Translators 译者');
    await expect(edit.getByRole('checkbox', { name: /Review question translations/ })).toBeChecked();
    await userEvent.click(edit.getByRole('button', { name: 'Cancel' }));
  },
};

/** Taking Manage roles away from yourself is allowed, and said out loud first. */
export const SelfLockoutWarning: Story = {
  args: { api: { ...adminApi({ record }), preview: async command => ({ ok: true, data: { digest: 'c'.repeat(64), exact: true,
    affectedCount: 1, generation: command.expectedGeneration,
    changes: [{ member: acting.iri, gained: [], lost: ['realm.roles.manage'] }] } }) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Edit role: Rules editors' }));
    const dialog = within(await body().findByRole('dialog', { name: 'Edit role' }, { timeout: 5000 }));
    await userEvent.click(dialog.getByRole('checkbox', { name: /Change settings/ }));
    await expect(await dialog.findByText(/You would lose Manage roles yourself/)).toBeInTheDocument();
    await expect(dialog.getByText('1 member loses: Manage roles')).toBeInTheDocument();
  },
};

export const Chinese: Story = {
  args: { locale: 'zh-Hans', messages: { ...messages, ...zhHans } },
  globals: { locale: 'zh-Hans' },
  parameters: { route: { pathname: `/zh-Hans/manage/r/${realm}/roles` } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByText('审核待办')).toHaveLength(1);
  },
};

export const DarkPhone: Story = {
  globals: { theme: 'dark', viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
