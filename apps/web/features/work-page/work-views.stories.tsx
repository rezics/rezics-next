import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import type { UiLocale } from '../../i18n/define.ts';
import { WorkCredits } from './credits.tsx';
import * as fixture from './fixtures.ts';
import { HistoryRegion } from './history.tsx';
import { messages } from './messages.ts';
import { ContentsRegion } from './contents.tsx';
import { DiscussionRegion } from './discussion.tsx';
import { ScopeBar } from './scope-bar.tsx';
import type { WorkTab } from './route.ts';
import type { WorkHeader } from './types.ts';
import { VersionsRegion } from './versions.tsx';
import { WorkFrame } from './work-frame.tsx';
import { WorkNotFound, WorkSkeleton, WorkUnavailable, WorkViewSkeleton } from './work-states.tsx';

/** A Work view inside the header and tabs, as the `/w/[ref]` layout renders it. */
function Framed({ work = fixture.work, locale = 'en', children }: {
  work?: WorkHeader; locale?: UiLocale; children: ReactNode;
}) {
  return <WorkFrame workRef={fixture.workRef} work={work} locale={locale} messages={messages[locale]}
    credits={<WorkCredits agentCredits={fixture.agentCredits} credits={fixture.credits} locale={locale}
      messages={messages[locale]} />}>
    {children}</WorkFrame>;
}

const at = (tab: WorkTab, search = '') => ({ route: { pathname: `/w/${fixture.workRef}/${tab}`, search } });

const meta = {
  title: 'Work page/Views',
  component: Framed,
  args: { children: null },
} satisfies Meta<typeof Framed>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Versions: Story = {
  parameters: at('versions'),
  render: () => <Framed><VersionsRegion versions={fixture.versions} workRef={fixture.workRef} query={{}}
    locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Versions' })).toHaveAttribute('aria-current', 'page');
    const region = canvas.getByRole('region', { name: 'Versions' });
    await expect(region).toHaveTextContent('4 on this page');
    const items = within(region).getAllByRole('listitem');
    await expect(items).toHaveLength(4);
    // Each version by its language, kind and date; the one shown by default is marked, and no IDs are listed.
    await expect(items[0]).toHaveTextContent('English');
    await expect(items[0]).toHaveTextContent('Shown by default');
    await expect(items[0]).toHaveTextContent('Text version · revised Sep 20, 2026');
    await expect(items[3]).toHaveTextContent('Fixed release · released Jun 1, 2026');
    await expect(region).not.toHaveTextContent(/Contribution|Revision/);
    await expect(within(region).getByRole('link', { name: 'Next page' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/versions?cursor=next-page-cursor`);
    const filters = within(region).getByRole('form', { name: 'Filter versions' });
    await expect(filters).toHaveAttribute('action', `/w/${fixture.workRef}/versions`);
    await expect(within(filters).getByRole('combobox', { name: 'Kind' })).toHaveTextContent('All kinds');
  },
};

export const VersionsFiltered: Story = {
  parameters: at('versions', 'kind=release&language=ja'),
  render: () => <Framed><VersionsRegion versions={fixture.noVersions} workRef={fixture.workRef}
    query={{ kind: 'release', language: 'ja' }} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No versions match these filters' })).toBeVisible();
    await expect(canvas.getByRole('combobox', { name: 'Kind' })).toHaveTextContent('Fixed release');
    await expect(canvas.getAllByRole('link', { name: 'Clear filters' })[0]).toHaveAttribute('href', `/en/w/${fixture.workRef}/versions`);
  },
};

export const VersionsMetadataOnly: Story = {
  parameters: at('versions'),
  render: () => <Framed work={fixture.metadataOnlyWork}><VersionsRegion versions={fixture.noVersions}
    workRef={fixture.workRef} query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'No published versions yet' })).toBeVisible();
  },
};

export const VersionsListChanged: Story = {
  parameters: at('versions', 'cursor=stale&language=en'),
  render: () => <Framed><VersionsRegion versions={{ ok: false, failure: 'moved' }} workRef={fixture.workRef}
    query={{ language: 'en', cursor: 'stale' }} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('This list changed while you were reading it.');
    await expect(within(alert).getByRole('link', { name: 'First page' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/versions?language=en`);
  },
};

export const VersionsUnavailable: Story = {
  parameters: at('versions'),
  render: () => <Framed><VersionsRegion versions={{ ok: false, failure: 'unavailable' }} workRef={fixture.workRef}
    query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('Versions unavailable');
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  },
};

