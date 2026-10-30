import type { Meta, StoryObj } from '@storybook/react-vite';
import { createKernelClient } from '@rezics/client';
import { useQuery } from '@tanstack/react-query';
import { expect, userEvent, within } from 'storybook/test';
import { PrivateFollowCountsPageView } from '../library/private-follow-counts-page';
import { privateFollowCountsQuery, readFollowCounts, type FollowCountsSearch } from '../library/private-follow-counts';
import { m } from '../paraglide/messages.js';
import { AppShell } from '../shell/shell';
import { PatternStory } from './page';

const target = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
type Scenario = 'zero' | 'nonzero' | 'context' | 'denied' | 'unavailable' | 'loading' | 'invalid';

function CountsResponseStory({ scenario }: { scenario: Scenario }) {
  const viewer = { subject: 'count-story-viewer', csrfToken: 'count-story-session' };
  const context: FollowCountsSearch =
    scenario === 'invalid' ? { invalidContext: true } : ['context', 'denied'].includes(scenario) ? target : {};
  const query = useQuery(
    privateFollowCountsQuery(viewer, context, async () => {
      const client = createKernelClient('https://kernel.example.test', {
        fetch: (async (input) => {
          if (scenario === 'loading') return new Promise<Response>(() => {});
          const outgoing = String(input).endsWith('/outgoing');
          const status = scenario === 'unavailable' ? 503 : scenario === 'denied' && !outgoing ? 404 : 200;
          const body =
            status === 503
              ? { code: 'dependency_unavailable' }
              : status === 404
                ? { code: 'not_found' }
                : outgoing
                  ? { followingCount: scenario === 'zero' ? 0 : 24 }
                  : { ...target, followerCount: 0 };
          return Response.json(body, {
            status,
            headers: { 'cache-control': 'private, no-store', ...(status === 503 ? { 'retry-after': '7' } : {}) },
          });
        }) as typeof fetch,
      });
      return { viewer, ...(await readFollowCounts(client, 'Bearer story-transport', context)) };
    }),
  );
  return (
    <PrivateFollowCountsPageView
      page={query.isFetching || !query.data ? { context, outgoing: { state: 'loading' }, target: null } : query.data}
      busy={query.isFetching}
      onReload={() => void query.refetch()}
    />
  );
}

function CountsStory({ scenario = 'zero' }: { scenario?: Scenario }) {
  return (
    <PatternStory visitor="Signed In" path="/library/follow-counts">
      <AppShell>
        <CountsResponseStory scenario={scenario} />
      </AppShell>
    </PatternStory>
  );
}

const meta = {
  title: 'Pages/Library/Private follow counts',
  component: CountsStory,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Contract-shaped HTTP responses through the product count reader. Native authorization and visual review remain postintegration work; no fixture grants are supplied.',
      },
    },
  },
} satisfies Meta<typeof CountsStory>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ReadyZero: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('0', { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.library_follow_counts_context_help())).toBeVisible();
  },
};
export const ReadyNonzero: Story = { args: { scenario: 'nonzero' } };
export const ContextualZero: Story = {
  args: { scenario: 'context' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('0', { exact: true })).toBeVisible();
    await expect(canvas.getByText('24', { exact: true })).toBeVisible();
    await expect(canvas.queryByText(m.library_follow_counts_context_help())).toBeNull();
  },
};
export const DeniedContext: Story = {
  args: { scenario: 'denied' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_follow_counts_denied());
    await expect(canvas.queryByText('0', { exact: true })).toBeNull();
    await expect(canvas.getByText('24', { exact: true })).toBeVisible();
  },
};
export const Unavailable: Story = {
  args: { scenario: 'unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_follow_counts_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_counts_reload() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      m.library_follow_counts_retry_after({ value: '7' }),
    );
    await expect(canvas.queryByText('0', { exact: true })).toBeNull();
  },
};
export const Loading: Story = { args: { scenario: 'loading' } };
export const InvalidContext: Story = { args: { scenario: 'invalid' } };
