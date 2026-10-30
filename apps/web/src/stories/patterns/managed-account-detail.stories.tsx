import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { detailExample, human, organization } from '../../accounts/management/story-api';
import { m } from '../../paraglide/messages.js';
import { ManagedAccountDetailCard } from '../../settings/managed-account-detail';
import { ManagedAccountReader, type DetailRead } from '../../settings/managed-account-detail-read';

// Illustrative native DTOs for component review, not proof of native authorization or completed operations.
function Example({ member = false, paging = false }: { member?: boolean; paging?: boolean }) {
  const reader = useMemo(() => {
    const read: DetailRead = async (input) => {
      const value = detailExample(organization.id);
      if (member) {
        value.role = 'member';
        value.members = { state: 'denied', items: [], next: null };
        value.responsibilities = null;
      } else if (paging) {
        const second = input.section === 'members' && !!input.cursor;
        value.members.items = Array.from({ length: second ? 1 : 20 }, (_, index) => {
          const id = `01a1a000-0000-7000-8000-${String(index + (second ? 400 : 200)).padStart(12, '0')}`;
          return {
            accountId: id,
            account: { ...human, id, displayName: `Atlas editor ${index + (second ? 21 : 1)}`, handle: null },
            role: 'member',
          };
        });
        value.members.next = second ? null : 'illustrative-signed-members-page';
        value.responsibilities!.next = 'illustrative-signed-responsibilities-page';
        if (input.section === 'responsibilities' && input.cursor)
          return { ok: false, failure: { status: 503, code: 'dependency_unavailable', transient: true } };
      }
      return { ok: true, viewerId: input.viewerId, value };
    };
    return new ManagedAccountReader(human.id, organization.id, read);
  }, [member, paging]);
  useEffect(() => {
    void reader.load();
    return () => reader.clear();
  }, [reader]);
  return (
    <div className="mx-auto max-w-3xl">
      <ManagedAccountDetailCard reader={reader} backHref="/en/settings?view=accounts#account" />
    </div>
  );
}

const meta = {
  title: 'Patterns/Account/Managed account detail',
  component: Example,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MemberRestricted: Story = {
  args: { member: true },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_holders_denied());
    await expect(canvas.getByText(m.settings_managed_responsibilities_unavailable())).toBeVisible();
    await expect(canvas.queryByText(m.managed_no_holders())).toBeNull();
    await expect(canvas.queryByText(m.managed_no_responsibilities())).toBeNull();
  },
};

export const ManagerObservations: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_current());
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
    await expect(canvas.getByText(m.settings_managed_observation())).toBeVisible();
  },
};

export const IndependentPaging: Story = {
  args: { paging: true },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: `${m.managed_next()} · ${m.managed_holders_title()}` }),
    );
    await canvas.findByText('Atlas editor 21');
    await expect(canvas.getByText(m.managed_current())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: `${m.managed_next()} · ${m.managed_operated_title()}` }));
    await canvas.findByRole('alert');
    await expect(canvas.getByText('Atlas editor 21')).toBeVisible();
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
  },
};
