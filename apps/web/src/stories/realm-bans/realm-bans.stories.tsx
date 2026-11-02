import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { PatternStory } from '../page';
import { exampleAccountId, fullBanReason, RealmBansExample } from './example';

const meta = {
  title: 'Patterns/Community/Realm bans',
  component: RealmBansExample,
  excludeStories: ['submitBan', 'banAndUnban'],
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <PatternStory>
        <div className="mx-auto max-w-3xl">
          <Story />
        </div>
      </PatternStory>
    ),
  ],
} satisfies Meta<typeof RealmBansExample>;
export default meta;
type Story = StoryObj<typeof meta>;

async function expectDisclosedAccount(scope: HTMLElement, accountId: string) {
  for (const details of scope.querySelectorAll('details')) details.open = false;
  const identity = [...scope.querySelectorAll('dt')].find(
    (label) =>
      label.textContent === m.realm_bans_details_account() && label.nextElementSibling?.textContent === accountId,
  )?.nextElementSibling;
  if (!identity) throw new Error('The exact labeled account must be disclosed in this receipt or row.');
  await expect(identity).toBeVisible();
  await expect(identity.closest('details')).toBeNull();
}

export async function submitBan({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.realm_bans_account() }), '@river');
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_target_lookup() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.realm_bans_target_select() }));
  await userEvent.type(canvas.getByRole('textbox', { name: m.realm_bans_reason() }), 'Repeated disruption');
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_ban() }));
  const confirmation = canvas.getByRole('group', { name: m.realm_bans_ban_confirm() });
  await expectDisclosedAccount(confirmation, exampleAccountId);
  await expect(within(confirmation).getByRole('button', { name: m.realm_bans_cancel() })).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm_ban() }));
  return canvas;
}

export async function banAndUnban(context: { canvasElement: HTMLElement }) {
  const canvas = await submitBan(context);
  await expect(await canvas.findByText(m.realm_bans_active())).toBeVisible();
  await expect(canvas.getByText(m.realm_bans_removal_pending())).toBeVisible();
  const banned = canvas.getByRole('status', { name: m.realm_bans_details_banned_heading() });
  await expect(
    within(banned).getByRole('heading', { level: 3, name: m.realm_bans_details_banned_heading() }),
  ).toBeVisible();
  await expectDisclosedAccount(banned, exampleAccountId);
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_unban() }));
  await expect(canvas.getByText(m.realm_bans_unban_confirm())).toBeVisible();
  await expectDisclosedAccount(canvas.getByRole('group', { name: m.realm_bans_unban_confirm() }), exampleAccountId);
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm() }));
  await expect(await canvas.findByText(m.realm_bans_lifted())).toBeVisible();
  await expect(canvas.queryByRole('button', { name: m.realm_bans_unban() })).toBeNull();
  await expectDisclosedAccount(
    canvas.getByRole('status', { name: m.realm_bans_details_lifted_heading() }),
    exampleAccountId,
  );
  await expect(canvas.getByRole('heading', { level: 3, name: m.realm_bans_details_lifted_heading() })).toBeVisible();
}

export const Current: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.realm_bans_next() })).toBeEnabled();
  },
};
export const FullReason: Story = {
  args: { scenario: 'current' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(fullBanReason, { exact: true })).toBeVisible();
    const timestamp = canvasElement.querySelector('time[datetime="2026-10-31T10:00:00Z"]');
    if (!timestamp) throw new Error('The current ban record should retain its original timestamp.');
    await expect(timestamp).toBeVisible();
    await expect(timestamp).toHaveTextContent('UTC');
    await expect(timestamp).toHaveTextContent('2026-10-31 10:00:00 UTC');
    const row = canvas.getByRole('list', { name: m.realm_bans_current() }).querySelector('li');
    if (!row) throw new Error('The supplied ban must have its own list row.');
    await expect(
      within(row).getByRole('heading', { level: 4, name: m.realm_bans_details_banned_heading() }),
    ).toBeVisible();
    await expectDisclosedAccount(row, '01a1a000-0000-7000-8000-000000000082');
  },
};