export const VersionsChinesePhone: Story = {
  parameters: at('versions'),
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  render: () => <Framed work={fixture.cjkWork} locale="zh-Hans"><VersionsRegion versions={fixture.versions}
    workRef={fixture.workRef} query={{}} locale="zh-Hans" messages={messages['zh-Hans']} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: '版本' });
    await expect(within(region).getAllByRole('listitem')[1]).toHaveTextContent('日语');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const History: Story = {
  parameters: at('history'),
  render: () => <Framed><HistoryRegion history={fixture.history} workRef={fixture.workRef} kind={undefined}
    cursor={undefined} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'History' });
    await expect(region).toHaveTextContent('Newest first.');
    // What History leaves out is a help tip, not a sentence in the list's way.
    await expect(region).not.toHaveTextContent('Who made each change');
    await userEvent.click(within(region).getByRole('button', { name: 'About this history' }));
    // The popover fades in; wait for it rather than catch its first frame.
    const note = await screen.findByText(/Who made each change, and the text before it, are not shown/);
    await waitFor(() => expect(note).toBeVisible());
    await userEvent.keyboard('{Escape}');
    const items = within(region).getAllByRole('listitem');
    await expect(items.map(item => item.querySelector('p')?.textContent)).toEqual(['A reply was placed in a community',
      'Details edited', 'A version was published', 'Details edited']);
    // Dated by when each happened, not by a record sequence.
    await expect(items[0]).toHaveTextContent('Sep 27, 2026');
    await expect(items[1]).toHaveTextContent('Sep 20, 2026');
    await expect(region).not.toHaveTextContent(/Sequence/);
    await expect(within(region).getAllByRole('link', { name: 'See this edit' })[0])
      .toHaveAttribute('href', `/en/works/${fixture.work.revision.slice(-36)}`);
    const filter = within(region).getByRole('navigation', { name: 'Show activity' });
    await expect(within(filter).getByRole('link', { name: 'All' })).toHaveAttribute('aria-current', 'true');
    await expect(within(filter).getByRole('link', { name: 'Publications' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/history?kind=publication-decision`);
    await expect(within(region).getByRole('link', { name: 'Next page' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/history?cursor=history-next-cursor`);
  },
};

export const HistoryFilteredEmpty: Story = {
  parameters: at('history', 'kind=reply-placement'),
  render: () => <Framed><HistoryRegion history={fixture.noHistory} workRef={fixture.workRef} kind="reply-placement"
    cursor={undefined} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No activity of this kind yet' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Replies' })).toHaveAttribute('aria-current', 'true');
  },
};

export const HistoryUnavailable: Story = {
  parameters: at('history'),
  render: () => <Framed><HistoryRegion history={{ ok: false, failure: 'unavailable' }} workRef={fixture.workRef}
    kind={undefined} cursor={undefined} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('History unavailable');
  },
};

