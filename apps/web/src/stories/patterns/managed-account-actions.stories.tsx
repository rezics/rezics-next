import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccountActionsForViewer } from '../../settings/managed-account-actions';
import { loadManagedAccountActions, type ManagedAccountActionsIO } from '../../settings/managed-account-actions-read';

const viewerId = '019a0000-0000-7000-8000-000000000001';
function Example({ outcome = 'available' }: { outcome?: 'available' | 'denied' | 'unavailable' }) {
  const io: ManagedAccountActionsIO = async (target) => {
    if (outcome !== 'available')
      return {
        state: outcome,
        status: outcome === 'denied' ? 403 : 503,
        code: outcome === 'denied' ? 'forbidden' : 'dependency_unavailable',
      };
    // Illustrative native-shaped response through the real parser; never production authority or recorded proof.
    const client = createKernelClient('https://kernel.test', {
      fetch: Object.assign(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          Response.json({
            resources: [
              {
                type: 'access.account',
                id: target.accountId,
                viewerActions: [{ action: 'account:update', operations: ['account.update'] }],
              },
            ],
          }),
        { preconnect() {} },
      ),
    });
    return loadManagedAccountActions(client, 'Bearer illustrative-story-viewer', target);
  };
  return (
    <div className="mx-auto max-w-2xl p-4">
      <ManagedAccountActionsForViewer
        key={outcome}
        accountId={viewerId}
        viewerId={viewerId}
        nativeAccountKind="actor"
        operated={false}
        self
        io={io}
      />
    </div>
  );
}
const meta = {
  title: 'Patterns/Account/Managed account actions',
  component: Example,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'The actual navigation region with illustrative native-shaped IO. Auth workflow capability bindings and deployment helper are absent, so those destinations stay unavailable. Native and visual proof are deferred.',
      },
    },
  },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CurrentProfileOnly: Story = {
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: m.managed_actions_profile() });
    await expect(canvas.getAllByRole('link')).toHaveLength(1);
    await expect(link).toHaveAttribute('href', `/${getLocale()}/accounts/${viewerId}/profile`);
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    await userEvent.tab();
    await expect(link).toHaveFocus();
    await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await expect(canvas.getByText(m.managed_actions_unavailable())).toBeVisible();
  },
};
export const Denied: Story = {
  args: { outcome: 'denied' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_actions_denied());
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
export const Unavailable: Story = {
  args: { outcome: 'unavailable' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_actions_unavailable());
    await expect(canvas.queryByRole('link')).toBeNull();
  },
};
