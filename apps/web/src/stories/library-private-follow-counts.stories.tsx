import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import {
  privateFollowCountsStoryTarget,
  setPrivateFollowCountsStoryMode,
  type PrivateFollowCountsStoryMode,
} from '../kernel/fake/private-follow-counts-stories';
import { m } from '../paraglide/messages.js';
import { PageStory, pageReady } from './page';

const countsPath = '/library/follow-counts';
const contextPath = `${countsPath}?targetType=${privateFollowCountsStoryTarget.targetType}&targetId=${privateFollowCountsStoryTarget.targetId}`;

const meta = {
  title: 'Pages/Library/Private follow counts',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Actual /library/follow-counts route through contract-shaped story kernel responses and the product count reader. Native authorization and visual review remain postintegration work; no fixture grants are supplied.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function CountsStory({ mode, path = countsPath }: { mode: PrivateFollowCountsStoryMode; path?: string }) {
  setPrivateFollowCountsStoryMode(mode);
  useEffect(() => () => setPrivateFollowCountsStoryMode('absent'), []);
  return <PageStory visitor="Signed In" path={path} />;
}

export const ReadyZero: Story = {
  render: () => <CountsStory mode="zero" />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('0', { exact: true })).toBeVisible();
    await expect(canvas.getByText(m.library_follow_counts_context_help())).toBeVisible();
  },
};
export const ReadyNonzero: Story = { render: () => <CountsStory mode="nonzero" /> };
export const ContextualZero: Story = {
  render: () => <CountsStory mode="context" path={contextPath} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('0', { exact: true })).toBeVisible();
    await expect(canvas.getByText('24', { exact: true })).toBeVisible();
    await expect(canvas.queryByText(m.library_follow_counts_context_help())).toBeNull();
  },
};
export const DeniedContext: Story = {
  render: () => <CountsStory mode="denied" path={contextPath} />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_follow_counts_denied());
    await expect(canvas.queryByText('0', { exact: true })).toBeNull();
    await expect(canvas.getByText('24', { exact: true })).toBeVisible();
  },
};
export const Unavailable: Story = {
  render: () => <CountsStory mode="unavailable" />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('alert')).toHaveTextContent(m.library_follow_counts_unavailable());
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_counts_reload() }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      m.library_follow_counts_retry_after({ value: '7' }),
    );
    await expect(canvas.queryByText('0', { exact: true })).toBeNull();
  },
};
export const Loading: Story = {
  render: () => <CountsStory mode="loading" />,
  play: async ({ canvasElement }) => {
    await pageReady({ canvasElement });
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent(m.library_follow_counts_loading());
  },
};
export const InvalidContext: Story = {
  render: () => <CountsStory mode="nonzero" path={`${countsPath}?targetType=collection`} />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole('status')).toHaveTextContent(
      m.library_follow_counts_invalid_context(),
    );
  },
};
