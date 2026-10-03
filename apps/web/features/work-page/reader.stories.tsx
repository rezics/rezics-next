import { chapterHref, textHref, workHref } from './route.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { ContentsRegion } from './contents.tsx';
import type { ContentsPage } from './types.ts';
import { ChapterNotFound, ChapterReader, ChapterUnavailable, TextNotFound, TextReader } from './reader.tsx';
import { defaultReaderSettings } from './reader-settings.ts';
import { ChapterSkeleton } from './work-states.tsx';

const chapterPath = chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000003');

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
      .toHaveAttribute('href', localizedPath(chapterHref(fixture.workRef, 'b5c7d9e1-f3a5-4b7c-9d1e-000000000002'), 'en'));
    await expect(within(chapters).getByRole('link', { name: 'Next chapter' })).toHaveAttribute('rel', 'next');
    await expect(canvas.getByRole('link', { name: 'The Cartographer of Tides' })).toHaveAttribute('href', localizedPath(workHref(fixture.workRef), 'en'));
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

/** On a phone, a tap on the text puts the site's header and tab bar away and a second brings them back. */
export const PhoneChromeTap: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const root = document.documentElement;
    await waitFor(() => expect(root.dataset.reading).toBe('shown'));
    const paragraph = canvasElement.querySelector<HTMLElement>('p[data-paragraph]')!;
    await userEvent.click(paragraph);
    await expect(root.dataset.reading).toBe('hidden');
    await userEvent.click(paragraph);
    await expect(root.dataset.reading).toBe('shown');
    // A tap on a control is the control's.
    await userEvent.click(paragraph);
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Reading settings' }));
    await expect(root.dataset.reading).toBe('shown');
  },
};

/** A Work with no chapters opens as its one text under the Work's title, with no chapters to step through. */
export const OneText: Story = {
  render: () => <TextReader workRef={fixture.workRef} work={fixture.oneTextWork} text={fixture.text} language={undefined}
    settings={defaultReaderSettings} actingSubject={null} locale="en" messages={messages.en} />,
  parameters: { route: { pathname: textHref(fixture.workRef) } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Pride and Prejudice' })).toBeVisible();
    const article = canvas.getByRole('article');
    await expect(article).toHaveAttribute('lang', 'en');
    // The body's first line only repeated the title.
    const paragraphs = canvasElement.querySelectorAll<HTMLElement>('p[data-paragraph]');
    await expect(paragraphs).toHaveLength(2);
    await expect(paragraphs[0]).toHaveTextContent(/^It is a truth universally acknowledged/);
    await expect(canvas.queryByRole('navigation', { name: 'Chapters' })).toBeNull();
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
    await expect(canvas.getByRole('button', { name: 'Reading settings' })).toBeVisible();
  },
};

export const OneTextNotFound: Story = {
  render: () => <TextNotFound workRef={fixture.workRef} messages={messages.en} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Nothing to read here' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
  },
};

export const NotFound: Story = {
  render: () => <ChapterNotFound workRef={fixture.workRef} messages={messages.en} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Chapter not found' })).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('href', localizedPath(workHref(fixture.workRef, 'contents'), 'en'));
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

// A Book in volumes, as 雨夜书店 is seeded: two volumes and its extras (番外).
const volumeIri = (n: number) => `https://rezics.com/id/b5c7d9e1-f3a5-4b7c-9d1e-0000000009${String(n).padStart(2, '0')}`;
const volumeOne = volumeIri(1), volumeTwo = volumeIri(2), extras = volumeIri(3);
type ContentsItem = ContentsPage['items'][number];
const baseContents = (fixture.contents as { ok: true; data: ContentsPage }).data;
const group = (occurrence: string, value: string, division: 'volume' | 'extras', number: number | null,
  childCount: number): ContentsItem => ({ occurrence, parent: baseContents.composition, role: 'group',
  label: { value, language: 'zh-Hans' }, division, number, childCount, target: null, selectedRevision: null,
  progress: null, availability: 'available' });
const inGroup = (parent: string, n: number, value: string, number: number | null): ContentsItem => ({
  ...baseContents.items[1]!, occurrence: `https://rezics.com/id/b5c7d9e1-f3a5-4b7c-9d1e-0000000008${String(n).padStart(2, '0')}`,
  parent, label: { value, language: 'zh-Hans' }, number });
const levels: Record<string, ContentsItem[]> = {
  [volumeOne]: [inGroup(volumeOne, 1, '第一章 雨夜', 1), inGroup(volumeOne, 2, '第二章 未寄出的信', 2)],
  [volumeTwo]: [inGroup(volumeTwo, 3, '第三章 最后一班车', 3)],
  [extras]: [inGroup(extras, 4, '番外 书店的猫', null)],
};
const volumes = { ok: true as const, data: { ...baseContents, language: 'zh-hans', nextCursor: null, items: [
  group(volumeOne, '第一卷 雨夜', 'volume', 1, 2), group(volumeTwo, '第二卷 雨停之后', 'volume', 2, 1),
  group(extras, '番外', 'extras', null, 1)] } };
const levelOf = (parent: string) => ({ ...baseContents, nextCursor: null, items: levels[parent] ?? [] });

/** Contents by volume: the current volume open with its chapters; another reads its chapters when it opens. */
export const ContentsByVolume: Story = {
  render: () => <ContentsRegion contents={volumes} workRef={fixture.workRef} query={{ language: 'zh-Hans' }}
    opened={{ occurrence: volumeTwo, page: levelOf(volumeTwo) }} locale="en" messages={messages.en}
    loadGroup={async parent => { await new Promise(resolve => setTimeout(resolve, 30)); return levelOf(parent); }} />,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: 'Contents' });
    const current = within(region).getByRole('button', { name: /第二卷 雨停之后/ });
    await expect(current).toHaveAttribute('aria-expanded', 'true');
    await expect(current).toHaveTextContent('1 chapter');
    await expect(within(region).getByRole('link', { name: /第三章 最后一班车/ }))
      .toHaveAttribute('href', expect.stringContaining('/read/b5c7d9e1-f3a5-4b7c-9d1e-000000000803'));
    const first = within(region).getByRole('button', { name: /第一卷 雨夜/ });
    await expect(first).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(first);
    await expect(await within(region).findByRole('link', { name: /第二章 未寄出的信/ })).toBeVisible();
    await expect(first).toHaveAttribute('aria-expanded', 'true');
    // Extras are named as such and never numbered as a volume.
    await expect(within(region).getByRole('button', { name: /番外/ })).toHaveTextContent('1 chapter');
    await expect(region).not.toHaveTextContent('Volume 3');
  },
};

