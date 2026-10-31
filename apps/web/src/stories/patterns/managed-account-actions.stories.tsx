import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { createKernelClient } from '@rezics/client';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { ManagedAccountActionsForViewer } from '../../settings/managed-account-actions';
import { loadManagedAccountActions, type ManagedAccountActionsIO } from '../../settings/managed-account-actions-read';
import { loadManagedAccountDetail, ManagedAccountReader } from '../../settings/managed-account-detail-read';

const viewerId = '019a0000-0000-7000-8000-000000000001';
const organizationId = '019a0000-0000-7000-8000-000000000002';
const operatedId = '019a0000-0000-7000-8000-000000000003';
const sourceId = '019a0000-0000-7000-8000-123400000004';
type Outcome = 'available' | 'denied' | 'unavailable' | 'failed-then-ready' | 'delayed-retry';
type AuthEntry = 'self' | 'organization' | 'transfer' | 'undeployed' | 'unavailable';
function Example({ outcome = 'available', authEntry }: { outcome?: Outcome; authEntry?: AuthEntry }) {
  const organization = authEntry === 'organization' || authEntry === 'undeployed';
  const operated = authEntry === 'transfer';
  const accountId = organization ? organizationId : operated ? operatedId : viewerId;
  const reader = useMemo(
    () =>
      new ManagedAccountReader(viewerId, accountId, (input) => {
        // Illustrative fixtures only, through the existing management GET/parser and server projection.
        // They are not recorded native outcomes, an authority source, or execution/approval proof.
        const resource = { route: 0, id: accountId };
        const operations = organization
          ? [
              { operationId: 'auth.organization.membership', action: 'organization:membership', resource },
              { operationId: 'auth.organization.delete', action: 'account:delete', resource },
            ]
          : operated
            ? [
                {
                  operationId: 'auth.operator.transfer',
                  action: 'account:manage',
                  resource: { route: 0x1234, id: sourceId },
                },
              ]
            : [{ operationId: 'auth.account.rename', action: 'account:update', resource }];
        const client = createKernelClient('https://kernel.test', {
          fetch: Object.assign(
            async () =>
              Response.json({
                account: {
                  id: accountId,
                  kind: organization ? 'organization' : 'actor',
                  handle: null,
                  displayName: null,
                },
                self: accountId === viewerId,
                role: organization ? 'owner' : null,
                operator: operated
                  ? { id: sourceId, kind: 'actor', handle: null, displayName: 'Illustrative source operator' }
                  : null,
                relation: operated
                  ? {
                      operatorAccountId: sourceId,
                      reservationId: organizationId,
                      version: 'illustrative-private-version',
                    }
                  : null,
                members: { state: 'ready', items: [], next: null },
                responsibilities: { items: [], next: null },
                ...(authEntry
                  ? {
                      authActions:
                        authEntry === 'unavailable' ? { state: 'unavailable' } : { state: 'ready', operations },
                    }
                  : {}),
              }),
            { preconnect() {} },
          ),
        });
        return loadManagedAccountDetail(client, 'Bearer illustrative-story-viewer', input, {
          AUTH_ISSUER: 'https://auth.test',
          AUTH_MANAGEMENT_PAGE_ROUTES:
            authEntry === 'undeployed'
              ? '[]'
              : '["/account/rename","/organizations/members","/operators/transfer","/organizations/delete"]',
        });
      }),
    [accountId, organization, operated, authEntry],
  );
  const { authNavigation } = useSyncExternalStore(reader.subscribe, reader.snapshot, reader.snapshot);
  useEffect(() => {
    void reader.load();
    return () => reader.clear();
  }, [reader]);
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
        accountId={accountId}
        viewerId={viewerId}
        nativeAccountKind={organization ? 'organization' : 'actor'}
        operated={operated}
        self={accountId === viewerId}
        authNavigation={authEntry ? authNavigation : undefined}
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
          'The actual navigation region and management reader with clearly illustrative native-shaped IO. Exact Auth entry observations require explicit deployed routes; the destination obtains current authority, consent, fresh same-human step-up and a separate second submit. Native, runtime and visual proof are deferred.',
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

export const SelfRename: Story = {
  args: { authEntry: 'self' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: m.managed_actions_rename() });
    await expect(link).toHaveAttribute('href', 'https://auth.test/account/rename');
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await canvas.findByRole('link', { name: m.managed_actions_profile() });
    await userEvent.tab();
    await userEvent.tab();
    await expect(link).toHaveFocus();
  },
};

export const OrganizationWorkflows: Story = {
  args: { authEntry: 'organization' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('link', { name: m.managed_actions_members() })).toHaveAttribute(
      'href',
      `https://auth.test/organizations/members?organizationId=${organizationId}`,
    );
    await expect(canvas.getByRole('link', { name: m.managed_actions_delete() })).toHaveAttribute(
      'href',
      `https://auth.test/organizations/delete?organizationId=${organizationId}`,
    );
    await expect(canvas.queryByRole('link', { name: m.managed_actions_transfer() })).toBeNull();
  },
};

export const SourceOperatorTransfer: Story = {
  args: { authEntry: 'transfer', outcome: 'unavailable' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = await canvas.findByRole('link', { name: m.managed_actions_transfer() });
    await expect(link).toHaveAttribute('href', `https://auth.test/operators/transfer?accountId=${operatedId}`);
    await expect(link).toHaveAttribute('referrerpolicy', 'no-referrer');
    await expect(await canvas.findByRole('button', { name: m.managed_actions_retry() })).toBeEnabled();
    await expect(canvas.queryByRole('link', { name: m.managed_actions_profile() })).toBeNull();
    await expect(canvasElement.textContent).not.toContain(sourceId);
    await expect(canvasElement.textContent).not.toContain('illustrative-private-version');
  },
};

export const AuthEntryUndeployed: Story = {
  args: { authEntry: 'undeployed' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: m.managed_actions_profile() });
    await expect(canvas.queryByRole('link', { name: m.managed_actions_members() })).toBeNull();
    await expect(canvas.queryByRole('link', { name: m.managed_actions_delete() })).toBeNull();
  },
};

export const AuthEntriesUnavailable: Story = {
  args: { authEntry: 'unavailable' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('link', { name: m.managed_actions_profile() });
    await expect(canvas.queryByRole('link', { name: m.managed_actions_rename() })).toBeNull();
    await expect(canvas.getByText(m.managed_actions_unavailable())).toBeVisible();
  },
};
