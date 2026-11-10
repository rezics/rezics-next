import type { Meta, StoryObj } from '@storybook/react-vite';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { automation, detailExample, human, organization } from '../../accounts/management/story-api';
import { m } from '../../paraglide/messages.js';
import { ManagedAccountDetailCard } from '../../settings/managed-account-detail';
import { useSettingsAmbient } from '../../settings/adapters/ambient-view.tsx';
import { ManagedAccountReader, type DetailRead, type DetailSection } from '../../settings/managed-account-detail-read';

import { sessionQuery } from '../../session/query';
import { PatternStory } from '../page';
import { settingsContent } from '../../settings/adapters/presentation';

type ExampleProps = {
  member?: boolean;
  paging?: boolean;
  failed?: DetailSection;
  waiting?: boolean;
  long?: boolean;
};

function Example(props: ExampleProps) {
  return (
    <PatternStory visitor="Signed In" path={`/settings?managedAccount=${organization.id}#account`}>
      <ConnectedDetail {...props} />
    </PatternStory>
  );
}

// Illustrative native DTOs for component review, not proof of native authorization or completed operations.
function ConnectedDetail({ member = false, paging = false, failed, waiting = false, long = false }: ExampleProps) {
  const ambient = useSettingsAmbient();
  const client = useQueryClient();
  useState(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      csrfToken: 'story-csrf-token',
      subject: human.id,
    });
  });
  const reader = useMemo(() => {
    const read: DetailRead = async (input) => {
      const value = detailExample(organization.id);
      if (long) {
        const label = 'InternationaleLesegemeinschaftFürUnabhängigeVeröffentlichungen'.repeat(5);
        value.account = { ...value.account, displayName: label, handle: label.toLowerCase() };
        value.members.items[0]!.account = { ...human, displayName: label, handle: label.toLowerCase() };
      }
      if (member) {
        value.role = 'member';
        value.members = { state: 'denied', items: [], next: null };
        value.responsibilities = null;
      } else if (failed) {
        value.members.next = 'illustrative-signed-members-page';
        value.responsibilities!.next = 'illustrative-signed-responsibilities-page';
        if (input.section === failed && input.cursor)
          return {
            ok: false,
            failure: waiting
              ? { status: 429, code: 'rate_limited', transient: true, retryAfter: '60' }
              : { status: 400, code: 'invalid_cursor', transient: false },
          };
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
    return new ManagedAccountReader(human.id, organization.id, read, ambient);
  }, [ambient, member, paging, failed, waiting, long]);
  useEffect(() => {
    let active = true;
    void reader.load().then(() => {
      if (active && failed) void reader.load(failed, `illustrative-signed-${failed}-page`);
    });
    return () => {
      active = false;
      reader.clear();
    };
  }, [reader, failed]);
  return (
    <div className="mx-auto min-w-0 max-w-3xl">
      <ManagedAccountDetailCard
        reader={reader}
        backHref="/en/settings?view=accounts#account"
        initials={settingsContent.initials}
        mediaFailure={settingsContent.mediaFailure}
      />
    </div>
  );
}

const meta = {
  title: 'Account/Managed account detail',
  id: 'patterns-account-managed-account-detail',
  component: Example,
  parameters: { layout: 'padded' },
  afterEach: async ({ canvasElement }) => {
    // Every original state retains the actual session-connected action region.
    await expect(
      await within(canvasElement).findByRole('heading', { level: 3, name: m.managed_actions_title() }),
    ).toBeVisible();
  },
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
    await expect(canvas.queryByRole('heading', { level: 4 })).toBeNull();
  },
};

export const ManagerObservations: Story = {
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(m.managed_current());
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
    await expect(canvas.getByText(m.settings_managed_observation())).toBeVisible();
    const holder = canvas.getByRole('heading', { level: 4, name: human.displayName }).closest('li')!;
    await expect(holder).toHaveRole('listitem');
    await expect(within(holder).queryByRole('link')).toBeNull();
    await expect(holder.querySelector('[data-content-item-slot="metadata"]')).toHaveTextContent(`@${human.handle}`);
    await expect(holder.querySelector('[data-content-item-slot="state"]')).toHaveTextContent(m.managed_owner());
    const responsibilities = within(canvas.getByRole('region', { name: m.managed_operated_title() }));
    await expect(responsibilities.getAllByRole('heading', { level: 4 }).map((heading) => heading.textContent)).toEqual([
      automation.displayName,
      m.settings_managed_detail_identity_unavailable(),
    ]);
    await expect(responsibilities.queryByRole('link')).toBeNull();
    await expect(responsibilities.getByText(m.settings_managed_detail_identity_unavailable())).toBeVisible();
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
    await expect(canvas.getByRole('heading', { level: 4, name: 'Atlas editor 21' })).toBeVisible();
    await expect(canvas.queryByRole('heading', { level: 4, name: 'Atlas editor 1' })).toBeNull();
    await expect(canvas.getByText(m.managed_current())).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: `${m.managed_next()} · ${m.managed_operated_title()}` }));
    await canvas.findByRole('alert');
    await expect(canvas.getByText('Atlas editor 21')).toBeVisible();
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
  },
};

