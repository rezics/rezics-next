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
    viewport: {
      defaultViewport: 'slowMode390',
      options: {
        slowMode390: { name: '390 × 844', styles: { width: '390px', height: '844px' } },
        slowMode1280: { name: '1280 × 900', styles: { width: '1280px', height: '900px' } },
      },
    },
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
const longDraft = fromPlainText('A long draft that remains readable while the posting interval is active. '.repeat(24), 'blocks');
const boardId = recorded.thread.boardId;

function policy(
  intervalSeconds: SlowModePolicy['intervalSeconds'],
  nextEligibleAt: string | null = null,
  options: { canChange?: boolean; exempt?: boolean; admissionState?: SlowModePolicy['admissionState'] } = {},
): Extract<SlowModeRead, { kind: 'available' }> {
  const admissionState = options.admissionState ?? (nextEligibleAt ? 'interval' : 'ready');
  return {
    kind: 'available',
    policy: {
      intervalSeconds,
      retryAt: nextEligibleAt,
      nextEligibleAt,
      canChange: options.canChange ?? true,
      exempt: options.exempt ?? false,
      admissionState,
      retryAfterSeconds: admissionState === 'pending' ? 1 : 0,
    },
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

function Journey({
  initial,
  refuse,
  unknown,
  body = draft,
}: {
  initial: SlowModeRead;
  refuse?: boolean;
  unknown?: boolean;
  body?: typeof draft;
}) {
  const [current, setCurrent] = useState(initial);
  const port = useMemo<SlowModePort>(
    () => ({
      read: async () => current,
      change: async ({ intervalSeconds }) => {
        if (unknown) return { kind: 'unknown' };
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
            initialBody={body}
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

export const ManagerControlsCurrentPolicy: Story = {
  name: 'Manager controls a current nonpreset policy',
  render: () => <Journey initial={policy(45)} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const group = await view.findByRole('radiogroup', { name: m.slow_mode_setting_legend() });
    const preset = within(group).getByRole('radio', {
      name: m.slow_mode_interval_seconds({ seconds: 30 }),
    });
    preset.focus();
    await userEvent.keyboard(' ');
    await expect(preset).toBeChecked();
  },
};

export const OrdinaryWriter: Story = {
  name: 'Ordinary writer',
  render: () => <Journey initial={policy(45, null, { canChange: false })} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.slow_mode_interval_label({ label: m.slow_mode_interval_seconds({ seconds: 45 }) }));
    await expect(view.queryByRole('radiogroup', { name: m.slow_mode_setting_legend() })).not.toBeInTheDocument();
  },
};

export const PendingWriter: Story = {
  name: 'Writer with a pending admission',
  render: () => <Journey initial={policy(300, null, { admissionState: 'pending' })} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByText(m.slow_mode_preparing());
    await expect(view.queryByText(m.slow_mode_next_now())).not.toBeInTheDocument();
  },
};

export const MaximumLongInterval: Story = {
  name: 'Maximum interval with a long draft',
  render: () => (
    <Journey
      initial={policy(86400, new Date(Date.now() + 86400_000).toISOString())}
      body={longDraft}
    />
  ),
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const title = await view.findByLabelText(m.thread_title_label());
    await userEvent.type(title, 'A deliberately long title that wraps at a narrow viewport.');
    await view.findByText(m.slow_mode_interval_label({ label: m.slow_mode_interval_seconds({ seconds: 86400 }) }));
    await expect(title).toHaveValue('A deliberately long title that wraps at a narrow viewport.');
  },
};

export const DeniedManager: Story = {
  name: 'Denied setting admission',
  render: () => <Journey initial={{ kind: 'denied' }} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(view.queryByRole('radiogroup', { name: m.slow_mode_setting_legend() })).not.toBeInTheDocument();
    await expect(view.queryByRole('button', { name: m.slow_mode_apply() })).not.toBeInTheDocument();
  },
};

export const UnknownSettingIntent: Story = {
  name: 'Unknown setting intent',
  render: () => <Journey initial={policy(45)} unknown />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('radiogroup', { name: m.slow_mode_setting_legend() });
    await userEvent.click(view.getByRole('radio', { name: m.slow_mode_interval_seconds({ seconds: 300 }) }));
    await userEvent.click(await view.findByRole('button', { name: m.slow_mode_apply() }));
    await view.findByRole('alert', { name: m.slow_mode_unknown() });
    await userEvent.click(await view.findByRole('button', { name: m.slow_mode_retry() }));
    await expect(view.getByRole('alert')).toHaveTextContent(m.slow_mode_unknown());
  },
};
