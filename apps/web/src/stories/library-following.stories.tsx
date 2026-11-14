import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { m } from '../paraglide/messages.js';
import {
  followingStoryCollectionId,
  followingStoryCursor,
  followingStorySpaceId,
  followingStoryZoneId,
  followingStoryZoneTitle,
  libraryFollowingStoryReads,
  setLibraryFollowingStoryAdmission,
  setLibraryFollowingStoryMode,
  type LibraryFollowingStoryMode,
} from '../kernel/fake/library-following-story';
import {
  PageStory,
  libraryFollowingReady,
  libraryFollowingKeyboardInteraction,
  libraryHeadingReady,
  pagePaths,
  pageReady,
  type PageStoryContext,
} from './page';

const meta = {
  title: 'Library/Following',
  id: 'pages-library-following',
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'One native Following page presents identity and kind before independent Open, Inspect and removal controls. Selected Space details come from one deliberate read; references and follow meaning are disclosed separately. Routed stories include admission withdrawal, a persisted-document return and retry at the same kind/cursor. These synthetic transitions are source acceptance cases for later browser verification.',
      },
    },
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

let currentPage: PageStoryContext | null = null;
function capturePage(context: PageStoryContext) {
  currentPage = context;
  return () => {
    if (currentPage === context) currentPage = null;
  };
}

function FollowingStory(mode: LibraryFollowingStoryMode = 'recorded', path: string = pagePaths['library-following']) {
  setLibraryFollowingStoryMode(mode);
  return <PageStory visitor="Signed In" path={path} onReady={capturePage} />;
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
  play: async (context) => {
    await libraryFollowingReady(context);
    const rows = context.canvasElement.querySelectorAll('[data-follow-target-type]');
    await expect([...rows].map((row) => row.getAttribute('data-follow-target-type'))).toEqual([
      'space',
      'collection',
      'subject',
      'subject',
    ]);
    const canvas = within(context.canvasElement);
    const covered = await followRow(context.canvasElement, 'The Little Prince');
    await expect(covered.querySelector('[data-content-item-slot="visual"]')).not.toBeNull();
    await expect(canvas.getByRole('link', { name: m.following_reading_open({ title: 'Kokoro' }) })).toBeVisible();
    await expect(
      canvas.getByRole('link', { name: m.following_reading_open({ title: 'A quiet space' }) }),
    ).toHaveAttribute('href', /\/spaces\/quiet-novel-club$/);
  },
  render: () => FollowingStory(),
};

export const NativeZoneInspection: Story = {
  render: () => FollowingStory('native-zone'),
  play: async ({ canvasElement }) => {
    let row = await followRow(canvasElement, followingStoryZoneTitle);
    await expect(within(row).getByText(m.library_following_kind_zone(), { exact: true })).toBeVisible();
    await userEvent.click(within(canvasElement).getByRole('link', { name: m.following_kind_zone(), exact: true }));
    await waitFor(() => expect(libraryFollowingStoryReads().at(-1)?.targetType).toBe('zone'));
    row = await followRow(canvasElement, followingStoryZoneTitle);
    await expect(
      within(row).getByRole('link', { name: m.following_reading_open({ title: followingStoryZoneTitle }) }),
    ).toHaveAttribute('href', new RegExp(`/zones/${followingStoryZoneId}$`));
    await userEvent.click(
      within(row).getByRole('button', {
        name: m.following_reading_inspect_target({ title: followingStoryZoneTitle }),
      }),
    );
    const panel = await within(canvasElement).findByRole('dialog');
    await expect(within(panel).getByRole('heading', { name: followingStoryZoneTitle })).toHaveFocus();
    await userEvent.click(within(panel).getByText(m.following_reading_details()));
    await expect(within(panel).getByText(m.following_reading_zone_id())).toBeVisible();
    await expect(within(panel).getByText(followingStoryZoneId)).toBeVisible();
    await expect(libraryFollowingStoryReads().some(({ targetType }) => targetType === null)).toBe(true);
  },
};

