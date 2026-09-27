import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Editor, EditorFooter, EditorTitle, textStats } from './editor.tsx';

const chapter = '雨从傍晚开始下。她把伞靠在门边，听见楼上有人在练琴。\n'
  + 'The rain started at dusk. She leaned the umbrella by the door and heard someone practising piano upstairs.\n'
  + '第3章的结尾，她终于打开了那封信。';

function Manuscript({ initial, lang }: { initial: string; lang: string }) {
  const [text, setText] = useState(initial);
  const stats = textStats(text, lang);
  return <div className="mx-auto grid max-w-[42rem] gap-4">
    <EditorTitle aria-label="Chapter title" lang={lang} defaultValue="第一章 雨夜" />
    <Editor aria-label="Chapter text" lang={lang} value={text} onChange={event => setText(event.target.value)}
      placeholder="Start writing…" />
    <EditorFooter><span>{stats.words} words</span><span>{stats.characters} characters</span></EditorFooter>
  </div>;
}

const meta = {
  title: 'Rezics UI/Editor',
  component: Editor,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: 'A calm, plain-text writing surface for chapters and long notes. It grows with the text, '
          + 'uses the reading serif at a 1.8 line height and spaces Han from Latin. Put an EditorTitle above it '
          + 'and counts and the save state in an EditorFooter below. Set `lang` and `dir` to the text\'s language.',
      },
    },
  },
  decorators: [Story => <div className="min-h-96 bg-background p-6 text-foreground"><Story /></div>],
  render: () => <Manuscript initial={chapter} lang="zh-Hans" />,
} satisfies Meta<typeof Editor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MixedScripts: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = canvas.getByRole('textbox', { name: 'Chapter text' });
    await expect(editor).toHaveAttribute('lang', 'zh-Hans');
    await userEvent.click(editor);
    await userEvent.type(editor, '{Control>}{End}{/Control}\n信里只有一句话。');
    await expect(editor).toHaveValue(`${chapter}\n信里只有一句话。`);
  },
};

export const Empty: Story = {
  render: () => <Manuscript initial="" lang="en" />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('textbox', { name: 'Chapter text' })).toHaveAttribute('placeholder', 'Start writing…');
    await expect(canvas.getByText('0 words')).toBeInTheDocument();
  },
};

export const RightToLeft: Story = {
  render: () => <div className="mx-auto max-w-[42rem]">
    <Editor aria-label="Chapter text" lang="ar" dir="rtl" defaultValue={'بدأ المطر عند الغروب.\nأسندت المظلة إلى الباب.'} />
  </div>,
};

export const Dark: Story = { globals: { theme: 'dark' } };

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** A long paragraph (or the placeholder) wraps inside a grid or flex column instead of widening it. */
export const PhoneLongParagraph: Story = {
  globals: { viewport: { value: 'phone' } },
  render: () => <div className="grid">
    <Editor aria-label="Chapter text" lang="en" placeholder="Start writing. Each line is a paragraph, however long it grows."
      defaultValue={'It was the best of times, it was the worst of times, '.repeat(12)} />
  </div>,
  async play() {
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};

/** Counting rules: Han and kana count per character; other scripts, Korean included, per word. */
export const Counting: Story = {
  render: () => <Manuscript initial="" lang="en" />,
  async play() {
    await expect(textStats('第3章 The rain', 'zh-Hans')).toEqual({ words: 5, characters: 12 });
    await expect(textStats('雨夜\n雨', 'zh-Hans')).toEqual({ words: 3, characters: 3 });
    await expect(textStats('Hello, world.\nAgain', 'en')).toEqual({ words: 3, characters: 18 });
    await expect(textStats('안녕하세요 세계', 'ko')).toEqual({ words: 2, characters: 8 });
  },
};
