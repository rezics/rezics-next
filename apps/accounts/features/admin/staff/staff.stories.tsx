import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, screen, userEvent, waitFor, within } from 'storybook/test';
import { StaffPage } from './staff.tsx';
import { openDialog, operators, support, typist, users, withAdmin } from '../story-support.tsx';
import { chinese, dark } from '../../../.storybook/variants.ts';

const meta = {
  title: 'Accounts/Admin/Staff', component: StaffPage,
  args: { operators }, decorators: [withAdmin], parameters: { admin: { section: 'staff' } },
} satisfies Meta<typeof StaffPage>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StaffAndPermissions: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Staff & roles' })).toBeVisible();
    const staff = canvas.getByRole('table', { name: 'Staff members' });
    const margaret = within(staff).getAllByRole('row').find(row => row.textContent?.includes('Margaret Hamilton'))!;
    await expect(within(margaret).getByText('No two-step verification')).toBeVisible();
    const matrix = canvas.getByRole('table', { name: 'What each role can do' });
    const changeRoles = within(matrix).getByRole('row', { name: /Change operator roles/ });
    await expect(within(changeRoles).getAllByText('Not allowed')).toHaveLength(2);
    await expect(within(changeRoles).getAllByText('Allowed')).toHaveLength(1);
  },
};

const lookup = fn(async () => ({ ok: true as const, data: { items: [], nextCursor: null, exact: users[0]! } }));
const setRole = fn(async () => ({ ok: true as const, data: { status: true, requestId: 'req-5' } }));
/** An owner finds an account by exact email, then chooses its role. */
export const AddStaffMember: Story = {
  parameters: { admin: { section: 'staff', api: { users: lookup, setRole } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: 'Add staff member' }));
    const find = await openDialog('dialog', 'Give someone an operator role');
    await typist.type(within(find).getByLabelText('Their account email'), 'ada@example.test');
    const findButton = within(find).getByRole('button', { name: 'Find' });
    await waitFor(() => expect(findButton).toBeEnabled());
    await userEvent.click(findButton);
    const role = await openDialog('alertdialog', 'Change the role of Ada Lovelace');
    await expect(within(role).getByRole('radio', { name: /^Support/ })).toBeChecked();
    await typist.type(within(role).getByLabelText('Why (for the audit log)'), 'Joins the support rotation');
    await userEvent.click(within(role).getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(setRole).toHaveBeenCalledWith('u-ada', 'support', 'Joins the support rotation'), { timeout: 5_000 });
  },
};

/** Without operators:manage, roles are read-only. */
export const ReadOnly: Story = {
  parameters: { admin: { section: 'staff', me: support } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table', { name: 'Staff members' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Add staff member' })).toBeNull();
    await expect(canvas.queryByRole('button', { name: 'Change role' })).toBeNull();
  },
};

export const Dark: Story = { ...StaffAndPermissions, globals: dark };
export const Chinese: Story = {
  globals: chinese,
  async play({ canvasElement }) {
    await expect(await within(canvasElement).findByRole('heading', { level: 1, name: '员工与角色' })).toBeVisible();
  },
};
