import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { setContinueStorySize } from '../kernel/fake/library-continue';
import { setLibraryEntriesStoryMode } from '../kernel/fake/library-entries-story';
import { setLibraryNavigationStoryState } from '../kernel/fake/library-pins';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageStory, libraryHeadingReady, pagePaths, pageReady } from './page';

const meta = {
  title: 'Pages/Library/Personal Library',
  parameters: {
    layout: 'fullscreen',
    admitted: ['selling', 'purchases', 'agent_verification', 'personal_library', 'reading_progress', 'collections'],
  },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function render(mode: Parameters<typeof setLibraryEntriesStoryMode>[0], continueSize = 6) {
  setLibraryEntriesStoryMode(mode);
  setContinueStorySize(continueSize);
  setLibraryNavigationStoryState({ pinCount: 0, builtins: 'none', collectionCount: 0 });
  return <PageStory visitor="Signed In" path={pagePaths['library-entries']} />;
}

export const Empty: Story = {
  render: () => render('empty', 0),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const main = within(within(context.canvasElement).getByRole('main'));
    await expect(await main.findByText(m.library_empty_title())).toBeVisible();
    await expect(main.getByRole('link', { name: m.library_browse() })).toHaveAttribute(
      'href',
      `/${getLocale()}/search`,
    );
  },
};

export const ContinuePresent: Story = {
  render: () => render('empty', 3),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByRole('heading', { name: m.home_continue_heading() })).toBeVisible();
    const progressLink = (await canvas.findAllByRole('link')).find((link) =>
      link.getAttribute('href')?.startsWith(`/${getLocale()}/library/progress`),
    );
    expect(progressLink).toBeDefined();
  },
};

export const ContinueAbsent: Story = {
  render: () => render('empty', 0),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    await within(context.canvasElement).findByText(m.library_empty_title());
    await expect(within(context.canvasElement).queryByRole('heading', { name: m.home_continue_heading() })).toBeNull();
  },
};

export const LongContent: Story = {
  render: () => render('long'),
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const main = within(context.canvasElement).getByRole('main');
    await expect(await within(main).findByRole('heading', { name: 'Library story entry 1' })).toBeVisible();
    await expect(await within(main).findByRole('heading', { name: 'Library story entry 12' })).toBeVisible();
  },
};

export const Unavailable: Story = {
  render: () => render('unavailable'),
  play: pageReady,
};

export const Error: Story = {
  render: () => render('error'),
  play: pageReady,
};

export const PinsUnavailable: Story = {
  render: () => {
    setLibraryEntriesStoryMode('recorded');
    setContinueStorySize(6);
    setLibraryNavigationStoryState({ pinCount: 0, failPins: true, builtins: 'none', collectionCount: 0 });
    return <PageStory visitor="Signed In" path={pagePaths['library-entries']} />;
  },
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const canvas = within(context.canvasElement);
    await expect(await canvas.findByText(m.library_pin_read_failed(), { exact: true })).toBeVisible();
    expect(canvas.getAllByText(m.library_pin_read_failed(), { exact: true })).toHaveLength(1);
    await expect(canvas.queryByRole('button', { name: m.library_pin_actions() })).toBeNull();
  },
};

export const EverythingAndLiked: Story = {
  render: () => {
    setLibraryEntriesStoryMode('recorded');
    setContinueStorySize(6);
    setLibraryNavigationStoryState({ pinCount: 0, builtins: 'everything-liked', collectionCount: 0 });
    return <PageStory visitor="Signed In" path={pagePaths['library-entries']} />;
  },
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    const main = within(context.canvasElement).getByRole('main');
    await expect(await within(main).findByRole('link', { name: m.library_dynamic_everything() })).toHaveAttribute(
      'href',
      `/${getLocale()}/collections/story-builtin-everything`,
    );
    await expect(within(main).getByRole('link', { name: m.library_dynamic_liked() })).toHaveAttribute(
      'href',
      `/${getLocale()}/collections/story-builtin-liked`,
    );
  },
};

export const PinnedCollections: Story = {
  render: () => {
    setLibraryEntriesStoryMode('recorded');
    setContinueStorySize(6);
    setLibraryNavigationStoryState({ pinCount: 3, builtins: 'everything', collectionCount: 0 });
    return <PageStory visitor="Signed In" path={pagePaths['library-entries']} />;
  },
  play: async (context) => {
    await libraryHeadingReady(context, m.library_heading);
    await expect(
      await within(context.canvasElement).findByText(m.library_pin_pinned_section(), { exact: true }),
    ).toBeVisible();
  },
};
