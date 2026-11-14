import { checkDocument, fromPlainText, type DocumentProfile, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(
  profile: DocumentProfile = 'blocks',
  options: {
    toolbar?: 'auto' | 'always' | 'never';
    defaultToolbar?: boolean;
    upload?: boolean;
    labels?: Partial<RichTextEditorLabels>;
    value?: string;
    historyControls?: boolean;
  } = {},
) {
  const initial = fromPlainText(options.value ?? 'Touch formatting', profile);
  const latest = { current: initial };

  function Demo() {
    const [value, setValue] = useState(initial);
    const [mode, setMode] = useState('Edit');
    return (
      <div className="min-h-[70vh] pb-24">
        {options.historyControls &&
          ['Edit', 'Preview', 'History', 'Read only', 'Outer shortcut', 'Replace', 'Restore', 'Unmount'].map((next) => (
            <button
              key={next}
              type="button"
              onClick={() => {
                setMode(next);
                if (next === 'Replace') setValue(fromPlainText('Other document', profile));
                if (next === 'Restore') setValue(initial);
              }}
            >
              {next}
            </button>
          ))}
        <div hidden={mode === 'Preview' || mode === 'History'}>
          {mode !== 'Unmount' && (
            <RichTextEditor
              value={value}
              label="Post"
              readOnly={mode === 'Read only'}
              onKeyDown={(event) => {
                if (mode === 'Outer shortcut') event.preventDefault();
              }}
              {...(!options.defaultToolbar ? { toolbar: options.toolbar ?? 'always' } : {})}
              labels={options.labels ?? {}}
              upload={options.upload ? async () => ({ src: 'touch-bar-image' }) : undefined}
              onChange={(next) => {
                latest.current = next;
                setValue(next);
              }}
            />
          )}
        </div>
      </div>
    );
  }

  return { Demo, latest };
}

async function selectText(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const textbox = canvas.getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  const range = document.createRange();
  range.selectNodeContents(textbox);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  return { canvas, textbox };
}

function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content?.[0];
}

function plainText(snapshot: DocumentSnapshot): string {
  return (
    snapshot.doc.content?.map((block) => block.content?.map((inline) => inline.text ?? '').join('') ?? '').join('') ??
    ''
  );
}

