import {
  checkDocument,
  fromMarkdown,
  fromPlainText,
  serializeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../test/focus.ts';
import { RichTextEditor } from './rich-text-editor.tsx';

const cjkDominant = [
  '《三體》讀後。劉慈欣（Liu Cixin）把宇宙寫成一座黑暗森林：每個文明都是帶槍的獵人，連呼吸都必須小心。The Dark Forest 不是比喻，是生存法則。',
  '第一部從北京的「紅岸基地」寫到葉文潔的選擇；第二部把羅輯推上面壁者的位置，ISBN 978-7-5366-9293-0 仍是最常被引用的簡體初版。句子裡夾著破折號——以及省略號……還有書名號與引號：「不要回答！」',
  '程心在《死神永生》裡按下那枚按鈕時，拉丁字母的 Singer 文明只留下一句：cleanup. 中文標點與英文句點並存在同一段，校對時最容易被拆開。',
].join('\n');

const latinDominant = [
  'Reading notes on The Three-Body Problem (《三體》). Liu Cixin describes the universe as a dark forest: every civilization is a hunter with a rifle. The warning 不要回答! sits next to ISBN 978-7-5366-9293-0.',
  'The second volume, The Dark Forest (黑暗森林), turns Luo Ji into a Wallfacer. Punctuation is mixed on purpose: em dashes—ellipsis… and book-title marks around 《死神永生》.',
].join('\n');

const cjkBlocks = `## 《三體》筆記

劉慈欣（Liu Cixin）把宇宙寫成一座黑暗森林。The Dark Forest 不是比喻，是生存法則。

> 「不要回答！」葉文潔在紅岸聽到這句警告。

- 簡體初版 ISBN 978-7-5366-9293-0
- 英譯 The Three-Body Problem（Ken Liu）
`;

function collectText(node: DocumentNode | undefined): string {
  if (!node) return '';
  return `${node.text ?? ''}${(node.content ?? []).map(collectText).join('')}`;
}

function createDemo(initial: DocumentSnapshot, label: string, lang: string) {
  const latest = { current: initial };

  function Demo() {
    const [value, setValue] = useState(initial);
    const valid = checkDocument(value);

    return (
      <div className="space-y-3">
        <RichTextEditor
          value={value}
          onChange={(next) => {
            latest.current = next;
            setValue(next);
          }}
          label={label}
          lang={lang}
        />
        <p role="status" aria-label="Snapshot validity">
          {valid ? 'Valid snapshot' : 'Invalid snapshot'}
        </p>
        <output aria-label="Serialized document" className="block font-mono text-xs break-all">
          {serializeDocument(value)}
        </output>
      </div>
    );
  }

  return { Demo, initial, latest, label };
}

async function visibleSnapshot(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  const serialized = serializeDocument(snapshot);
  expect(screen.getByRole('status', { name: 'Snapshot validity' })).toHaveTextContent('Valid snapshot');
  await waitFor(() => expect(screen.getByLabelText('Serialized document')).toHaveTextContent(serialized));
  return serialized;
}

function selectText(root: HTMLElement, needle: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const index = node.data.indexOf(needle);
    if (index >= 0) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      return;
    }
    node = walker.nextNode() as Text | null;
  }
  throw new Error(`Missing ${needle}`);
}

const meta = {
  title: 'Components/Editor Mixed Script',
  component: RichTextEditor,
  args: {
    value: fromPlainText(''),
    onChange: () => undefined,
    label: 'Reading notes',
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'Controlled mixed-script editing on the shared Prose surface. Storybook locale is the shell; the editor lang is the document language. Paste here is already-composed text, not a native IME session.',
      },
    },
  },
  decorators: [
    (Story) => (
      <div className="min-h-56 bg-background p-4 font-sans text-foreground sm:p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

const cjkText = createDemo(fromPlainText(cjkDominant, 'text'), 'Reading notes', 'zh-Hant');
const cjkBlock = createDemo(fromMarkdown(cjkBlocks, 'blocks'), 'Edition notes', 'zh-Hant');
const latin = createDemo(fromPlainText(latinDominant, 'text'), 'Reading notes', 'en');
const replace = createDemo(fromPlainText(cjkDominant, 'text'), 'Reading notes', 'zh-Hant');

export const CjkDominantText: Story = {
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390' } },
  render: () => <cjkText.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Reading notes' });
    expect(document.documentElement.lang).toBe('en');
    expect(textbox).toHaveAttribute('lang', 'zh-Hant');
    expect(textbox).toHaveTextContent('《三體》');
    expect(textbox).toHaveTextContent('The Dark Forest');
    expect(textbox).toHaveTextContent('ISBN 978-7-5366-9293-0');
    const snapshot = cjkText.latest.current;
    expect(snapshot.profile).toBe('text');
    expect(snapshot.doc.content?.every((block) => block.type === 'paragraph')).toBe(true);
    await visibleSnapshot(snapshot);
  },
};

export const CjkDominantBlocks: Story = {
  globals: { locale: 'en', theme: 'light', viewport: { value: 'desktop1280' } },
  render: () => <cjkBlock.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Edition notes' });
    expect(document.documentElement.lang).toBe('en');
    expect(textbox).toHaveAttribute('lang', 'zh-Hant');
    const snapshot = cjkBlock.latest.current;
    expect(snapshot.profile).toBe('blocks');
    expect(snapshot.doc.content?.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'blockquote',
      'bulletList',
    ]);
    expect(collectText(snapshot.doc)).toContain('《三體》筆記');
    expect(collectText(snapshot.doc)).toContain('不要回答');
    expect(collectText(snapshot.doc)).toContain('Ken Liu');
    await visibleSnapshot(snapshot);
  },
};

export const LatinDominant: Story = {
  globals: { locale: 'zh-Hant', theme: 'light', viewport: { value: 'desktop1280' } },
  render: () => <latin.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Reading notes' });
    expect(document.documentElement.lang).toBe('zh-Hant');
    expect(textbox).toHaveAttribute('lang', 'en');
    expect(textbox).toHaveTextContent('The Three-Body Problem');
    expect(textbox).toHaveTextContent('《三體》');
    expect(latin.latest.current.profile).toBe('text');
    await visibleSnapshot(latin.latest.current);
  },
};

export const ReplaceMixedSelection: Story = {
  globals: { locale: 'en', theme: 'light', viewport: { value: 'phone390' } },
  render: () => <replace.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Reading notes' });
    await userEvent.click(textbox);
    await waitForFocus(textbox);
    selectText(textbox, 'The Dark Forest');
    await userEvent.paste('黑暗森林法則');
    await waitFor(() => {
      const snapshot = replace.latest.current;
      const text = collectText(snapshot.doc);
      expect(checkDocument(snapshot)).toBe(true);
      expect(text).toContain('黑暗森林法則');
      expect(text).not.toContain('The Dark Forest');
      expect(text).toContain('不是比喻，是生存法則。');
      expect(text).toContain('「不要回答！」');
      expect(text).toContain('Singer');
    });
    expect(textbox).toHaveTextContent('黑暗森林法則');
    expect(textbox).toHaveTextContent('不是比喻，是生存法則。');
    expect(textbox).toHaveAttribute('lang', 'zh-Hant');
    await visibleSnapshot(replace.latest.current);
  },
};