export const ZoneUnavailableDestination: Story = {
  render: () => FollowingStory('zone-unavailable', `${pagePaths['library-following']}?kind=zone`),
  play: async ({ canvasElement }) => {
    const row = await followRow(canvasElement, followingStoryZoneTitle);
    await expect(within(row).queryByRole('link')).toBeNull();
    await expect(within(row).getByText(m.following_reading_no_destination())).toBeVisible();
    const hidden = canvasElement.querySelector<HTMLElement>('[data-follow-target$="000085"]')!;
    await expect(within(hidden).getByText(m.following_reading_identity_unavailable())).toBeVisible();
    await expect(within(hidden).queryByRole('link')).toBeNull();
    await userEvent.click(
      within(row).getByRole('button', {
        name: m.following_reading_inspect_target({ title: followingStoryZoneTitle }),
      }),
    );
    const panel = await within(canvasElement).findByRole('dialog');
    await expect(within(panel).getByText(m.following_reading_no_destination())).toBeVisible();
    await expect(within(panel).queryByRole('link')).toBeNull();
  },
};

export const KeyboardMenuInteraction: Story = {
  name: 'Interaction: keyboard actions menu',
  tags: ['interaction'],
  play: libraryFollowingKeyboardInteraction,
  render: () => FollowingStory(),
};

export const UnfollowMenu: Story = {
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
      await within(context.canvasElement).findByRole('heading', { name: 'Following item 20' }),
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
    await libraryFollowingReady({ canvasElement });
    await inspectCommunity(canvasElement);
    const panel = await within(canvasElement).findByRole('dialog');
    await expect(await within(panel).findByText(m.following_reading_current_identity())).toBeVisible();
    await expect(within(panel).getByText(/A reading circle for long evenings/)).toBeVisible();
    await expect(within(panel).getByRole('link', { name: m.realm_membership_label() })).toHaveAttribute(
      'href',
      /\/realms\//,
    );
    const details = panel.querySelector('details')!;
    await expect(details.open).toBe(false);
    await expect(within(panel).getByText(followingStorySpaceId)).not.toBeVisible();
    await userEvent.click(within(panel).getByText(m.following_reading_details()));
    await expect(within(panel).getByText(followingStorySpaceId)).toBeVisible();
    await expect(within(panel).getByText(m.following_reading_remove_meaning())).toBeVisible();
    await userEvent.click(within(panel).getByText(m.following_reading_details()));
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
export const InspectionDenied: Story = {
  render: () => FollowingStory('reading-denied'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_denied())).toBeVisible();
  },
};
export const InspectionRetired: Story = {
  render: () => FollowingStory('reading-retired'),
  play: async ({ canvasElement }) => {
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_retired())).toBeVisible();
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

