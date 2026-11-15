import { fromMarkdown, checkDocument, type DocumentSnapshot } from '@rezics/document';
import type { Editor } from '@tiptap/core';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { Button } from '@rezics/ui/shadcn/button';
import type { EditorPreferences } from '../preferences.ts';
import { RichTextEditor } from './rich-text-editor.tsx';
import type { EditorPreset } from './editor-workbench.tsx';
import { waitForFocus } from '../../../ui/src/test/focus.ts';
import { moveToEditorEnd } from '../test/browser-input.ts';

const chapter = fromMarkdown('# A voyage\n\nThe sea is quiet. The sea carries our story.', 'blocks');

function EditorProductHost({
  preset = 'writing',
  readOnly = false,
  initialPreferences = {},
}: {
  preset?: EditorPreset;
  readOnly?: boolean;
  initialPreferences?: EditorPreferences;
}) {
  const [document, setDocument] = useState<DocumentSnapshot>(chapter);
  const [preferences, setPreferences] = useState<EditorPreferences>(initialPreferences);
  const [saves, setSaves] = useState(0);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="mx-auto flex w-full max-w-5xl flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending && !readOnly && checkDocument(document)) setSaves((count) => count + 1);
      }}
    >
      <RichTextEditor
        value={document}
        onChange={(next) => {
          setDocument(next);
          setPending(false);
        }}
        onSnapshotPending={() => setPending(true)}
        label="Chapter draft"
        preset={preset}
        readOnly={readOnly}
        preferences={preferences}
        onPreferencesChange={setPreferences}
        preferencesScope="session"
        onSave={() => {
          if (!readOnly) setSaves((count) => count + 1);
        }}
        actions={
          <Button type="submit" disabled={pending || readOnly}>
            Save draft
          </Button>
        }
      />
      <output aria-label="Saved drafts">{saves}</output>
    </form>
  );
}

