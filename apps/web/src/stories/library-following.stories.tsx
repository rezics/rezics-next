import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { setLibraryFollowingStoryMode, type LibraryFollowingStoryMode } from '../kernel/fake/library-following-story';
import { PageStory, libraryFollowingReady, pagePaths, pageReady } from './page';

const viewports = {
  phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' }, type: 'mobile' as const },
};
const meta = {
  title: 'Pages/Library/Following',
  parameters: { layout: 'fullscreen', viewport: { viewports } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function FollowingStory(mode: LibraryFollowingStoryMode = 'recorded') {
  setLibraryFollowingStoryMode(mode);
  return <PageStory visitor="Signed In" path={pagePaths['library-following']} />;
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryFollowingReady,
  render: () => FollowingStory(),
};

export const UnfollowMenuPhone: Story = {
  name: 'Unfollow menu phone',
  parameters: { viewport: { defaultViewport: 'phone390' } },
  render: () => FollowingStory(),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /more actions for/i }));
    const dialog = context.canvasElement.querySelector('[data-slot="drawer-content"]');
    await expect(dialog).toBeVisible();
    await expect(
      within(dialog as HTMLElement).getByRole('button', { name: m.library_follow_unfollow() }),
    ).toBeVisible();
  },
};

export const Empty: Story = {
  render: () => FollowingStory('none'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByText(m.library_following_empty())).toBeVisible();
  },
};

export const LongContent: Story = {
  render: () => FollowingStory('many'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByText('Following item 12')).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => FollowingStory('unavailable'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const Error: Story = {
  render: () => FollowingStory('error'),
  play: async (context) => {
    await pageReady(context);
    await expect(within(context.canvasElement).getByRole('main')).toBeVisible();
  },
};

export const HiddenTarget: Story = {
  render: () => FollowingStory('hidden'),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const unavailable = await canvas.findAllByText(m.library_subject_unavailable(), { exact: true });
    await expect(unavailable).toHaveLength(2);
    await expect(canvas.getByRole('link', { name: /Kokoro/ })).toBeVisible();
  },
};

export const UnfollowFailure: Story = {
  render: () => FollowingStory('unfollow-failure'),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const link = await canvas.findByRole('link', { name: 'Kokoro' });
    const row = link.closest<HTMLElement>('[data-slot="list-row"]');
    await expect(row).toBeTruthy();
    await expect(row).not.toHaveClass(/border|bg-card|shadow/);
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: /more actions for/i }));
    const sheet = context.canvasElement.querySelector('[data-slot="drawer-content"]');
    const action = sheet
      ? within(sheet as HTMLElement).getByRole('button', { name: m.library_follow_unfollow() })
      : canvas.getByRole('menuitem', { name: m.library_follow_unfollow() });
    await userEvent.click(action);
    await expect(canvas.getByRole('alert')).toHaveTextContent(m.error_message());
    await expect(canvas.getByRole('link', { name: 'Kokoro' })).toBeVisible();
  },
};

export const ListRowBehavior: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const link = await canvas.findByRole('link', { name: 'Kokoro' });
    const row = link.closest<HTMLElement>('[data-slot="list-row"]');
    await expect(row).toBeTruthy();
    await expect(row).not.toHaveClass(/border|bg-card|shadow/);
    await userEvent.hover(row as HTMLElement);
    await userEvent.click(link);
    await expect(canvas.getByRole('heading', { level: 1, name: /Kokoro/ })).toBeVisible();
  },
  render: () => FollowingStory(),
};

export const UnfollowMenuDesktop: Story = {
  parameters: {
    viewport: {
      viewports: { desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } } },
      defaultViewport: 'desktop1280',
    },
  },
  render: () => FollowingStory(),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await canvas.findByRole('button', { name: /more actions for/i }));
    await expect(canvas.getByRole('menuitem', { name: m.library_follow_unfollow() })).toBeVisible();
  },
};
