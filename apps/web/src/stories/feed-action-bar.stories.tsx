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
  plain = false,
  unavailable = false,
  countInspection = false,
}: {
  signedIn?: boolean;
  voted?: boolean;
  refused?: boolean;
  long?: boolean;
  plain?: boolean;
  unavailable?: boolean;
  countInspection?: boolean;
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
      counts: countInspection
        ? { upvote: 1234567890123, downvote: 1234567890130 }
        : { upvote: 8, downvote: 2 },
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
  }, [countInspection, voted, refused]);
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
            reaction={unavailable ? undefined : reaction}
            plain={plain}
            {...(countInspection ? { replyCount: 987654321012 } : {})}
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
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(`^${m.reaction_upvote()}\\s`) }));
    await expect(canvas.getByRole('button', { name: new RegExp(`^${m.reaction_upvote()}\\s`) })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
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
    await expect(canvas.getByRole('link', { name: new RegExp(`^${m.reaction_upvote()}\\s`) })).toHaveAttribute(
      'href',
      `/${getLocale()}/auth/sign-in?return_to=${encodeURIComponent(`/${getLocale()}/threads/prepared/reading`)}`,
    );
    await expect(canvas.queryByRole('button', { name: m.report_action() })).toBeNull();
  },
};
export const Voted: Story = { args: { voted: true } };
export const PlainReply: Story = { args: { plain: true, voted: true }, globals: { viewport: { value: 'phone390' } } };
export const UnavailableVotes: Story = { args: { unavailable: true }, globals: { viewport: { value: 'phone390' } } };
export const ExactCountsPhone: Story = {
  args: { countInspection: true, plain: true },
  globals: { viewport: { value: 'phone390' }, theme: 'light' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const upvoteCount = 1234567890123;
    const replyCount = 987654321012;
    await expect(
      canvas.getByRole('button', {
        name: `${m.reaction_upvote()} ${new Intl.NumberFormat(getLocale()).format(upvoteCount)}`,
      }),
    ).toBeVisible();
    await expect(
      canvas.getByRole('button', {
        name: `${m.feed_action_reply()} ${new Intl.NumberFormat(getLocale()).format(replyCount)}`,
      }),
    ).toBeVisible();
    await expect(canvasElement.querySelector('[data-slot="vote-control"] output')).toHaveAttribute('aria-label', '-7');
  },
};
export const ExactCountsDesktopDark: Story = {
  ...ExactCountsPhone,
  globals: { viewport: { value: 'desktop1280' }, theme: 'dark' },
};
export const CopiedLink: Story = {
  play: async ({ canvasElement }) => {
    const share = Object.getOwnPropertyDescriptor(navigator, 'share');
    const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
      const canvas = within(canvasElement);
      await userEvent.click(canvas.getByRole('button', { name: m.thread_reading_share() }));
      await expect(await canvas.findByRole('status')).toHaveTextContent(m.report_copy_success());
      await expect(canvas.getByRole('button', { name: m.thread_reading_share() })).toBeEnabled();
    } finally {
      if (share) Object.defineProperty(navigator, 'share', share);
      else Reflect.deleteProperty(navigator, 'share');
      if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  },
};
export const Refused: Story = {
  args: { refused: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: new RegExp(`^${m.reaction_downvote()}\\s`) }));
    await expect(await canvas.findByRole('status')).toHaveTextContent(m.reaction_forbidden());
    await expect(
      canvas.getByRole('button', { name: new RegExp(`^${m.reaction_downvote()}\\s`) }),
    ).toHaveAttribute('aria-pressed', 'false');
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
    const up = await canvas.findByRole('button', { name: new RegExp(`^${m.reaction_upvote()}\\s`) });
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
