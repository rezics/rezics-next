import { checkDocument, fromPlainText, type DocumentProfile, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { waitForFocus } from '../test/focus.ts';
import { dismissed } from '../test/waits.ts';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(profile: DocumentProfile = 'blocks', translated = false) {
  const initial = fromPlainText('Selected words', profile);
  const latest = { current: initial };
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        value={value}
        label="Post"
        compact
        labels={translated ? { bold: 'Strong', formatting: 'Selection tools' } : {}}
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
      />
    );
  }
  return { Demo, latest };
}
async function select(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  const range = document.createRange();
  range.selectNodeContents(canvas.getByRole('textbox', { name: 'Post' }));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return canvas;
}
function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content?.[0];
}
const meta = {
  title: 'Components/Editor Selection Menu',
  component: RichTextEditor,
  args: { value: fromPlainText('Selected words'), label: 'Post', onChange: () => undefined },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-background p-16 text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const marks = demo();
const blocks = demo();
const profiles = demo('text');
const keyboard = demo('text', true);

export const MarkCommands: Story = {
  render: () => <marks.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    for (const [name, mark] of [
      ['Bold', 'bold'],
      ['Italic', 'italic'],
      ['Strikethrough', 'strike'],
      ['Inline code', 'code'],
    ]) {
      const button = toolbar.getByRole('button', { name });
      await userEvent.click(button);
      await waitFor(() => {
        expect(button).toHaveAttribute('aria-pressed', 'true');
        expect(checked(marks.latest.current)?.content?.[0]?.marks?.some((value) => value.type === mark)).toBe(true);
      });
    }
    await userEvent.click(toolbar.getByRole('button', { name: 'Clear formatting' }));
    await waitFor(() => expect(checked(marks.latest.current)?.content?.[0]?.marks ?? []).toEqual([]));
    expect(checked(marks.latest.current)?.content?.[0]?.text).toBe('Selected words');
  },
};

export const BlockCommands: Story = {
  render: () => <blocks.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    const id = blocks.latest.current.doc.content?.[0]?.attrs?.id;
    for (const [name, type] of [
      ['Heading 2', 'heading'],
      ['Paragraph', 'paragraph'],
      ['Bullet list', 'bulletList'],
      ['Paragraph', 'paragraph'],
      ['Numbered list', 'orderedList'],
      ['Paragraph', 'paragraph'],
      ['Checklist', 'taskList'],
      ['Paragraph', 'paragraph'],
      ['Quote', 'blockquote'],
      ['Paragraph', 'paragraph'],
      ['Code block', 'codeBlock'],
    ]) {
      await userEvent.click(await canvas.findByRole('button', { name: 'Turn into' }));
      // The menu is a shadcn dropdown, which renders in a portal on the page rather than inside the story canvas.
      const menu = within(await screen.findByRole('menu', { name: 'Turn into' }));
      expect(menu.getAllByRole('menuitemradio', { checked: true })).toHaveLength(1);
      await userEvent.click(menu.getByRole('menuitemradio', { name }));
      // The next round must not find this menu while it leaves.
      await dismissed('menu');
      await waitFor(() => expect(checked(blocks.latest.current)?.type).toBe(type));
      if (type === 'heading' || type === 'paragraph' || type === 'codeBlock')
        expect(checked(blocks.latest.current)?.attrs?.id).toBe(id);
    }
    expect(checked(blocks.latest.current)?.content?.[0]?.text).toBe('Selected words');
  },
};

export const ProfileCommands: Story = {
  render: () => <profiles.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    expect(await canvas.findByRole('toolbar', { name: 'Format text' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Turn into' }));
    const menu = within(await screen.findByRole('menu', { name: 'Turn into' }));
    expect(menu.queryByRole('menuitemradio', { name: /table|image/i })).toBeNull();
    expect(canvas.queryByRole('button', { name: /table|image/i })).toBeNull();
    await userEvent.click(menu.getByRole('menuitemradio', { name: 'Heading 1' }));
    // The settled story must not hold a leaving menu, whose focus guards fail the accessibility check.
    await dismissed('menu');
    await waitFor(() => expect(checked(profiles.latest.current)?.type).toBe('heading'));
    expect(profiles.latest.current.profile).toBe('text');
  },
};

export const KeyboardReach: Story = {
  render: () => <keyboard.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Post' });
    expect(canvas.queryByRole('toolbar')).toBeNull();
    await select(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Selection tools' }));
    await userEvent.keyboard('{Alt>}{F10}{/Alt}');
    const bold = toolbar.getByRole('button', { name: 'Strong' });
    expect(bold).toHaveFocus();
    expect(toolbar.getAllByRole('button').filter((button) => button.tabIndex === 0)).toEqual([bold]);
    await userEvent.keyboard('{ArrowRight}');
    expect(toolbar.getByRole('button', { name: 'Italic' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    await waitFor(() => expect(checked(keyboard.latest.current)?.content?.[0]?.marks?.[0]?.type).toBe('bold'));
    // Applying a mark returns focus to the editor on a later frame; a shortcut sent before then is lost.
    await waitForFocus(textbox);
    await userEvent.keyboard('{Alt>}{F10}{/Alt}{End}{Enter}');
    const menu = within(await screen.findByRole('menu', { name: 'Turn into' }));
    await waitFor(() => expect(menu.getByRole('menuitemradio', { name: 'Paragraph' })).toHaveFocus());
    await userEvent.keyboard('{ArrowDown}');
    expect(menu.getByRole('menuitemradio', { name: 'Heading 1' })).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(textbox).toHaveFocus());
    expect(window.getSelection()?.toString()).toBe('Selected words');
    window.getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() => expect(canvas.queryByRole('toolbar')).toBeNull());
    expect(checkDocument(keyboard.latest.current)).toBe(true);
  },
};
