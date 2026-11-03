import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import { setLibraryFollowingStoryMode, type LibraryFollowingStoryMode } from '../kernel/fake/library-following-story';
import { PageStory, libraryFollowingReady, libraryHeadingReady, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Following',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function FollowingStory(mode: LibraryFollowingStoryMode = 'recorded') {
  setLibraryFollowingStoryMode(mode);
  return <PageStory visitor="Signed In" path={pagePaths['library-following']} />;
}

async function followRow(canvasElement: HTMLElement, title: string) {
  await libraryHeadingReady({ canvasElement }, m.library_following_heading);
  const heading = await within(canvasElement).findByRole('heading', { level: 3, name: title });
  const row = heading.closest<HTMLElement>('li[data-slot="list-row"]');
  if (!row) throw new globalThis.Error(`Missing Following row: ${title}`);
  return row;
}

async function followMenu(canvasElement: HTMLElement, title: string) {
  const row = await followRow(canvasElement, title);
  await userEvent.click(within(row).getByRole('button', { name: m.library_follow_more_actions({ title }) }));
  const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
  const menu = await within(canvasElement.ownerDocument.body).findByRole(
    sheet ? 'dialog' : 'menu',
    sheet ? { name: m.library_follow_more_actions({ title }) } : undefined,
  );
  const action = await within(menu).findByRole(sheet ? 'button' : 'menuitem', { name: m.library_follow_unfollow() });
  await waitFor(() => expect(action).toBeVisible());
  return action;
}

export const SignedIn: Story = {
  name: 'Signed In',
  play: libraryFollowingReady,
  render: () => FollowingStory(),
};

export const UnfollowMenuPhone: Story = {
  name: 'Unfollow menu phone',
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => FollowingStory(),
  play: async (context) => {
    await pageReady(context);
    await followMenu(context.canvasElement, 'Kokoro');
  },
};

export const Empty: Story = {
  render: () => FollowingStory('none'),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_following_heading);
    await expect(await within(context.canvasElement).findByText(m.library_following_empty())).toBeVisible();
  },
};

export const InactivePage: Story = {
  render: () => FollowingStory('inactive-page'),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_following_heading);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_following_page_empty())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.search_heading() })).toHaveAttribute('href', /\/search$/);
    await expect(canvas.getByRole('link', { name: m.library_collection_more() })).toHaveAttribute(
      'href',
      /cursor=next-page/,
    );
  },
};

export const AfterLastUnfollow: Story = {
  render: () => FollowingStory('last-follow'),
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    await userEvent.click(await followMenu(context.canvasElement, 'Kokoro'));
    await expect(await canvas.findByText(m.library_follow_removed())).toBeVisible();
    await expect(await canvas.findByText(m.library_following_page_empty())).toBeVisible();
    await expect(canvas.getByRole('link', { name: m.library_collections_first_page() })).toHaveAttribute(
      'href',
      /\/library\/following$/,
    );
    await expect(canvas.getByRole('link', { name: m.search_heading() })).toHaveAttribute('href', /\/search$/);
    await expect(canvas.queryByRole('link', { name: 'Kokoro' })).toBeNull();
  },
};

export const LongContent: Story = {
  render: () => FollowingStory('many'),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_following_heading);
    await expect(
      await within(context.canvasElement).findByRole('heading', { name: 'Following item 12' }),
    ).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => FollowingStory('unavailable'),
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() }),
    ).toBeVisible();
  },
};

export const Error: Story = {
  render: () => FollowingStory('error'),
  play: async (context) => {
    await pageReady(context);
    await expect(
      await within(context.canvasElement).findByRole('heading', { level: 1, name: m.error_heading() }),
    ).toBeVisible();
  },
};

export const HiddenTarget: Story = {
  render: () => FollowingStory('hidden'),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_following_heading);
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
    const row = await followRow(context.canvasElement, 'Kokoro');
    await expect(row).not.toHaveClass(/border|bg-card|shadow/);
    await userEvent.click(await followMenu(context.canvasElement, 'Kokoro'));
    await expect(await within(row).findByRole('alert')).toHaveTextContent(m.error_message());
    await expect(canvas.getByRole('link', { name: 'Kokoro' })).toBeVisible();
  },
};

