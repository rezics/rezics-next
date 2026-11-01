import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../../paraglide/messages.js';
import { PatternStory } from '../page';
import { fullBanReason, RealmBansExample } from './example';

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

export async function submitBan({ canvasElement }: { canvasElement: HTMLElement }) {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByRole('textbox', { name: m.realm_bans_account() }), '@river');
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_target_lookup() }));
  await userEvent.click(await canvas.findByRole('button', { name: m.realm_bans_target_select() }));
  await userEvent.type(canvas.getByRole('textbox', { name: m.realm_bans_reason() }), 'Repeated disruption');
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_ban() }));
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm_ban() }));
  return canvas;
}

export async function banAndUnban(context: { canvasElement: HTMLElement }) {
  const canvas = await submitBan(context);
  await expect(await canvas.findByText(m.realm_bans_active())).toBeVisible();
  await expect(canvas.getByText(m.realm_bans_removal_pending())).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_unban() }));
  await expect(canvas.getByText(m.realm_bans_unban_confirm())).toBeVisible();
  await userEvent.click(canvas.getByRole('button', { name: m.realm_bans_confirm() }));
  await expect(await canvas.findByText(m.realm_bans_lifted())).toBeVisible();
  await expect(canvas.queryByRole('button', { name: m.realm_bans_unban() })).toBeNull();
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
  },
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
