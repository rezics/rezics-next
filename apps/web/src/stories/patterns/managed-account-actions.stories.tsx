import type { Meta, StoryObj } from '@storybook/react-vite';
import { useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccountActionsForViewer } from '../../settings/managed-account-actions';
import { loadManagedAccountActions, type ManagedAccountActionsIO } from '../../settings/managed-account-actions-read';

const viewerId = '019a0000-0000-7000-8000-000000000001';
type Outcome = 'available' | 'denied' | 'unavailable' | 'failed-then-ready' | 'delayed-retry';
function Example({ outcome = 'available' }: { outcome?: Outcome }) {
  const io = useMemo<ManagedAccountActionsIO>(() => {
    let calls = 0;
    return async (target) => {
      calls++;
      if (outcome === 'denied') return { state: 'denied', status: 403, code: 'forbidden' };
      if (outcome === 'unavailable' || (calls === 1 && ['failed-then-ready', 'delayed-retry'].includes(outcome)))
        return {
          state: 'unavailable',
          status: 503,
          code: 'dependency_unavailable',
          ...(outcome === 'delayed-retry' ? { retryAfter: '60' } : {}),
        };
      // Keep the deliberate retry pending long enough to review its disabled control.
      if (outcome === 'failed-then-ready') await new Promise((resolve) => setTimeout(resolve, 300));
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
  }, [outcome]);
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
          'The actual navigation region with illustrative native-shaped IO. Auth workflow capability bindings are absent, so those destinations stay unavailable even when Accounts declares a page deployed. Native and visual proof are deferred.',
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

export const FailedThenReady: Story = {
  args: { outcome: 'failed-then-ready' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const retry = await canvas.findByRole('button', { name: m.managed_actions_retry() });
    await expect(canvas.queryByRole('link')).toBeNull();
    await userEvent.click(retry);
    await expect(retry).toBeDisabled();
    await canvas.findByText(m.managed_actions_loading());
    const link = await canvas.findByRole('link', { name: m.managed_actions_profile() });
    await expect(canvas.getAllByRole('link')).toHaveLength(1);
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(canvas.queryByRole('button', { name: m.managed_actions_retry() })).toBeNull();
  },
};

export const DelayedRetry: Story = {
  args: { outcome: 'delayed-retry' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: m.managed_actions_retry() })).toBeDisabled();
    await expect(canvas.getByText(m.settings_retry_wait())).toBeVisible();
    await expect(canvas.queryByRole('link')).toBeNull();
    const status = canvas.getByText(m.managed_actions_unavailable());
    await expect(status).toHaveAttribute('data-response-status', '503');
    await expect(status).toHaveAttribute('data-response-code', 'dependency_unavailable');
    await expect(status).toHaveAttribute('data-retry-after', '60');
  },
};
