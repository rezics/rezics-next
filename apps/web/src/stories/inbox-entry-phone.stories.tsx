import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { env } from '../../.storybook/cloudflare-workers';
import { InboxPageView } from '../inbox/inbox-page';
import { inboxContent } from '../inbox/adapters/presentation';
import { sessionQuery } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const meta = {
  title: 'Account/Inbox entry',
  id: 'pages-account-inbox-entry',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The actual Inbox page in AppShell with the existing illustrative Storybook session transport and recorded Inbox response. It follows signed-out entry into an unavailable session read, a held and failed retry, and recovery to the current viewer Inbox. No native session or private data is seeded.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

type InboxEntryPhoneJourney = {
  sessionReads: number;
  enterUnavailable(): void;
  releaseRetry(): void;
  privateInboxQueries(): number;
};

let activeJourney: InboxEntryPhoneJourney | undefined;

function InboxPageComposition() {
  const client = useQueryClient();
  useEffect(() => {
    const journey = activeJourney;
    if (!journey) return;
    journey.enterUnavailable = () =>
      client.setQueryData(sessionQuery.queryKey, { state: 'unavailable', csrfToken: null, subject: null });
    journey.privateInboxQueries = () =>
      client.getQueryCache().findAll({ queryKey: ['notifications', 'inbox', 'session'] }).length;
    return () => {
      journey.enterUnavailable = () => {};
      journey.privateInboxQueries = () => 0;
    };
  }, [client]);
  return (
    <AppShell>
      <InboxPageView content={inboxContent} />
    </AppShell>
  );
}

/** Patches only the existing Storybook session stub; production session and Inbox APIs stay intact. */
function SessionTransportExample() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const sessions = env.SESSIONS as unknown as {
      get(id: unknown): { signedIn(): Promise<unknown> };
    };
    const original = sessions.get;
    const journey: InboxEntryPhoneJourney = {
      sessionReads: 0,
      enterUnavailable: () => {},
      releaseRetry: () => {},
      privateInboxQueries: () => 0,
    };
    let releaseHeldRead = () => {};
    activeJourney = journey;
    sessions.get = (id) => {
      const existing = original.call(sessions, id);
      return {
        ...existing,
        signedIn: async () => {
          const read = ++journey.sessionReads;
          if (read === 1) return false;
          if (read === 2) {
            await new Promise<void>((resolve) => {
              releaseHeldRead = resolve;
              journey.releaseRetry = resolve;
            });
            throw new Error('Illustrative session dependency unavailable');
          }
          if (read === 3) return { signedIn: true, subject: 'story-viewer', csrfToken: 'story-csrf-token' };
          return existing.signedIn();
        },
      };
    };
    setReady(true);
    return () => {
      sessions.get = original;
      releaseHeldRead();
      if (activeJourney === journey) activeJourney = undefined;
    };
  }, []);

  return ready ? <InboxPageComposition /> : null;
}

function InboxEntryPhoneStory() {
  return (
    <PatternStory visitor="Signed In" path="/inbox?fixture=mixed&source=email&view=unread#latest">
      <SessionTransportExample />
    </PatternStory>
  );
}

function expectPhoneTarget(target: HTMLElement) {
  const rect = target.getBoundingClientRect();
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(390);
  expect(getComputedStyle(target).whiteSpace).toBe('normal');
  expect(getComputedStyle(target).maxWidth).not.toBe('none');
  return rect;
}

export const SignedOutAndSessionRecovery: Story = {
  name: 'Signed out and session recovery',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => <InboxEntryPhoneStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const main = within(await canvas.findByRole('main'));
    const heading = await main.findByRole('heading', { name: m.inbox_heading() });
    const signIn = await main.findByRole('link', { name: m.inbox_sign_in() });
    const journey = activeJourney;
    if (!journey) throw new Error('Inbox entry session transport was not installed');

    const safeReturn = `/${getLocale()}/inbox?fixture=mixed&source=email&view=unread#latest`;
    await expect(signIn).toHaveAttribute('href', `/auth/sign-in?return_to=${encodeURIComponent(safeReturn)}`);
    const signInBounds = expectPhoneTarget(signIn);
    expect(signInBounds.top - heading.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(24);
    await expect(signIn).toHaveClass('focus-visible:ring-2');
    signIn.focus();
    await expect(signIn).toHaveFocus();
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(journey.sessionReads).toBe(1);
    await expect(journey.privateInboxQueries()).toBe(0);

    journey.enterUnavailable();
    const status = await main.findByRole('status');
    const unavailable = await within(status).findByText(m.inbox_session_unavailable());
    const retry = within(status).getByRole('button', { name: m.inbox_retry() });
    const retryBounds = expectPhoneTarget(retry);
    const messageStyle = getComputedStyle(unavailable);
    const messageLineHeight = Number.parseFloat(messageStyle.lineHeight) || 20;
    expect(unavailable.getBoundingClientRect().height).toBeGreaterThan(messageLineHeight);
    expect(retryBounds.top - unavailable.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(16);
    expect(retry).toHaveClass('focus-visible:ring-3');
    retry.focus();
    await expect(retry).toHaveFocus();
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(journey.privateInboxQueries()).toBe(0);

    await userEvent.click(retry);
    await waitFor(() => expect(journey.sessionReads).toBe(2));
    await waitFor(() => expect(retry).toBeDisabled());
    await expect(status).toHaveAttribute('aria-busy', 'true');
    await userEvent.click(retry);
    await expect(journey.sessionReads).toBe(2);
    await expect(journey.privateInboxQueries()).toBe(0);
    journey.releaseRetry();

    await waitFor(() => expect(retry).toBeEnabled());
    await expect(status).toHaveTextContent(m.inbox_session_unavailable());
    await expect(status).toHaveAttribute('aria-busy', 'false');
    await expect(main.queryByRole('list', { name: m.inbox_heading() })).toBeNull();
    await expect(main.queryByText(m.inbox_empty())).toBeNull();
    await expect(journey.sessionReads).toBe(2);
    await expect(journey.privateInboxQueries()).toBe(0);

    await userEvent.click(retry);
    const list = await main.findByRole('list', { name: m.inbox_heading() });
    await expect(within(list).getAllByRole('link')).not.toHaveLength(0);
    await expect(main.queryByText(m.inbox_session_unavailable())).toBeNull();
    await expect(journey.sessionReads).toBe(3);
    await waitFor(() => expect(journey.privateInboxQueries()).toBeGreaterThan(0));
    await expect(canvasElement.ownerDocument.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  },
};