export const MembersFirstPageRecovery: Story = {
  args: { failed: 'members' },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    const members = within(canvas.getByRole('region', { name: m.managed_holders_title() }));
    await expect(members.queryByText(human.displayName)).toBeNull();
    await userEvent.click(
      members.getByRole('button', { name: `${m.settings_retry()} · ${m.managed_holders_title()}` }),
    );
    await members.findByRole('alert'); // The exact expired continuation is still refused.
    const restart = members.getByRole('button', {
      name: `${m.settings_managed_start_first_page()} · ${m.managed_holders_title()}`,
    });
    restart.focus();
    await expect(restart).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await members.findByText(human.displayName);
    await expect(members.queryByRole('alert')).toBeNull();
    await expect(canvas.getByText(m.managed_current())).toBeVisible();
    await expect(canvas.getByText(m.managed_reconciling())).toBeVisible();
  },
};

export const ResponsibilitiesContinuationFailure: Story = {
  args: { failed: 'responsibilities' },
  globals: { viewport: { value: 'desktop1280' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    const responsibilities = within(canvas.getByRole('region', { name: m.managed_operated_title() }));
    await expect(
      responsibilities.getByRole('button', {
        name: `${m.settings_managed_start_first_page()} · ${m.managed_operated_title()}`,
      }),
    ).toBeEnabled();
    await expect(responsibilities.queryByText(m.managed_current())).toBeNull();
    await expect(responsibilities.queryByText(m.managed_no_responsibilities())).toBeNull();
    await expect(canvas.getByText(human.displayName)).toBeVisible();
    await userEvent.click(
      responsibilities.getByRole('button', {
        name: `${m.settings_managed_start_first_page()} · ${m.managed_operated_title()}`,
      }),
    );
    await responsibilities.findByText(m.managed_current());
    await expect(responsibilities.queryByRole('alert')).toBeNull();
  },
};

export const ContinuationRetryAfter: Story = {
  args: { failed: 'responsibilities', waiting: true },
  globals: { viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    const responsibilities = within(canvas.getByRole('region', { name: m.managed_operated_title() }));
    await expect(responsibilities.getByText(m.settings_retry_wait())).toBeVisible();
    for (const action of [m.settings_retry(), m.settings_managed_start_first_page()]) {
      await expect(
        responsibilities.getByRole('button', { name: `${action} · ${m.managed_operated_title()}` }),
      ).toBeDisabled();
    }
    await expect(responsibilities.getByText(m.managed_current())).toBeVisible();
    await expect(canvas.getByText(human.displayName)).toBeVisible();
  },
};

export const LongLocaleRecoveryPhone: Story = {
  args: { failed: 'members', long: true },
  globals: { locale: 'de', viewport: { value: 'phone390' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('alert');
    const card = canvasElement
      .querySelector<HTMLElement>('#settings-account-heading')!
      .closest<HTMLElement>('[data-slot="card"]')!;
    const members = within(canvas.getByRole('region', { name: m.managed_holders_title() }));
    for (const label of [m.settings_retry(), m.settings_managed_start_first_page()]) {
      const button = members.getByRole('button', { name: `${label} · ${m.managed_holders_title()}` });
      await expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(44);
      await expect(getComputedStyle(button).whiteSpace).toBe('normal');
      await expect(button.scrollWidth).toBeLessThanOrEqual(button.clientWidth + 1);
    }
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
    await userEvent.click(
      members.getByRole('button', {
        name: `${m.settings_managed_start_first_page()} · ${m.managed_holders_title()}`,
      }),
    );
    await members.findByRole('heading', { level: 4 });
    await expect(members.queryByRole('alert')).toBeNull();
    await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  },
};
