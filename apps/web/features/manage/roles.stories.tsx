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
  args: { realm, actingSubject: acting.iri, list: { generation: '12', roles }, holders: { [roles[0]!.id]: [people.daniel, people.an] },
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
    await expect(editors).toHaveTextContent('Members shows the roles of people who joined the Realm.');
  },
};

/** Every role holder, including someone who has not joined, appears in the impact preview. */
export const EditWithImpactPreview: Story = {
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
  },
};

export const NewRole: Story = {
  async play({ canvasElement }) {
    reset();
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'New role' }));
    const dialog = within(await body().findByRole('dialog', { name: 'New role' }, { timeout: 5000 }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Role name' }), 'Translators 译者');
    await userEvent.click(dialog.getByRole('checkbox', { name: /Moderate the queue/ }));
    await expect(await dialog.findByText('No one’s permissions change.')).toBeInTheDocument();
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reason' }), 'A team for translation reviews.');
    await userEvent.click(dialog.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(record.roles).toEqual([expect.objectContaining({
      change: expect.objectContaining({ kind: 'role', name: 'Translators 译者', permissions: ['governance.moderate'] }) })]));
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