export const Contents: Story = {
  parameters: at('contents'),
  render: () => <Framed><ContentsRegion contents={fixture.contents} workRef={fixture.workRef} query={{}}
    locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('aria-current', 'page');
    const region = canvas.getByRole('region', { name: 'Contents' });
    await expect(region).toHaveTextContent('Contents in English');
    await expect(within(region).getByRole('link', { name: 'Start reading' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/read/b5c7d9e1-f3a5-4b7c-9d1e-000000000002`);
    await expect(within(region).getByRole('link', { name: /Part One: The Delta/ }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/contents?parent=b5c7d9e1-f3a5-4b7c-9d1e-000000000001`);
    // A chapter without a title is named by its place, never "Untitled chapter".
    await expect(within(region).getByRole('link', { name: /Chapter 3/ })).toBeVisible();
    await expect(region).not.toHaveTextContent('Untitled chapter');
    // A chapter with no publication in this language is listed, not linked.
    await expect(within(region).queryByRole('link', { name: /Neap Tide/ })).toBeNull();
    await expect(region).toHaveTextContent('Not available to read yet');
  },
};

export const ContentsPart: Story = {
  parameters: at('contents', 'parent=b5c7d9e1-f3a5-4b7c-9d1e-000000000001'),
  render: () => <Framed><ContentsRegion contents={fixture.contents} workRef={fixture.workRef}
    query={{ parent: 'b5c7d9e1-f3a5-4b7c-9d1e-000000000001' }} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Contents' });
    await expect(within(region).getByRole('link', { name: 'Back to all contents' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/contents`);
    await expect(within(region).queryByRole('link', { name: 'Start reading' })).toBeNull();
  },
};

export const ContentsEmpty: Story = {
  parameters: at('contents'),
  render: () => <Framed work={fixture.metadataOnlyWork}><ContentsRegion contents={fixture.noContents}
    workRef={fixture.workRef} query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Contents' });
    await expect(within(region).getByRole('heading', { name: 'Nothing to read yet' })).toBeVisible();
    // Readers are told what they can do, not how the record is modelled.
    await expect(region).not.toHaveTextContent(/Main Version|arranged/);
  },
};

const oneText = { title: fixture.oneTextWork.title, book: true, language: 'en' };

/** A book with no chapters is read as its one text: a one-entry Contents that opens it. */
export const ContentsOneText: Story = {
  parameters: at('contents'),
  render: () => <Framed work={fixture.oneTextWork}><ContentsRegion contents={fixture.noContents}
    workRef={fixture.workRef} query={{}} oneText={oneText} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Contents' });
    await expect(region).toHaveTextContent('This book is read as one text.');
    await expect(within(region).getByRole('link', { name: 'Start reading' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/read`);
    await expect(within(region).getAllByRole('listitem')).toHaveLength(1);
    await expect(within(region).getByRole('link', { name: /Pride and Prejudice.*The whole text/ }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/read`);
    await expect(region).not.toHaveTextContent(/Main Version|No contents/);
  },
};

export const ContentsOneTextChinesePhone: Story = {
  parameters: at('contents'),
  globals: { locale: 'zh-Hans', viewport: { value: 'phone' } },
  render: () => <Framed work={fixture.oneTextWork} locale="zh-Hans"><ContentsRegion contents={fixture.noContents}
    workRef={fixture.workRef} query={{}} oneText={oneText} locale="zh-Hans" messages={messages['zh-Hans']} /></Framed>,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: '目录' });
    await expect(region).toHaveTextContent('这本书是一篇完整的正文，不分章节。');
    await expect(within(region).getByRole('link', { name: '开始阅读' })).toBeVisible();
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const ContentsUnavailable: Story = {
  parameters: at('contents'),
  render: () => <Framed><ContentsRegion contents={{ ok: false, failure: 'unavailable' }} workRef={fixture.workRef}
    query={{}} locale="en" messages={messages.en} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('Contents unavailable');
  },
};

const discussionView = (scope = fixture.globalScope) => <>
  <ScopeBar workRef={fixture.workRef} scope={scope} realms={fixture.realms} tab="discussion" locale="en"
    messages={messages.en} />
  <DiscussionRegion discussion={scope.kind === 'mine' ? null : scope.kind === 'realm' ? fixture.noDiscussion
    : fixture.discussion} view={fixture.scopeView(scope)} cursor={undefined} locale="en" messages={messages.en} />
</>;

export const Discussion: Story = {
  parameters: at('discussion'),
  render: () => <Framed>{discussionView()}</Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('navigation', { name: 'Community' }))
      .toHaveTextContent('Showing reviewed replies from every public community.');
    const region = canvas.getByRole('region', { name: 'Discussion' });
    const replies = within(region).getAllByRole('article');
    await expect(replies).toHaveLength(3);
    await expect(within(replies[0]!).getByRole('link', { name: 'In Tidewater Readers' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/discussion?scope=realm&realm=${fixture.realms[0]!.id}`);
    await expect(replies[1]).toHaveTextContent('In 海洋文学研究会');
    await expect(replies[0]).toHaveTextContent('Sep 25, 2026');
    await expect(within(region).getByRole('link', { name: 'Next page' })).toBeVisible();
  },
};

export const DiscussionEmptyRealm: Story = {
  parameters: at('discussion', `scope=realm&realm=${fixture.realms[0]!.id}`),
  render: () => <Framed>{discussionView(fixture.realmScope)}</Framed>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'No reviewed replies in Tidewater Readers yet' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'See everyone' })).toHaveAttribute('href', `/en/w/${fixture.workRef}/discussion`);
  },
};

export const DiscussionMine: Story = {
  parameters: at('discussion', 'scope=mine'),
  globals: { theme: 'dark' },
  render: () => <Framed>{discussionView(fixture.mineScope)}</Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { name: 'Discussion isn’t personal' })).toBeVisible();
  },
};

export const NotFound: Story = {
  render: () => <WorkNotFound messages={messages.en} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1, name: 'Work not found' })).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => <WorkUnavailable messages={messages.en} />,
  async play({ canvasElement }) {
    const alert = within(canvasElement).getByRole('alert');
    await expect(alert).toHaveTextContent('This Work can’t be shown right now');
    await expect(within(alert).getByRole('button', { name: 'Retry' })).toBeEnabled();
  },
};

export const Loading: Story = {
  render: () => <WorkSkeleton label={messages.en.loading} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading the Work…' })).toBeInTheDocument();
  },
};

export const LoadingView: Story = {
  parameters: at('versions'),
  render: () => <Framed><WorkViewSkeleton label={messages.en.loadingRegion} /></Framed>,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
  },
};
