import { checkDocument, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(initial: DocumentSnapshot, props: Partial<Parameters<typeof RichTextEditor>[0]> = {}) {
  const latest = { current: initial };
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        compact
        value={value}
        label="投稿"
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
        {...props}
      />
    );
  }
  return { Demo, latest };
}

const chinese = {
  formatting: '文字格式',
  bold: '粗體',
  turnInto: '轉換為',
  insertBlock: '插入區塊',
  heading1: '標題一',
  slashEmpty: '沒有符合的區塊',
};

const meta = {
  title: 'Components/Editor Text',
  component: RichTextEditor,
  args: { value: fromPlainText(''), label: '投稿', onChange: () => undefined },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-background p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

const cjk = demo(fromPlainText('黑暗森林法則'), { lang: 'zh-Hant', labels: chinese });
const slash = demo(fromPlainText(''), { lang: 'zh-Hant', labels: chinese });
const long = demo(fromPlainText('Supercalifragilisticexpialidocious_'.repeat(8)), {
  lang: 'en',
  label: 'A post',
});
const empty = demo(fromPlainText(''), { placeholder: '寫點什麼吧', lang: 'zh-Hant', labels: chinese });

export const CjkSelection: Story = {
  render: () => <cjk.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: '投稿' });
    await userEvent.click(textbox);
    const range = document.createRange();
    range.selectNodeContents(textbox);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const toolbar = within(await canvas.findByRole('toolbar', { name: '文字格式' }));
    await userEvent.click(toolbar.getByRole('button', { name: '粗體' }));
    await waitFor(() => {
      expect(checkDocument(cjk.latest.current)).toBe(true);
      expect(cjk.latest.current.doc.content?.[0]?.content?.[0]?.marks?.[0]?.type).toBe('bold');
    });
    expect(textbox).toHaveAttribute('lang', 'zh-Hant');
    expect(toolbar.getByRole('button', { name: '轉換為' })).toBeVisible();
  },
};

export const CjkSlashMenu: Story = {
  render: () => <slash.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: '投稿' });
    await userEvent.click(textbox);
    await userEvent.keyboard('/標題');
    const menu = within(await canvas.findByRole('listbox', { name: '插入區塊' }));
    await waitFor(() => expect(menu.getAllByRole('option').map((option) => option.textContent)).toEqual(['標題一']));
    await userEvent.keyboard('{Backspace}{Backspace}沒有');
    expect(await menu.findByText('沒有符合的區塊')).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('listbox')).toBeNull());
    expect(textbox).toHaveFocus();
  },
};

export const LongUnbrokenText: Story = {
  render: () => (
    <div className="w-72">
      <long.Demo />
    </div>
  ),
  async play({ canvasElement }) {
    const textbox = within(canvasElement).getByRole('textbox', { name: 'A post' });
    expect(textbox.scrollWidth).toBeLessThanOrEqual(textbox.clientWidth);
    await userEvent.type(textbox, '!');
    await waitFor(() => expect(checkDocument(long.latest.current)).toBe(true));
    expect(textbox.scrollWidth).toBeLessThanOrEqual(textbox.clientWidth);
  },
};

export const EmptyDocument: Story = {
  render: () => <empty.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: '投稿' });
    expect(textbox.querySelector('[data-placeholder]')).toHaveAttribute('data-placeholder', '寫點什麼吧');
    expect(canvas.queryByRole('toolbar')).toBeNull();
    expect(canvas.queryByRole('listbox')).toBeNull();
    expect(canvas.queryByRole('button')).toBeNull();
  },
};