const meta = {
  title: 'Components/Editor Touch Bar',
  component: RichTextEditor,
  args: { value: fromPlainText('Touch formatting'), label: 'Post', onChange: () => undefined },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-background p-8 text-foreground sm:p-16">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

const format = demo('blocks', { toolbar: 'always' });
const keepsFocus = demo('blocks', { toolbar: 'always' });
const blocks = demo('blocks', { toolbar: 'always' });
const history = demo('blocks', { toolbar: 'always', value: '', historyControls: true });
const keyboard = demo('blocks', { toolbar: 'always' });
const profiles = demo('text', { toolbar: 'always', upload: true });
const finePointer = demo('blocks', { defaultToolbar: true, value: 'Selection menu still works' });

export const FormatSelection: Story = {
  render: () => <format.Demo />,
  async play({ canvasElement }) {
    const { canvas } = await selectText(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    const bold = toolbar.getByRole('button', { name: 'Bold' });
    expect(bold).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(bold);
    await waitFor(() => {
      expect(bold).toHaveAttribute('aria-pressed', 'true');
      expect(checked(format.latest.current)?.content?.[0]?.marks?.some((mark) => mark.type === 'bold')).toBe(true);
    });
    expect(toolbar.getByRole('button', { name: 'Inline code' })).toHaveAttribute('aria-pressed', 'false');
  },
};

export const KeepsFocus: Story = {
  render: () => <keepsFocus.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox } = await selectText(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(toolbar.getByRole('button', { name: 'Italic' }));
    await waitFor(() => expect(checked(keepsFocus.latest.current)?.content?.[0]?.marks?.[0]?.type).toBe('italic'));
    expect(textbox).toHaveFocus();
    expect(window.getSelection()?.toString()).toBe('Touch formatting');
  },
};

export const BlockSheet: Story = {
  render: () => <blocks.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox } = await selectText(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(toolbar.getByRole('button', { name: 'Blocks' }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole('dialog', { name: 'Blocks' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Heading 2' }));
    await waitFor(() => expect(checked(blocks.latest.current)?.type).toBe('heading'));
    expect(checked(blocks.latest.current)?.attrs?.level).toBe(2);
    await waitFor(() => expect(textbox).toHaveFocus());
  },
};

export const UndoRedo: Story = {
  render: () => <history.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Post' });
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    const undo = toolbar.getByRole('button', { name: 'Undo' });
    const redo = toolbar.getByRole('button', { name: 'Redo' });
    expect(undo).toBeDisabled();
    expect(redo).toBeDisabled();

    await userEvent.click(textbox);
    await userEvent.type(textbox, 'History');
    await waitFor(() => expect(plainText(history.latest.current)).toBe('History'));
    expect(checked(history.latest.current)).toBeTruthy();
    expect(undo).toBeEnabled();
    await userEvent.click(undo);
    await waitFor(() => expect(plainText(history.latest.current)).toBe(''));
    expect(checked(history.latest.current)).toBeTruthy();
    expect(redo).toBeEnabled();
    await userEvent.click(redo);
    await waitFor(() => expect(plainText(history.latest.current)).toBe('History'));
    expect(checked(history.latest.current)).toBeTruthy();
    const original = history.latest.current;

    const shortcut = async (key: string, expected: string, init: KeyboardEventInit = {}, handled = true) => {
      const event = key.startsWith('history')
        ? new InputEvent('beforeinput', { inputType: key, bubbles: true, cancelable: true, ...init })
        : new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
      expect(textbox.dispatchEvent(event)).toBe(!handled);
      await waitFor(() => expect(textbox.textContent).toBe(expected));
      if (handled) expect(textbox).toHaveFocus();
    };
    const control = async (name: string) => userEvent.click(canvas.getByRole('button', { name, exact: true }));
    const view = (textbox as HTMLElement & { editor: Editor }).editor.view;
    const captureNative = () => view.props.handleDOMEvents!.beforeinput!;
    const staleInput = new InputEvent('beforeinput', { inputType: 'historyUndo', cancelable: true });
    Object.defineProperty(staleInput, 'target', { value: textbox });
    view.dispatch(closeHistory(view.state.tr));
    await userEvent.type(textbox, '!');
    await shortcut('historyUndo', 'History');
    await shortcut('historyRedo', 'History!');
    await waitFor(() => expect(plainText(history.latest.current)).toBe('History!'));
    expect(checked(history.latest.current)?.attrs?.id).toBe(checked(original)?.attrs?.id);
    await control('Restore');
    await userEvent.click(textbox);
    for (const type of ['historyUndo', 'historyRedo']) await shortcut(type, '', {}, false);
    await userEvent.type(textbox, 'History');
    for (const panel of ['Preview', 'History']) {
      await control(panel);
      expect(textbox).not.toBeVisible();
      await control('Edit');
      expect(canvas.getByRole('textbox', { name: 'Post' })).toBe(textbox);
      await userEvent.click(textbox);
      const platform = { ctrlKey: panel === 'Preview', metaKey: panel === 'History' };
      await shortcut('z', '', platform);
      expect(undo).toBeDisabled();
      expect(redo).toBeEnabled();
      await userEvent.click(redo);
      await shortcut('z', '', platform);
      await shortcut(panel === 'Preview' ? 'y' : 'z', 'History', { ...platform, shiftKey: panel === 'History' });
      await shortcut('z', 'History', { shiftKey: true }, false);
    }
    const retiredInput = captureNative();
    for (const mode of ['Read only', 'Outer shortcut', 'Edit']) {
      await control(mode);
      await shortcut('historyUndo', 'History', {}, false);
      if (mode !== 'Read only') await userEvent.click(textbox);
      await shortcut('z', 'History', { isComposing: mode === 'Edit' }, mode === 'Outer shortcut');
    }
    expect(retiredInput(view, staleInput)).toBe(false);
    await shortcut('historyUndo', 'History', { isComposing: true }, false);
    textbox.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    await shortcut('historyUndo', 'History', {}, false);
    textbox.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await waitFor(() => expect(view.composing).toBe(false));
    await shortcut('historyUndo', 'History', { cancelable: false }, false);
    textbox.addEventListener('beforeinput', (event) => event.preventDefault(), { capture: true, once: true });
    await shortcut('historyUndo', 'History');
    await shortcut('z', 'History', { altKey: true }, false);
    await shortcut('z', '');
    await shortcut('z', 'History', { shiftKey: true });
    const keyboardCallback = () => {
      const surface = textbox.closest('[data-slot="rich-text-editor"]')!;
      const props = Object.getOwnPropertyNames(surface).find((key) => key.startsWith('__reactProps$'))!;
      return (surface as unknown as Record<string, { onKeyDown: (event: unknown) => void }>)[props]!.onKeyDown;
    };
    const retired = keyboardCallback();
    await control('Replace');
    await userEvent.type(textbox, 'New');
    const currentText = textbox.textContent!;
    const staleKey = Object.assign(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }), { nativeEvent: {} });
    expect(retiredInput(view, staleInput)).toBe(false);
    retired(staleKey);
    expect(textbox.textContent).toBe(currentText);
    await shortcut('historyUndo', 'Other document');
    await shortcut('historyRedo', currentText);
    await shortcut('z', 'Other document');
    await shortcut('z', 'Other document', {}, false);
    await waitFor(() => expect(plainText(history.latest.current)).toBe('Other document'));
    await control('Restore');
    await userEvent.click(textbox);
    for (const type of ['historyUndo', 'historyRedo']) await shortcut(type, '', {}, false);
    await userEvent.type(textbox, 'History');
    expect(retiredInput(view, staleInput)).toBe(false);
    expect(textbox.textContent).toBe('History');
    await waitFor(() => expect(history.latest.current).toEqual(original));
    const unmounted = keyboardCallback();
    const unmountedInput = captureNative();
    await control('Unmount');
    const published = history.latest.current;
    unmounted(staleKey);
    expect(unmountedInput(view, staleInput)).toBe(false);
    expect(staleInput.defaultPrevented).toBe(false);
    expect(history.latest.current).toBe(published);
  },
};

export const ToolbarKeyboard: Story = {
  render: () => <keyboard.Demo />,
  async play({ canvasElement }) {
    const { canvas, textbox } = await selectText(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.tab();
    const bold = toolbar.getByRole('button', { name: 'Bold' });
    expect(bold).toHaveFocus();
    expect(toolbar.getAllByRole('button').filter((button) => button.tabIndex === 0)).toEqual([bold]);
    const italic = toolbar.getByRole('button', { name: 'Italic' });
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(italic).toHaveFocus());
    await userEvent.keyboard('{ArrowLeft}');
    await waitFor(() => expect(bold).toHaveFocus());
    await userEvent.keyboard('{End}');
    await waitFor(() => expect(toolbar.getByRole('button', { name: 'Hide keyboard' })).toHaveFocus());
    await userEvent.keyboard('{Home}');
    await waitFor(() => expect(bold).toHaveFocus());
    expect(textbox).toBeInTheDocument();
  },
};

export const ProfileCommands: Story = {
  render: () => <profiles.Demo />,
  async play({ canvasElement }) {
    const { canvas } = await selectText(canvasElement);
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Formatting toolbar' }));
    await userEvent.click(toolbar.getByRole('button', { name: 'Blocks' }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = within(await page.findByRole('dialog', { name: 'Blocks' }));
    expect(dialog.queryByRole('button', { name: 'Image' })).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Table' })).toBeNull();
    await waitFor(() => expect(dialog.getByRole('button', { name: 'Heading 1' })).toBeVisible());
  },
};

export const HiddenForFinePointer: Story = {
  render: () => <finePointer.Demo />,
  async play({ canvasElement }) {
    expect(window.matchMedia('(pointer: coarse)').matches).toBe(false);
    const { canvas } = await selectText(canvasElement);
    expect(canvas.queryByRole('toolbar', { name: 'Formatting toolbar' })).toBeNull();
    const toolbar = within(await canvas.findByRole('toolbar', { name: 'Format text' }));
    const bold = toolbar.getByRole('button', { name: 'Bold' });
    await userEvent.click(bold);
    await waitFor(() => expect(checked(finePointer.latest.current)?.content?.[0]?.marks?.[0]?.type).toBe('bold'));
  },
};
