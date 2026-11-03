import { useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { FeedActionBar } from '../features/feed/action-bar';
import type { FeedReaction } from '../features/feed/vote-control';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';

function PreparedCard({
  signedIn = true,
  voted = false,
  refused = false,
  long = false,
}: {
  signedIn?: boolean;
  voted?: boolean;
  refused?: boolean;
  long?: boolean;
}) {
  const locale = getLocale();
  const [replies, setReplies] = useState(0);
  const client = useMemo(() => {
    const value = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    value.setQueryData(
      ['session'],
      signedIn
        ? { state: 'signed-in', subject: 'prepared-reader', csrfToken: 'prepared-csrf' }
        : { state: 'signed-out', subject: null, csrfToken: null },
    );
    return value;
  }, [signedIn]);
  const reaction = useMemo<FeedReaction>(() => {
    let value: 'upvote' | 'downvote' | null = voted ? 'upvote' : null;
    return {
      target: { kind: 'post', id: 'prepared-post' },
      counts: { upvote: 8, downvote: 2 },
      value,
      preparedTransport: {
        change: async ({ data }) => {
          if (refused) return { ok: false as const, reason: 'forbidden' as const };
          value = data.kind === 'upvote' || data.kind === 'downvote' ? data.kind : null;
          return { ok: true as const };
        },
        read: async () => ({
          ok: true as const,
          counts: { upvote: value === 'upvote' ? 9 : 8, downvote: value === 'downvote' ? 3 : 2 },
          value,
        }),
      },
    };
  }, [voted, refused]);
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto max-w-3xl space-y-4 p-4">
        <p role="note" className="text-sm text-muted-foreground">
          Prepared responses: illustrative vote receipts and unavailable feedback commands.
        </p>
        <article className="space-y-3 border-b border-border pb-4">
          <h1 className="text-xl font-semibold">
            {long
              ? 'A very long discussion title about reading together, sharing observations and returning to a work across languages — 一起閱讀的討論'
              : 'Reading together'}
          </h1>
          <p>What did you notice on the second reading?</p>
          <FeedActionBar
            locale={locale}
            title="Reading together"
            href={`/${locale}/threads/prepared/reading`}
            signedIn={signedIn}
            reaction={reaction}
            reply={{ onReply: () => setReplies((n) => n + 1) }}
            library={{ href: `/${locale}/subjects/prepared/work?slot=collections` }}
          >
            <a className="inline-flex min-h-11 items-center text-sm underline" href={`/${locale}/library/progress`}>
              Continue
            </a>
          </FeedActionBar>
          {replies ? <p role="status">Prepared reply destination opened.</p> : null}
        </article>
      </main>
    </QueryClientProvider>
  );
}

const meta = {
  title: 'Patterns/Feed/Action bar',
  component: PreparedCard,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof PreparedCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {
  globals: { viewport: { value: 'desktop1280' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.reaction_upvote() }));
    await expect(canvas.getByRole('button', { name: m.reaction_upvote() })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(canvas.getByRole('button', { name: m.feed_action_reply() }));
    await expect(canvas.getByRole('status')).toHaveTextContent('Prepared reply destination opened.');
    await expect(canvas.getByRole('link', { name: 'Continue' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: m.report_more() }));
    await expect(await screen.findByText(`${m.feed_action_mute()} · ${m.feed_action_unavailable()}`)).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};
export const SignedOut: Story = {
  args: { signedIn: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: m.reaction_upvote() })).toHaveAttribute(
      'href',
      `/${getLocale()}/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/threads/prepared/reading`)}`,
    );
    await expect(canvas.queryByRole('button', { name: m.report_action() })).toBeNull();
  },
};
export const Voted: Story = { args: { voted: true } };
export const Refused: Story = {
  args: { refused: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: m.reaction_downvote() }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.reaction_forbidden());
    await expect(canvas.getByRole('button', { name: m.reaction_downvote() })).toHaveAttribute('aria-pressed', 'false');
  },
};
export const Phone: Story = { ...SignedIn, globals: { viewport: { value: 'phone390' }, theme: 'light' } };
export const PhoneDarkLongStrings: Story = {
  ...SignedIn,
  args: { long: true },
  globals: { viewport: { value: 'phone390' }, theme: 'dark' },
};
export const DesktopDarkKeyboard: Story = {
  args: { long: true },
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const up = await canvas.findByRole('button', { name: m.reaction_upvote() });
    up.focus();
    await userEvent.keyboard('{Enter}');
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    const menu = canvas.getByRole('button', { name: m.report_more() });
    menu.focus();
    await userEvent.keyboard('{Enter}');
    await expect(await screen.findByText(m.report_copy())).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(menu).toHaveFocus();
  },
};
