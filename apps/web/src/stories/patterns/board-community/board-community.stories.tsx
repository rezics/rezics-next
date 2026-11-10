import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, within } from 'storybook/test';
import { BoardCommunity, BoardCommunityStatus } from '../../../threads/board-community';
import { m } from '../../../paraglide/messages.js';
import threads from '../../../kernel/recorded/board-threads.json';
import realmBoard from '../../../kernel/recorded/board-realm.json';
import realm from '../../../kernel/recorded/board-realm-realm.json';
import { ContinueHot as continuation } from '../../board-continuation.stories';
import { MultipleBoards as aboutFamily } from '../../board-about-family.stories';
import { getLocale } from '../../../paraglide/runtime.js';
import { PageStory, pagePaths } from '../../page';
import { CommunityFixture } from './board-community-fixtures';

const meta = {
  title: 'Community/Community Feed',
  id: 'patterns-community-community-feed',
  component: BoardCommunity,
  parameters: {
    layout: 'fullscreen',
    viewport: {
      options: {
        phone390: { name: 'Phone 390', styles: { width: '390px', height: '844px' } },
        desktop1280: { name: 'Desktop 1280', styles: { width: '1280px', height: '900px' } },
      },
    },
  },
} satisfies Meta<typeof BoardCommunity>;
export default meta;
type Story = StoryObj;
const renderFeed = () => <CommunityFixture />;
const renderBoard = () => <PageStory visitor="Signed Out" path={pagePaths.board} />;

export const Feed: Story = {
  render: renderFeed,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1 });
    const firstThread = threads.threads[0]!;
    const title = firstThread.title!;
    await expect(await view.findByRole('heading', { level: 3, name: title })).toBeVisible();
    await expect(view.getByRole('link', { name: title })).toHaveAttribute(
      'href',
      expect.stringContaining(`/threads/${firstThread.id}/`),
    );
    await expect(view.getByText('Flight notes Watch the baobabs')).toBeVisible();
    await expect(view.queryByRole('button', { name: m.realm_join() })).toBeNull();
  },
};

export const Realm: Story = {
  render: () => <PageStory visitor="Signed In" path={`/boards/${realmBoard.board.id}`} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('heading', { level: 1, name: realmBoard.board.title });
    await view.findByRole('region', { name: m.realm_membership_label() });
  },
};

export const Overflow: Story = {
  render: renderFeed,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await view.findByRole('link', { name: threads.threads[0]!.title });
    const trigger = view.getAllByRole('button', { name: m.thread_content_more_actions() })[0]!;
    await userEvent.click(trigger);
    const sheet = window.matchMedia('(max-width: 767px)').matches || window.matchMedia('(pointer: coarse)').matches;
    await expect(
      await screen.findByRole(sheet ? 'button' : 'menuitem', { name: m.thread_content_copy_link() }),
    ).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await expect(trigger).toHaveFocus();
  },
};

export const Sort: Story = {
  render: renderBoard,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    const nav = await view.findByRole('navigation', { name: m.board_sort_label() });
    await userEvent.click(within(nav).getByRole('link', { name: m.board_sort_new() }));
    await expect(await within(nav).findByRole('link', { name: m.board_sort_new(), current: 'page' })).toBeVisible();
    await userEvent.click(within(nav).getByRole('link', { name: m.board_sort_hot() }));
    await expect(await within(nav).findByRole('link', { name: m.board_sort_hot(), current: 'page' })).toBeVisible();
  },
};

export const OpenThread: Story = {
  render: renderBoard,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('link', { name: threads.threads[0]!.title }));
    await expect(await view.findByRole('heading', { level: 1, name: threads.threads[0]!.title })).toBeVisible();
    await expect(await view.findByText('Watch the baobabs')).toBeVisible();
  },
};

export const StartThread: Story = {
  render: () => <PageStory visitor="Signed In" path={pagePaths.board} />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await userEvent.click(await view.findByRole('link', { name: m.board_start_thread() }));
    await expect(await view.findByRole('heading', { level: 1, name: m.thread_new_heading() })).toBeVisible();
    await expect(await view.findByRole('textbox', { name: m.thread_title_label() })).toBeVisible();
  },
};

export const ContinueHot: Story = { ...continuation };
export const AboutFamily: Story = { ...aboutFamily };
export const Empty: Story = { render: () => <CommunityFixture state="empty" /> };
export const Protected: Story = { render: () => <CommunityFixture state="protected" /> };
export const SourceUnavailable: Story = { render: () => <CommunityFixture state="source-unavailable" /> };
export const Loading: Story = { render: () => <BoardCommunityStatus state="loading" /> };
export const Error: Story = { render: () => <BoardCommunityStatus state="error" /> };
export const Closed: Story = { render: () => <BoardCommunityStatus state="closed" /> };

export const Presentation: Story = {
  render: () => <CommunityFixture state="presentation" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_members({ count: 128 }))).toBeVisible();
    await expect(view.getByText('Discuss the book with care. Mark spoilers before sharing them.')).toBeVisible();
    await expect(view.getByRole('link', { name: m.board_community_rules_revision() })).toHaveAttribute(
      'href',
      expect.stringContaining('/revisions/'),
    );
    await expect(view.queryByText(m.board_community_members_unknown())).toBeNull();
    const about = within(view.getByRole('complementary', { name: m.board_community_about() }));
    const heading = about.getByRole('heading', { level: 2, name: m.board_community_about() });
    await expect(heading.closest('aside')).toHaveAttribute('aria-labelledby', heading.id);
    const rules = about.getByRole('region', { name: m.board_community_rules() });
    await expect(rules).toHaveAttribute(
      'aria-labelledby',
      within(rules).getByRole('heading', { level: 3, name: m.board_community_rules() }).id,
    );
    await expect(about.getByRole('link', { name: realm.realm.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/realms/${realm.realm.realmId}`,
    );
    await expect(about.getByRole('link', { name: m.board_community_rules_revision() })).toHaveAttribute(
      'href',
      `/${getLocale()}/posts/01a17ce8-2850-71fd-a965-456700000001/revisions/01a17ce8-2850-71fe-874d-456700000002`,
    );
    await expect(about.getByText('MIT')).toBeVisible();
    await expect(about.getByText(realm.realm.summary)).toBeVisible();
  },
};

export const NoOptionals: Story = {
  render: () => <CommunityFixture state="no-optionals" />,
  play: async ({ canvasElement }) => {
    const view = within(canvasElement);
    await expect(await view.findByText(m.board_community_members_unknown())).toBeVisible();
    await expect(view.getByText(m.board_community_rules_none())).toBeVisible();
    await expect(view.queryByRole('link', { name: m.board_community_rules_revision() })).toBeNull();
    await expect(view.queryByText(m.board_community_global())).toBeNull();
    await expect(view.queryByText(realm.realm.summary)).toBeNull();
    const aside = view.getByRole('complementary', { name: m.board_community_about() });
    const about = within(aside);
    await expect(aside).toHaveAttribute(
      'aria-labelledby',
      about.getByRole('heading', { level: 2, name: m.board_community_about() }).id,
    );
    await expect(about.getByRole('link', { name: realm.realm.title })).toHaveAttribute(
      'href',
      `/${getLocale()}/realms/${realm.realm.realmId}`,
    );
    await expect(aside.querySelector('[data-slot="document-body"]')).toBeNull();
  },
};