export const CollectionExposureWithdrawal: Story = {
  render: () => FollowingStory(),
  play: async ({ canvasElement }) => {
    await libraryFollowingReady({ canvasElement });
    const row = canvasElement.querySelector<HTMLElement>(`[data-follow-target="${followingStoryCollectionId}"]`)!;
    const inspect = within(row).getByRole('button', {
      name: m.following_reading_inspect_target({ title: 'Quiet novels for long evenings' }),
    });
    await userEvent.click(inspect);
    const panel = await within(canvasElement).findByRole('dialog');
    const oldOpen = within(panel).getByRole('link');
    currentPage!.queryClient.setQueriesData<{ subject: string; admitted: string[] }>(
      { predicate: ({ queryKey }) => queryKey[0] === 'exposure' && queryKey[1] === 'viewer' },
      (previous) =>
        previous ? { ...previous, admitted: previous.admitted.filter((value) => value !== 'collections') } : previous,
    );
    await expect(oldOpen.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(false);
    await waitFor(() => expect(panel).not.toBeInTheDocument());
    await expect(within(row).queryByRole('link')).toBeNull();
    await expect(within(row).getByText(m.following_reading_collection_withdrawn())).toBeVisible();
    await expect(
      within(row).getByRole('button', {
        name: m.library_follow_more_actions({ title: 'Quiet novels for long evenings' }),
      }),
    ).toBeEnabled();
    await userEvent.click(inspect);
    const current = await within(canvasElement).findByRole('dialog');
    await expect(within(current).getByText(m.following_reading_collection_withdrawn())).toBeVisible();
    await expect(within(current).queryByRole('link')).toBeNull();
  },
};

export const ReturnReadmission: Story = {
  render: () =>
    FollowingStory(
      'return-readmission',
      `${pagePaths['library-following']}?cursor=${encodeURIComponent(followingStoryCursor)}`,
    ),
  play: async ({ canvasElement }) => {
    await libraryFollowingReady({ canvasElement });
    await inspectCommunity(canvasElement);
    await within(canvasElement).findByText(m.following_reading_current_identity());
    const oldRow = canvasElement.querySelector<HTMLElement>(`[data-follow-target="${followingStorySpaceId}"]`)!;
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    await waitFor(() => expect(within(canvasElement).queryByRole('dialog')).toBeNull());
    await expect(within(oldRow).queryByRole('link')).toBeNull();
    await expect(within(canvasElement).getByText(m.following_reading_return_preparing())).toBeVisible();
    setLibraryFollowingStoryAdmission('denied');
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await expect(await within(canvasElement).findByText(m.library_my_ratings_denied())).toBeVisible();
    await expect(canvasElement.querySelector('[data-follow-target]')).toBeNull();
    setLibraryFollowingStoryAdmission('ready');
    await userEvent.click(within(canvasElement).getByRole('button', { name: m.following_reading_refresh() }));
    const currentRow = await followRow(canvasElement, 'A quiet space, open again');
    await expect(
      within(currentRow).getByRole('link', {
        name: m.following_reading_open({ title: 'A quiet space, open again' }),
      }),
    ).toHaveAttribute('href', /\/spaces\/quiet-novel-club$/);
    await expect(within(canvasElement).queryByRole('dialog')).toBeNull();
    await expect(
      libraryFollowingStoryReads().every((read) => read.cursor === followingStoryCursor && read.targetType === null),
    ).toBe(true);
    await inspectCommunity(canvasElement);
    await expect(await within(canvasElement).findByText(m.following_reading_current_identity())).toBeVisible();
  },
};

export const SameCursorRetry: Story = {
  render: () =>
    FollowingStory(
      'same-cursor-retry',
      `${pagePaths['library-following']}?kind=collection&cursor=${encodeURIComponent(followingStoryCursor)}`,
    ),
  play: async ({ canvasElement }) => {
    await followRow(canvasElement, 'Quiet novels for long evenings');
    const canvas = within(canvasElement);
    const refresh = canvas.getByRole('button', { name: m.following_reading_refresh() });
    await waitFor(() => expect(refresh).toBeEnabled());
    setLibraryFollowingStoryAdmission('unavailable');
    await userEvent.click(refresh);
    await expect(await canvas.findByText(m.library_follow_unavailable())).toBeVisible();
    const beforeRetry = libraryFollowingStoryReads().length;
    setLibraryFollowingStoryAdmission('ready');
    await userEvent.click(canvas.getByRole('button', { name: m.library_follow_retry() }));
    await waitFor(() => expect(canvas.queryByText(m.library_follow_unavailable())).toBeNull());
    const row = await followRow(canvasElement, 'Quiet novels for long evenings');
    await expect(within(row).getByRole('heading', { name: 'Quiet novels for long evenings' })).toBeVisible();
    await expect(libraryFollowingStoryReads().length).toBeGreaterThan(beforeRetry);
    await expect(
      libraryFollowingStoryReads().every(
        (read) => read.cursor === followingStoryCursor && read.targetType === 'collection',
      ),
    ).toBe(true);
    await expect(canvasElement.querySelectorAll('[data-follow-target]')).toHaveLength(1);
    await expect(canvas.getByRole('link', { name: m.library_collection_more() })).toHaveAttribute(
      'href',
      /kind=collection/,
    );
    await expect(canvas.getByRole('link', { name: m.library_collection_more() })).toHaveAttribute('href', /cursor=/);
  },
};
