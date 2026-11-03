import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fromPlainText } from '@rezics/document';
import { m } from '../paraglide/messages.js';
import { sessionQuery } from '../session/query';
import recorded from '../kernel/recorded/thread.json';
import { PostComposer } from '../threads/composer';
import {
  SlowModePortProvider,
  SlowModeSetting,
  type SlowModePolicy,
  type SlowModePort,
  type SlowModeRead,
} from '../threads/slow-mode';
import { PatternStory } from './page';

const meta = {
  title: 'Pages/Community/Board slow mode',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Illustrative native-format slow-mode policy for the actual setting and composer. Positive native recordings remain deferred until Content installs boards({ id }).slowMode.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const draft = fromPlainText('A reply kept while the board enforces its posting interval.', 'blocks');
const boardId = recorded.thread.boardId;

function policy(
  intervalSeconds: SlowModePolicy['intervalSeconds'],
  nextEligibleAt: string | null = null,
): Extract<SlowModeRead, { kind: 'available' }> {
  return {
    kind: 'available',
    policy: { intervalSeconds, nextEligibleAt, canChange: true, exempt: false },
  };
}

function Host({ port, children }: { port: SlowModePort; children: ReactNode }) {
  const client = useQueryClient();
  useLayoutEffect(() => {
    client.setQueryData(sessionQuery.queryKey, {
      state: 'signed-in',
      subject: recorded.thread.authorId,
      csrfToken: 'slow-mode-story',
    });
  }, [client]);
  return <SlowModePortProvider port={port}>{children}</SlowModePortProvider>;
}

function Journey({ initial, refuse }: { initial: SlowModeRead; refuse?: boolean }) {
  const [current, setCurrent] = useState(initial);
  const port = useMemo<SlowModePort>(
    () => ({
      read: async () => current,
      change: async ({ intervalSeconds }) => {
        if (current.kind !== 'available') return { kind: 'unavailable' };
        const next = policy(intervalSeconds, current.policy.nextEligibleAt);
        setCurrent(next);
        return { kind: 'applied', policy: next.policy };
      },
    }),
    [current],
  );
  return (
    <PatternStory visitor="Signed In">
      <Host port={port}>
        <main className="mx-auto grid w-full min-w-0 max-w-4xl gap-6 p-4 sm:p-8">
          <SlowModeSetting boardId={boardId} />
          <PostComposer
            titleRequired
            boardId={boardId}
            initialKey="0192f3a0-6c1e-7b2a-9d4e-000000000092"
            initialBody={draft}
            onSubmit={async () =>
              refuse
                ? { ok: false as const, reason: 'rate-limited' as const, retryAfter: 0 }
                : { ok: false as const, reason: 'unavailable' as const }
            }
            onSuccess={() => undefined}
          />
        </main>
      </Host>
    </PatternStory>
  );
}

export const NewlyChangedPolicy: Story = {
  name: 'Newly changed policy',
  render: () => <Journey initial={policy(0)} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.slow_mode_setting_legend());
    await userEvent.click(await view.findByText(m.slow_mode_interval_seconds({ seconds: 60 })));
    await userEvent.click(await view.findByRole('button', { name: m.slow_mode_apply() }));
    await view.findByText(m.slow_mode_saved());
    await view.findByText(m.slow_mode_interval_label({ label: m.slow_mode_interval_seconds({ seconds: 60 }) }));
  },
};

export const CooldownRefusal: Story = {
  name: 'Cooldown refusal',
  render: () => <Journey initial={policy(30)} refuse />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = await view.findByLabelText(m.thread_title_label());
    await userEvent.type(title, 'Kept draft');
    await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
    await view.findByRole('alert');
    await expect(title).toHaveValue('Kept draft');
    await view.findByText(m.slow_mode_guidance());
    await expect(view.getByRole('button', { name: m.thread_write_send() })).toBeEnabled();
  },
};

export const UnavailableEligibility: Story = {
  name: 'Unavailable eligibility',
  render: () => <Journey initial={{ kind: 'unavailable' }} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.slow_mode_next_unavailable());
    await view.findByText(m.slow_mode_unavailable());
    await expect(view.getAllByRole('button', { name: m.slow_mode_retry() }).length).toBeGreaterThan(0);
  },
};

export const ExplicitResubmission: Story = {
  name: 'Explicit resubmission',
  render: () => <Journey initial={policy(30)} refuse />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.type(await view.findByLabelText(m.thread_title_label()), 'Retry after the board refusal');
    await userEvent.click(await view.findByRole('button', { name: m.thread_write_send() }));
    const retry = await view.findByRole('button', { name: m.thread_write_retry() });
    await userEvent.click(retry);
    await waitFor(() => expect(view.getAllByRole('alert').length).toBeGreaterThan(0));
    await expect(view.getByLabelText(m.thread_title_label())).toHaveValue('Retry after the board refusal');
  },
};
