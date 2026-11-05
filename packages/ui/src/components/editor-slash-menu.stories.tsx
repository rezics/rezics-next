import { checkDocument, fromPlainText, type DocumentProfile, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(
  profile: DocumentProfile = 'blocks',
  options: { upload?: boolean; labels?: Partial<RichTextEditorLabels> } = {},
) {
  const initial = fromPlainText('', profile);
  const latest = { current: initial };
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        value={value}
        label="Post"
        compact
        labels={options.labels ?? {}}
        upload={options.upload ? async () => ({ src: 'media-slash' }) : undefined}
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
      />
    );
  }
  return { Demo, latest };
}

function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content?.[0];
}

async function openMenu(canvasElement: HTMLElement, keys: string) {
  const canvas = within(canvasElement);
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  await userEvent.keyboard(keys);
  const menu = within(await canvas.findByRole('listbox', { name: 'Insert block' }));
  return { canvas, textbox, menu };
}

const meta = {
  title: 'Components/Editor Slash Menu',
  component: RichTextEditor,
  args: { value: fromPlainText(''), label: 'Post', onChange: () => undefined },
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

const filtered = demo('blocks', { upload: true, labels: { heading2: 'Zweitschrift' } });
const keyboard = demo('blocks');
const escaped = demo('text');
const literal = demo('text');
const profiles = demo('text', { upload: true });

export const FilterCommands: Story = {
  render: () => <filtered.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox, menu } = await openMenu(canvasElement, '/');
    expect(menu.getByRole('option', { name: 'Heading 1' })).toBeVisible();
    expect(menu.getByRole('option', { name: 'Zweitschrift' })).toBeVisible();
    expect(menu.getByRole('option', { name: 'Image' })).toBeVisible();
    expect(menu.getByRole('option', { name: 'Table' })).toBeVisible();
    await userEvent.keyboard('zwei');
    await waitFor(() =>
      expect(menu.getAllByRole('option').map((option) => option.textContent)).toEqual(['Zweitschrift']),
    );
    await userEvent.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}todo');
    await waitFor(() => expect(menu.getAllByRole('option').map((option) => option.textContent)).toEqual(['Checklist']));
    await userEvent.keyboard('{Backspace}{Backspace}{Backspace}{Backspace}grid');
    await waitFor(() => expect(menu.getAllByRole('option').map((option) => option.textContent)).toEqual(['Table']));
    expect(textbox).toHaveFocus();
    await userEvent.keyboard('{Tab}');
    await waitFor(() => expect(checked(filtered.latest.current)?.type).toBe('table'));
    expect(canvas.queryByRole('listbox')).toBeNull();
    expect(textbox).not.toHaveTextContent('/');
    // The inserted grid has empty header cells. Leave a named paragraph so the settled story stays accessible.
    await userEvent.keyboard('{Control>}a{/Control}A finished paragraph');
    await waitFor(() => expect(checked(filtered.latest.current)?.content?.[0]?.text).toBe('A finished paragraph'));
    expect(textbox).toHaveFocus();
  },
};

export const KeyboardChoose: Story = {
  render: () => <keyboard.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox, menu } = await openMenu(canvasElement, '/');
    const list = canvas.getByRole('listbox', { name: 'Insert block' });
    expect(textbox).toHaveFocus();
    expect(textbox).toHaveAttribute('aria-expanded', 'true');
    expect(textbox).toHaveAttribute('aria-controls', list.id);
    await userEvent.keyboard('{ArrowDown}');
    const heading = menu.getByRole('option', { name: 'Heading 2' });
    await waitFor(() => expect(textbox).toHaveAttribute('aria-activedescendant', heading.id));
    expect(heading).toHaveAttribute('aria-selected', 'true');
    expect(menu.getByRole('option', { name: 'Heading 1' })).toHaveAttribute('aria-selected', 'false');
    expect(textbox).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      const block = checked(keyboard.latest.current);
      expect(block?.type).toBe('heading');
      expect(block?.attrs?.level).toBe(2);
    });
    expect(canvas.queryByRole('listbox')).toBeNull();
    expect(textbox).not.toHaveTextContent('/');
    await userEvent.keyboard('Chapter');
    await waitFor(() => expect(checked(keyboard.latest.current)?.content?.[0]?.text).toBe('Chapter'));
    expect(textbox).toHaveFocus();
  },
};

export const EscapeKeepsText: Story = {
  render: () => <escaped.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Post' });
    await userEvent.click(textbox);
    await userEvent.keyboard('Keep /zzz');
    const menu = within(await canvas.findByRole('listbox', { name: 'Insert block' }));
    expect(menu.getByText('No matching blocks')).toBeVisible();
    expect(menu.queryByRole('option')).toBeNull();
    expect(textbox).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(canvas.queryByRole('listbox')).toBeNull());
    expect(textbox).not.toHaveAttribute('aria-expanded', 'true');
    expect(textbox).toHaveFocus();
    await userEvent.keyboard('!');
    await waitFor(() => expect(checked(escaped.latest.current)?.content?.[0]?.text).toBe('Keep /zzz!'));
  },
};

export const LiteralSlash: Story = {
  render: () => <literal.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Post' });
    await userEvent.click(textbox);
    await userEvent.keyboard('and/or');
    await waitFor(() => expect(checked(literal.latest.current)?.content?.[0]?.text).toBe('and/or'));
    expect(canvas.queryByRole('listbox', { name: 'Insert block' })).toBeNull();
    expect(textbox).not.toHaveAttribute('aria-expanded', 'true');
    expect(textbox).toHaveFocus();
  },
};

export const ProfileCommands: Story = {
  render: () => <profiles.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox, menu } = await openMenu(canvasElement, '/');
    expect(menu.getByRole('option', { name: 'Heading 1' })).toBeVisible();
    expect(menu.getByRole('option', { name: 'Divider' })).toBeVisible();
    expect(menu.queryByRole('option', { name: /table|image/i })).toBeNull();
    expect(canvas.queryByRole('button', { name: /table|image/i })).toBeNull();
    await userEvent.keyboard('quote{Enter}');
    await waitFor(() => expect(checked(profiles.latest.current)?.type).toBe('blockquote'));
    expect(profiles.latest.current.profile).toBe('text');
    expect(canvas.queryByRole('listbox')).toBeNull();
    expect(textbox).not.toHaveTextContent('/');
  },
};
