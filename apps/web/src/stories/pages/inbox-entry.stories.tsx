import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { env } from '../../../.storybook/cloudflare-workers';
import { InboxPageView } from '../../inbox/inbox-page';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { AppShell } from '../../shell/shell';
import { PatternStory } from '../page';

const meta = {
  title: 'Pages/Account/Inbox entry',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The current Inbox component and sessionQuery with the existing illustrative Storybook session transport and recorded Inbox responses. Pending and failed session reads are controlled locally; recovery reuses the original Storybook session stub. These examples provide no native session, privacy, visual or journey acceptance. Review with the shared phone390/desktop1280, locale and theme globals.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
type Scenario = 'pending' | 'unavailable' | 'recovered';

/** This changes only the existing illustrative Storybook RPC, never a production session or viewer. */
function SessionTransportExample({ scenario }: { scenario: Scenario }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sessions = env.SESSIONS as unknown as {
      get(id: unknown): { signedIn(): Promise<unknown> };
    };
    const original = sessions.get;
    let attempts = 0;
    let release = () => {};
    const pending = new Promise<false>((resolve) => (release = () => resolve(false)));
    sessions.get = (id) => {
      const existing = original.call(sessions, id);
      return {
        ...existing,
        signedIn: async () => {
          attempts++;
          if (scenario === 'pending') return pending;
          if (scenario === 'recovered' && attempts > 1) return existing.signedIn();
          // The existing Storybook envelope adapter leaves no subject after this failure.
          // The real viewer gate must stay closed until the original stub succeeds.
          throw new Error('Illustrative session dependency unavailable');
        },
      };
    };
    setReady(true);
    return () => {
      sessions.get = original;
      release();
    };
  }, [scenario]);
  if (!ready) return null;
  return (
    <AppShell>
      <InboxPageView />
    </AppShell>
  );
}

function SessionExample({ scenario }: { scenario: Scenario }) {
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed">
      <SessionTransportExample scenario={scenario} />
    </PatternStory>
  );
}

export const SignedOut: Story = {
  render: () => (
    <PatternStory visitor="Signed Out" path="/inbox?from=navigation">
      <AppShell>
        <InboxPageView />
      </AppShell>
    </PatternStory>
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const main = within(await view.findByRole('main'));
    const link = await main.findByRole('link', { name: m.inbox_sign_in() });
    await expect(link).toHaveAttribute(
      'href',
      `/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/inbox?from=navigation`)}`,
    );
    link.focus();
    await expect(link).toHaveFocus();
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_retry() })).toBeNull();
  },
};

export const Pending: Story = {
  render: () => <SessionExample scenario="pending" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const main = within(await view.findByRole('main'));
    await expect(await main.findByRole('status')).toHaveTextContent(m.inbox_loading());
    await expect(main.queryByRole('link', { name: m.inbox_sign_in() })).toBeNull();
    await expect(main.queryByRole('button', { name: m.inbox_retry() })).toBeNull();
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
  },
};

export const UnavailableRetryFails: Story = {
  render: () => <SessionExample scenario="unavailable" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const main = within(await view.findByRole('main'));
    await main.findByText(m.inbox_session_unavailable());
    const retry = main.getByRole('button', { name: m.inbox_retry() });
    await userEvent.click(retry);
    await waitFor(() => expect(retry).toBeEnabled());
    await expect(main.getByRole('status')).toHaveTextContent(m.inbox_session_unavailable());
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
  },
};

export const RecoveredSession: Story = {
  render: () => <SessionExample scenario="recovered" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const main = within(await view.findByRole('main'));
    await main.findByText(m.inbox_session_unavailable());
    await userEvent.click(main.getByRole('button', { name: m.inbox_retry() }));
    const list = within(await main.findByRole('list', { name: m.inbox_heading() }));
    await expect(list.getAllByRole('link')[0]).toHaveAttribute(
      'href',
      '/threads/01a17a3b-0884-721b-91ef-d7ffd7bb58f1#post-01a17a3b-0884-721b-91ef-d7ffd7bb58f2',
    );
    await expect(main.queryByText(m.inbox_session_unavailable())).toBeNull();
  },
};