const meta = {
  title: 'Editor/Writing/Editor Product',
  component: EditorProductHost,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof EditorProductHost>;
export default meta;
type Story = StoryObj<typeof meta>;

const editorFor = (textbox: HTMLElement) => (textbox as HTMLElement & { editor: Editor }).editor;

export const Writing: Story = {
  args: { preset: 'writing' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await canvas.findByRole('textbox', { name: 'Chapter draft' });
    await userEvent.click(canvas.getByRole('button', { name: 'Find and replace' }));
    const find = canvas.getByRole('region', { name: 'Find and replace' });
    const search = within(find).getByRole('textbox', { name: 'Find text' });
    await userEvent.type(search, 'sea');
    await userEvent.keyboard('{Enter}');
    await expect(canvas.getByRole('status', { name: 'Saved drafts' })).toHaveTextContent('0');
    await userEvent.click(within(find).getByRole('button', { name: 'Replace with' }));
    await userEvent.type(within(find).getByRole('textbox', { name: 'Replace with' }), 'ocean');
    await userEvent.click(within(find).getByRole('button', { name: 'Replace all' }));
    await waitFor(() => expect(textbox).toHaveTextContent('The ocean is quiet. The ocean carries our story.'));
    await userEvent.click(within(find).getByRole('button', { name: 'Close find and replace' }));
    await waitForFocus(textbox);
    await userEvent.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(textbox).toHaveTextContent('The sea is quiet. The sea carries our story.'));
    await userEvent.click(canvas.getByRole('button', { name: 'Outline and statistics' }));
    await expect(canvas.getByRole('navigation', { name: 'Outline and statistics' })).toHaveTextContent('A voyage');
    await userEvent.click(canvas.getByRole('button', { name: 'Commands' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commands' });
    await userEvent.type(within(dialog).getByRole('combobox', { name: 'Search available commands' }), 'quote');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Commands' })).not.toBeInTheDocument());
    await waitForFocus(textbox);
    await expect(canvas.getByRole('status', { name: 'Saved drafts' })).toHaveTextContent('0');
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Save draft' })).toBeEnabled());
    await userEvent.click(canvas.getByRole('button', { name: 'Save draft' }));
    await expect(canvas.getByRole('status', { name: 'Saved drafts' })).toHaveTextContent('1');
  },
};

export const Settings: Story = {
  args: { preset: 'writing' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await canvas.findByRole('textbox', { name: 'Chapter draft' });
    const instance = editorFor(textbox);
    const keyboard = await moveToEditorEnd(instance, textbox);
    await keyboard.keyboard(' A new sentence.');
    await waitFor(() => expect(textbox).toHaveTextContent('A new sentence.'));
    await userEvent.click(canvas.getByRole('button', { name: 'Editor settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'Editor settings' });
    const size = within(dialog).getByRole('spinbutton', { name: 'Text size (px)' });
    await userEvent.clear(size);
    await userEvent.type(size, '20');
    await userEvent.keyboard('{Enter}');
    await userEvent.tab();
    await userEvent.selectOptions(within(dialog).getByRole('combobox', { name: 'Toolbar' }), 'hidden');
    await expect(canvas.getByLabelText('Saved drafts')).toHaveTextContent('0');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Editor settings' })).not.toBeInTheDocument());
    await waitForFocus(textbox);
    expect(editorFor(textbox)).toBe(instance);
    await waitFor(() => expect(window.getComputedStyle(textbox).fontSize).toBe('20px'));
    await expect(canvas.queryByRole('toolbar', { name: 'Formatting toolbar' })).not.toBeInTheDocument();
    await keyboard.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(textbox).not.toHaveTextContent('A new sentence.'));
    expect(editorFor(textbox)).toBe(instance);
  },
};

export const Knowledge: Story = {
  args: { preset: 'knowledge' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await canvas.findByRole('textbox', { name: 'Chapter draft' });
    await userEvent.click(canvas.getByText('More tools', { exact: true }));
    await expect(canvas.getByRole('group', { name: 'Annotations' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Block actions' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Commands' }));
    const dialog = await screen.findByRole('dialog', { name: 'Commands' });
    const query = within(dialog).getByRole('combobox', { name: 'Search available commands' });
    await userEvent.type(query, 'table');
    await expect(within(dialog).getByRole('option', { name: 'Table' })).toBeVisible();
    const validTarget = () => {
      for (const owner of dialog.querySelectorAll<HTMLElement>('[cmdk-input], [cmdk-list]')) {
        const id = owner.getAttribute('aria-activedescendant');
        if (!id) continue;
        const target = dialog.ownerDocument.getElementById(id);
        expect(target).not.toBeNull();
        expect(dialog.contains(target)).toBe(true);
        expect(target).toHaveAttribute('aria-selected', 'true');
        expect(target).toBeVisible();
      }
    };
    await waitFor(validTarget);
    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(query.getAttribute('aria-activedescendant')).toBeTruthy();
      validTarget();
    });
    await userEvent.clear(query);
    await userEvent.type(query, 'unmatched-command-query');
    await waitFor(() => expect(query).not.toHaveAttribute('aria-activedescendant'));
    await userEvent.clear(query);
    await userEvent.type(query, 'table');
    await waitFor(validTarget);
  },
};

export const Compact: Story = {
  args: { preset: 'compact' },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await canvas.findByRole('textbox', { name: 'Chapter draft' });
    await expect(canvas.queryByRole('button', { name: 'Find and replace' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Commands' })).toBeVisible();
    await userEvent.click(textbox);
    await userEvent.keyboard('{Control>}f{/Control}');
    await expect(canvas.getByRole('region', { name: 'Find and replace' })).toBeVisible();
  },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await canvas.findByRole('textbox', { name: 'Chapter draft' });
    await expect(textbox).toHaveAttribute('aria-readonly', 'true');
    await expect(canvas.queryByRole('button', { name: 'Editor settings' })).not.toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Outline and statistics' })).toBeVisible();
  },
};

export const KeyboardBindings: Story = {
  args: { preset: 'writing', initialPreferences: { keyboardBindings: { bold: 'Mod-Shift-9', italic: '' } } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await canvas.findByRole('textbox', { name: 'Chapter draft' });
    const editor = editorFor(textbox);
    const keyboard = await moveToEditorEnd(editor, textbox);
    await keyboard.keyboard('{Control>}b{/Control}');
    expect(editor.isActive('bold')).toBe(false);
    await keyboard.keyboard('{Control>}i{/Control}');
    expect(editor.isActive('italic')).toBe(false);
    await keyboard.keyboard('{Control>}{Shift>}9{/Shift}{/Control}');
    expect(editor.isActive('bold')).toBe(true);
    await keyboard.keyboard(' Bound text.');
    await waitFor(() => {
      let bound = false;
      editor.state.doc.descendants((node) => {
        if (node.text?.includes('Bound text.') && node.marks.some((mark) => mark.type.name === 'bold')) bound = true;
      });
      expect(bound).toBe(true);
    });
    await keyboard.keyboard('{Control>}{Shift>}8{/Shift}{/Control}');
    expect(editor.isActive('bulletList')).toBe(true);
  },
};
