import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { ChapterNotFound, ChapterReader, ChapterUnavailable } from './reader.tsx';
import { defaultReaderSettings } from './reader-settings.ts';
import { ChapterSkeleton } from './work-states.tsx';

const chapterPath = `/w/${fixture.workRef}/read/b5c7d9e1-f3a5-4b7c-9d1e-000000000003`;

const meta = {
  title: 'Work page/Reader',
  component: ChapterReader,
  args: { workRef: fixture.workRef, work: fixture.work, chapter: fixture.chapter, language: undefined,
    settings: defaultReaderSettings, progress: fixture.progress,
    actingSubject: 'https://rezics.com/id/aac18373-3fe4-46e0-9da8-3b2864fbad2b', locale: 'en', messages: messages.en },
  parameters: { route: { pathname: chapterPath } },
} satisfies Meta<typeof ChapterReader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Reading: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const article = canvas.getByRole('article');
    await expect(article).toHaveAttribute('lang', 'en');
    await expect(within(article).getAllByText(/./, { selector: 'p[data-paragraph]' })).toHaveLength(4);
    await expect(canvas.getByRole('link', { name: 'Continue where you left off' })).toHaveAttribute('href', '#p-2');
    const chapters = canvas.getByRole('navigation', { name: 'Chapters' });
    await expect(within(chapters).getByRole('link', { name: 'Previous chapter' }))
      .toHaveAttribute('href', `/en/w/${fixture.workRef}/read/b5c7d9e1-f3a5-4b7c-9d1e-000000000002`);
    await expect(within(chapters).getByRole('link', { name: 'Next chapter' })).toHaveAttribute('rel', 'next');
    await expect(canvas.getByRole('link', { name: 'The Cartographer of Tides' })).toHaveAttribute('href', `/en/w/${fixture.workRef}`);
    await expect(canvas.getByRole('button', { name: 'Mark chapter as read' })).toBeEnabled();
  },
};

export const Settings: Story = {
  args: { actingSubject: null },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Reading settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reading settings' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Larger text' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Wide' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Sans serif' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Indent paragraphs' }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Strict' }));
    const surface = canvasElement.querySelector<HTMLElement>('[data-face]')!;
    await expect(surface).toHaveAttribute('data-face', 'sans');
    await expect(surface).toHaveAttribute('data-indent', 'true');
    await expect(surface).toHaveAttribute('data-cjk-punctuation', 'strict');
    await expect(surface.style.getPropertyValue('--reader-size')).toBe('19px');
    await expect(surface.style.getPropertyValue('--reader-width')).toBe('50rem');
    await expect(within(dialog).getByRole('button', { name: 'Wide' })).toHaveAttribute('aria-pressed', 'true');
    await expect(document.cookie).toContain('rezics_reader=');
  },
};

export const ProgressSaveFails: Story = {
  async play({ canvasElement }) {
    // Storybook has no Main behind the BFF, so the write fails and the reader is told.
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Mark chapter as read' }));
    await waitFor(() => expect(within(canvasElement).getByRole('status')).toHaveTextContent('Progress couldn’t be saved.'));
  },
};

export const ChapterRead: Story = {
  args: { progress: fixture.completedProgress, chapter: fixture.lastChapter },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Chapter read')).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Mark as unread' })).toBeVisible();
    await expect(canvas.queryByRole('link', { name: 'Continue where you left off' })).toBeNull();
    await expect(canvas.queryByRole('link', { name: 'Next chapter' })).toBeNull();
    await expect(canvas.getByTitle('This is the last chapter')).toHaveAttribute('aria-disabled', 'true');
  },
};

export const SignedOut: Story = {
  args: { progress: { ok: false, failure: 'sign-in' }, actingSubject: null },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('link', { name: 'Sign in' }))
      .toHaveAttribute('href', `/auth/start?next=${encodeURIComponent(`/en${chapterPath}`)}`);
  },
};

export const ProgressNotKept: Story = {
  args: { progress: { ok: false, failure: 'missing' } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('Progress isn’t kept for this Work yet.')).toBeVisible();
  },
};

export const UnsupportedFormat: Story = {
  args: { chapter: { ...fixture.chapter, content: { ...fixture.chapter.content, body: { blocks: [] } } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByText('This chapter uses a format the reader can’t show yet.')).toBeVisible();
  },
};

const lineHeight = (paragraph: HTMLElement) => {
  const style = getComputedStyle(paragraph);
  return Number.parseFloat(style.lineHeight) / Number.parseFloat(style.fontSize);
};

export const LatinLineHeight: Story = {
  async play({ canvasElement }) {
    const paragraph = canvasElement.querySelector<HTMLElement>('p[data-paragraph]')!;
    await expect(lineHeight(paragraph)).toBeCloseTo(1.7, 1);
    // On a phone the site's header and tab bar step aside while the reader scrolls down.
    await expect(document.documentElement.dataset.reading).toBe('shown');
  },
};

export const UntitledChapter: Story = {
  args: { chapter: { ...fixture.chapter, label: null, ordinal: 2 } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('heading', { level: 1 })).toHaveTextContent('Chapter 2');
    await expect(within(canvasElement).queryByText('Untitled chapter')).toBeNull();
  },
};

export const TitleNotRepeated: Story = {
  args: { chapter: fixture.headedChapter, work: fixture.cjkWork, locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('第一章 雨夜');
    // The body's first line only repeated the title, so it is set once, as the heading.
    const paragraphs = canvasElement.querySelectorAll<HTMLElement>('p[data-paragraph]');
    await expect(paragraphs).toHaveLength(2);
    await expect(paragraphs[0]).toHaveTextContent('雨停在书店打烊前。');
  },
};

export const ChinesePhoneDark: Story = {
  args: { chapter: fixture.cjkChapter, work: fixture.cjkWork, locale: 'zh-Hans', messages: messages['zh-Hans'] },
  globals: { locale: 'zh-Hans', theme: 'dark', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('article')).toHaveAttribute('lang', 'zh-Hans');
    // Chinese and Japanese, set solid, read at 1.8.
    await expect(lineHeight(canvasElement.querySelector<HTMLElement>('p[data-paragraph]')!)).toBeCloseTo(1.8, 1);
    await expect(canvas.getByRole('link', { name: '下一章' })).toBeVisible();
    await expect(canvas.getByTitle('这是第一章')).toHaveAttribute('aria-disabled', 'true');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const NotFound: Story = {
  render: () => <ChapterNotFound workRef={fixture.workRef} messages={messages.en} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Chapter not found' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('href', `/en/w/${fixture.workRef}/contents`);
  },
};

export const Unavailable: Story = {
  render: () => <ChapterUnavailable workRef={fixture.workRef} messages={messages.en} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('alert')).toHaveTextContent('This chapter can’t be shown right now');
  },
};

export const Loading: Story = {
  render: () => <ChapterSkeleton label={messages.en.loading} />,
  async play({ canvasElement }) {
    await expect(within(canvasElement).getByRole('status', { name: 'Loading the Work…' })).toBeInTheDocument();
  },
};
