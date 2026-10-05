import type { Meta, StoryObj } from '@storybook/react-vite';
import { fromPlainText } from '@rezics/document';
import { expect, within } from 'storybook/test';
import { ChapterReader } from './reader.tsx';
import * as fixture from './fixtures.ts';
import { messages } from './messages.ts';
import { defaultReaderSettings } from './reader-settings.ts';
import { chapterHref } from './route.ts';
import { AuthorNote } from './author-note.tsx';
import type { UiLocale } from '../../i18n/define.ts';

const before = structuredClone(fromPlainText('Thank you for reading. This chapter returns to the harbour.'));
before.doc.content![0]!.content![0]!.marks = [{ type: 'italic' }];
const chapter = { ...fixture.chapter, content: { ...fixture.chapter.content,
  body: { ...fixture.chapter.content.body, notes: {
    before: { body: 'Thank you for reading. This chapter returns to the harbour.', document: before },
    after: { body: 'Next week: the mapmaker’s letter.\nUntil then, take care.' },
  } } } };
const meta = {
  title: 'Work page/Author notes', component: ChapterReader,
  args: { workRef: fixture.workRef, work: fixture.work, chapter, language: 'en',
    settings: defaultReaderSettings, progress: { ok: false, failure: 'sign-in' },
    actingSubject: null, locale: 'en', messages: messages.en },
  parameters: { route: { pathname: chapterHref(fixture.workRef, fixture.chapter.occurrence.slice(-36)) } },
} satisfies Meta<typeof ChapterReader>;
export default meta;
type Story = StoryObj<typeof meta>;

export const BeforeAndAfter: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const notes = canvas.getAllByRole('note', { name: 'Author’s note' });
    await expect(notes).toHaveLength(2);
    await expect(notes[0]).toHaveTextContent('Thank you for reading.');
    await expect(notes[0]!.querySelector('em')).toBeInTheDocument();
    await expect(notes[1]).toHaveTextContent('Next week: the mapmaker’s letter.');
    const text = canvasElement.querySelector('[data-reader-text]')!;
    await expect(Boolean(notes[0]!.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await expect(Boolean(text.compareDocumentPosition(notes[1]!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    await expect(notes.every(note => !note.querySelector('[data-paragraph], [data-reader-text], [id^="p-"]'))).toBe(true);
    await expect(canvasElement.querySelectorAll('[data-paragraph]')).toHaveLength(4);
  },
};

export const Absent: Story = {
  args: { chapter: fixture.chapter },
  async play({ canvasElement }) {
    await expect(within(canvasElement).queryByRole('note')).toBeNull();
    await expect(canvasElement.querySelector('[data-author-note]')).toBeNull();
  },
};

export const Empty: Story = {
  args: { chapter: { ...chapter, content: { ...chapter.content,
    body: { ...chapter.content.body, notes: { before: { body: '', document: fromPlainText('') }, after: { body: '  ' } } } } } },
  async play({ canvasElement }) {
    await expect(canvasElement.querySelector('[data-author-note]')).toBeNull();
  },
};

export const OnlyAfter: Story = {
  args: { chapter: { ...chapter, content: { ...chapter.content,
    body: { ...chapter.content.body, notes: { after: chapter.content.body.notes.after } } } } },
  async play({ canvasElement }) {
    await expect(within(canvasElement).getAllByRole('note')).toHaveLength(1);
    await expect(canvasElement.querySelector('[data-author-note="before"]')).toBeNull();
  },
};

export const TraditionalChinesePhone: Story = {
  args: { locale: 'zh-Hant', messages: messages['zh-Hant'] },
  globals: { locale: 'zh-Hant', viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const notes = within(canvasElement).getAllByRole('note', { name: '作者的話' });
    await expect(notes).toHaveLength(2);
    await expect(notes[0]).toHaveTextContent('Thank you for reading.');
    await expect(within(notes[0]!).getByRole('heading')).toHaveAttribute('lang', 'zh-Hant');
    await expect(within(canvasElement).getByRole('article')).toHaveAttribute('lang', 'en');
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(innerWidth);
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const EveryInterfaceLanguage: Story = {
  render: () => <div className="mx-auto grid max-w-2xl gap-4 p-4" lang="en">
    {Object.entries(messages).map(([locale, text]) => <AuthorNote key={locale}
      value={{ body: 'The same English note, without translation or fallback.' }} side="before"
      label={text.authorNote} locale={locale as UiLocale} />)}
  </div>,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole('note')).toHaveLength(8);
    for (const [locale, text] of Object.entries(messages)) {
      const note = canvas.getByRole('note', { name: text.authorNote });
      await expect(within(note).getByRole('heading')).toHaveAttribute('lang', locale);
      await expect(note).toHaveTextContent('The same English note, without translation or fallback.');
    }
  },
};