/** The same contents in Chinese: volumes counted 第一卷, 第二卷; chapter counts as 共 N 章. */
export const ContentsByVolumeChinese: Story = {
  render: () => <ContentsRegion contents={{ ...volumes, data: { ...volumes.data, items: volumes.data.items.map(item =>
    ({ ...item, label: null })) } }} workRef={fixture.workRef} query={{ language: 'zh-Hans' }}
  opened={{ occurrence: volumeOne, page: levelOf(volumeOne) }} locale="zh-Hans" messages={messages['zh-Hans']}
  loadGroup={async parent => levelOf(parent)} />,
  async play({ canvasElement }) {
    const region = within(canvasElement).getByRole('region', { name: '目录' });
    await expect(within(region).getByRole('button', { name: /第一卷/ })).toHaveTextContent('共 2 章');
    await expect(within(region).getByRole('button', { name: /第二卷/ })).toHaveAttribute('aria-expanded', 'false');
    await expect(within(region).getByRole('button', { name: /番外/ })).toBeVisible();
  },
};

const inVolume = { ...fixture.chapter, parent: volumeTwo, number: 3, ordinal: 1,
  parentPath: [{ occurrence: volumeTwo, label: { value: 'After the Rain', language: 'en' }, division: 'volume' as const,
    number: 2 }] };

/** A chapter in a volume says where it stands: "Volume 2 · Chapter 3", the volume opening Contents at itself. */
export const InAVolume: Story = {
  args: { chapter: inVolume },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const header = canvas.getByRole('article').querySelector('header')!;
    await expect(header).toHaveTextContent('Volume 2·Chapter 3');
    await expect(within(header).getByRole('link', { name: 'Volume 2' })).toHaveAttribute('href',
      localizedPath(`${workHref(fixture.workRef, 'contents')}?open=b5c7d9e1-f3a5-4b7c-9d1e-000000000902`, 'en'));
    await expect(canvas.getByRole('heading', { level: 1 })).toHaveTextContent('The Surveyor’s Chain');
    await expect(canvas.getByRole('link', { name: 'Contents' })).toHaveAttribute('href',
      localizedPath(`${workHref(fixture.workRef, 'contents')}?open=b5c7d9e1-f3a5-4b7c-9d1e-000000000902`, 'en'));
  },
};

/** In Chinese the volume is 第二卷; a title that says 第三章 keeps its own number and gets no second one. */
export const InAVolumeChinese: Story = {
  args: { chapter: { ...fixture.headedChapter, parent: volumeTwo, number: 3, parentPath: inVolume.parentPath,
    label: { value: '第三章 最后一班车', language: 'zh-Hans' } }, locale: 'zh-Hans', messages: messages['zh-Hans'] },
  async play({ canvasElement }) {
    const header = within(canvasElement).getByRole('article').querySelector('header')!;
    await expect(within(header).getByRole('link', { name: '第二卷' })).toBeVisible();
    await expect(header).not.toHaveTextContent('第3章');
    await expect(within(canvasElement).getByRole('heading', { level: 1 })).toHaveTextContent('第三章 最后一班车');
  },
};

/** An extra (番外) is named by its group and never numbered. */
export const InExtras: Story = {
  args: { chapter: { ...fixture.cjkChapter, parent: extras, number: null, label: { value: '书店的猫', language: 'zh-Hans' },
    parentPath: [{ occurrence: extras, label: { value: '番外', language: 'zh-Hans' }, division: 'extras', number: null }] },
  locale: 'zh-Hans', messages: messages['zh-Hans'] },
  async play({ canvasElement }) {
    const header = within(canvasElement).getByRole('article').querySelector('header')!;
    await expect(within(header).getByRole('link', { name: '番外' })).toBeVisible();
    await expect(header).not.toHaveTextContent('章');
  },
};