export const ListRowBehavior: Story = {
  play: async (context) => {
    await pageReady(context);
    const canvas = within(context.canvasElement);
    const link = await canvas.findByRole('link', { name: 'Kokoro' });
    const row = await followRow(context.canvasElement, 'Kokoro');
    await expect(row).not.toHaveClass(/border|bg-card|shadow/);
    await userEvent.hover(row as HTMLElement);
    await userEvent.click(link);
    await expect(await canvas.findByRole('heading', { level: 1, name: /Kokoro/ })).toBeVisible();
  },
  render: () => FollowingStory(),
};

export const RemoveUnavailableTarget: Story = {
  render: () => FollowingStory('hidden'),
  play: async ({ canvasElement, ...context }) => {
    await libraryHeadingReady({ canvasElement, ...context }, m.library_following_heading);
    const canvas = within(canvasElement);
    const section = canvasElement.querySelector<HTMLElement>('[data-follow-target-type="collection"]')!;
    const heading = await within(section).findByRole('heading', { level: 3, name: m.library_subject_unavailable() });
    const row = heading.closest<HTMLElement>('li[data-slot="list-row"]');
    if (!row) throw new globalThis.Error('Unavailable follow row is missing');
    await expect(within(row).queryByRole('link')).toBeNull();
    await userEvent.click(
      within(row).getByRole('button', {
        name: m.library_follow_more_actions({ title: m.library_subject_unavailable() }),
      }),
    );
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    const body = within(canvasElement.ownerDocument.body);
    const remove = await body.findByRole(sheet ? 'button' : 'menuitem', { name: m.library_follow_unfollow() });
    await userEvent.click(remove);
    await expect(await canvas.findByText(m.library_follow_removed())).toBeVisible();
    await expect(row).not.toBeInTheDocument();
    await expect(canvas.getAllByText(m.library_subject_unavailable(), { exact: true })).toHaveLength(1);
  },
};

export const UnfollowMenuDesktop: Story = {
  globals: { viewport: { value: 'desktop1280', isRotated: false } },
  render: () => FollowingStory(),
  play: async (context) => {
    await pageReady(context);
    await followMenu(context.canvasElement, 'Kokoro');
  },
};

async function inspectCommunity(canvasElement: HTMLElement) {
  await libraryHeadingReady({ canvasElement }, m.library_following_heading);
  const row = canvasElement.querySelector<HTMLElement>('[data-follow-target-type="space"]')!;
  await userEvent.click(
    within(row).getByRole('button', {
      name: m.following_reading_inspect_target({ title: row.querySelector('h3')!.textContent! }),
    }),
  );
}

export const InspectionReady: Story = {
  render: () => FollowingStory(),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    const panel = await within(canvasElement).findByRole('dialog');
    await expect(await within(panel).findByText(m.following_reading_current_identity())).toBeVisible();
  },
};
export const CommunityPreparing: Story = {
  render: () => FollowingStory('reading-preparing'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_preparing())).toBeVisible();
  },
};
export const InspectionUnavailable: Story = {
  render: () => FollowingStory('reading-unavailable'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_unavailable())).toBeVisible();
  },
};
export const NoDestination: Story = {
  render: () => FollowingStory('reading-no-destination'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_no_destination())).toBeVisible();
  },
};
export const LongLocalizedInspection: Story = {
  globals: { viewport: { value: 'phone390', isRotated: false } },
  render: () => FollowingStory('reading-long'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByRole('dialog')).toBeVisible();
  },
};
export const CurrentSourceInspection: Story = {
  render: () => FollowingStory('reading-current-source'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.following_reading_refresh() }));
    await waitFor(() => expect(within(canvasElement).queryByRole('dialog')).toBeNull());
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByRole('dialog')).toBeVisible();
  },
};