async function observeWrappingAndControls(context: Parameters<NonNullable<Story['play']>>[0]) {
  await FullReason.play?.(context);
  const canvas = within(context.canvasElement);
  const list = canvas.getByRole('list', { name: m.realm_bans_current() });
  await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth + 1);
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_unban() }));
  const confirmation = canvas.getByRole('group', { name: m.realm_bans_unban_confirm() });
  await expectDisclosedAccount(confirmation, '01a1a000-0000-7000-8000-000000000082');
  const confirm = within(confirmation).getByRole('button', { name: m.realm_bans_confirm() });
  const cancel = within(confirmation).getByRole('button', { name: m.realm_bans_cancel() });
  await expect(confirm).not.toBe(cancel);
  for (const control of context.canvasElement.querySelectorAll('button, input, textarea')) {
    const bounds = control.getBoundingClientRect();
    await expect(bounds.height).toBeGreaterThanOrEqual(44);
    await expect(bounds.width).toBeGreaterThanOrEqual(44);
  }
  confirm.focus();
  await expect(confirm).toHaveFocus();
  await userEvent.tab();
  await expect(cancel).toHaveFocus();
  await expect(cancel.matches(':focus-visible')).toBe(true);
  const focusStyle = getComputedStyle(cancel);
  await expect(focusStyle.outlineStyle !== 'none' || focusStyle.boxShadow !== 'none').toBe(true);
  await expect(confirmation.scrollWidth).toBeLessThanOrEqual(confirmation.clientWidth + 1);
}

export const FullReasonPhone390: Story = {
  args: { scenario: 'current' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  play: observeWrappingAndControls,
};
export const FullReasonDesktop1280: Story = {
  args: { scenario: 'current' },
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  play: observeWrappingAndControls,
};
export const FullReasonRtl: Story = {
  args: { scenario: 'current' },
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: (args) => (
    <div dir="rtl">
      <RealmBansExample {...args} />
    </div>
  ),
  play: observeWrappingAndControls,
};
export const BanAndUnban: Story = { args: { scenario: 'empty' }, play: banAndUnban };
export const RemovalPending: Story = {
  args: { scenario: 'empty' },
  play: async (context) => {
    const canvas = await submitBan(context);
    await canvas.findByText(m.realm_bans_removal_pending());
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_refresh() }));
    await expect(await canvas.findByText(m.realm_bans_removal_pending())).toBeVisible();
  },
};
export const UnbanConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_bans_unban() }));
    await expect(canvas.getByText(m.realm_bans_unban_confirm())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_cancel() }));
    await expect(canvas.queryByRole('button', { name: m.realm_bans_confirm() })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_unban() }));
  },
};
export const NextPage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_bans_next() }));
    await expect(await canvas.findByText('01a1a000-0000-7000-8000-000000000083')).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.realm_bans_next() })).toBeNull();
  },
};
export const Empty: Story = {
  args: { scenario: 'empty' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(m.realm_bans_empty())).toBeVisible();
  },
};
export const Loading: Story = {
  args: { scenario: 'loading' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(m.realm_bans_loading())).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.realm_bans_refresh() }));
    await expect(await canvas.findByText(m.realm_bans_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.realm_bans_empty())).toBeNull();
  },
};
export const Forbidden: Story = {
  args: { scenario: 'forbidden' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.realm_bans_forbidden())).toBeVisible();
    await expect(canvas.queryByRole('button', { name: m.realm_bans_ban() })).toBeNull();
  },
};
export const Closed: Story = {
  args: { scenario: 'closed' },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(m.realm_bans_closed())).toBeVisible();
  },
};
export const InvalidCursor: Story = {
  args: { scenario: 'invalid-cursor' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(m.realm_bans_cursor_invalid())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_refresh() }));
    await expect(await canvas.findByText(m.realm_bans_empty())).toBeVisible();
  },
};
export const RoleRemovalRequired: Story = {
  args: { scenario: 'role-required' },
  play: async (context) => {
    const canvas = await submitBan(context);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.realm_bans_role_required());
    await expect(canvas.getByRole('textbox', { name: m.realm_bans_account() })).toHaveValue('@river');
  },
};
export const Revoked: Story = {
  args: { scenario: 'revoked' },
  play: async (context) => {
    const canvas = await submitBan(context);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.realm_bans_forbidden());
    await expect(canvas.queryByRole('button', { name: m.realm_bans_ban() })).toBeNull();
  },
};
export const AmbiguousRetry: Story = {
  args: { scenario: 'ambiguous' },
  play: async (context) => {
    const canvas = await submitBan(context);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.realm_bans_write_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_retry() }));
    await expect(await canvas.findByText(m.realm_bans_removal_pending())).toBeVisible();
  },
};
export const Saving: Story = {
  args: { scenario: 'saving' },
  play: async (context) => {
    const canvas = await submitBan(context);
    await expect(canvas.getByRole('button', { name: m.realm_bans_ban() })).toBeDisabled();
    await expect(canvas.getByRole('textbox', { name: m.realm_bans_account() })).toBeDisabled();
  },
};
