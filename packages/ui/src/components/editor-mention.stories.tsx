import { checkDocument, fromPlainText } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';

const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const handle = 'abcdefghij';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function demo(source = true) {
  const initial = fromPlainText('', 'blocks');
  const latest = { current: initial };
  const calls: { handle: string; signal: AbortSignal; at: number }[] = [];
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        label="Post"
        value={value}
        compact
        lookupMention={
          source
            ? async (query, signal) => {
                calls.push({ handle: query, signal, at: Date.now() });
                // Ignore cancellation on purpose: an obsolete response must still never appear.
                if (query === 'old') await pause(600);
                return query === handle || query === 'old'
                  ? { accountId, handle: query, name: '<script>name</script>' }
                  : null;
              }
            : undefined
        }
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
      />
    );
  }
  return { Demo, latest, calls };
}
async function type(canvasElement: HTMLElement, text: string) {
  const view = within(canvasElement);
  const editor = view.getByRole('textbox', { name: 'Post' });
  await userEvent.click(editor);
  await userEvent.keyboard(text);
  return { view, editor };
}
function inserted(instance: ReturnType<typeof demo>) {
  expect(checkDocument(instance.latest.current)).toBe(true);
  expect(instance.latest.current.doc.content?.[0]?.content?.[0]).toEqual({ type: 'mention', attrs: { accountId } });
  expect(JSON.stringify(instance.latest.current)).not.toContain(handle);
}
const meta = {
  title: 'Components/Editor Mention',
  component: RichTextEditor,
  args: { value: fromPlainText(''), label: 'Post', onChange: () => undefined },
  parameters: { layout: 'padded', a11y: { test: 'error' } },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-2xl bg-background p-4 text-foreground sm:p-16">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;
const keyboard = demo();
export const KeyboardChoose: Story = {
  render: () => <keyboard.Demo />,
  async play({ canvasElement }) {
    const { view, editor } = await type(canvasElement, `@${handle}`);
    const option = await view.findByRole('option', { name: `@${handle} <script>name</script>` });
    expect(editor).toHaveAttribute('role', 'combobox');
    expect(editor).toHaveAttribute('aria-expanded', 'true');
    expect(editor).toHaveAttribute('aria-activedescendant', option.id);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => inserted(keyboard));
    expect(view.queryByRole('listbox')).toBeNull();
  },
};
const pointer = demo();
export const PointerChoose: Story = {
  render: () => <pointer.Demo />,
  async play({ canvasElement }) {
    const { view } = await type(canvasElement, `@${handle}`);
    await userEvent.click(await view.findByRole('option', { name: `@${handle} <script>name</script>` }));
    await waitFor(() => inserted(pointer));
  },
};
const cancel = demo();
export const DebounceAndCancel: Story = {
  render: () => <cancel.Demo />,
  async play({ canvasElement }) {
    const bare = await type(canvasElement, '@');
    expect(bare.view.queryByRole('listbox')).toBeNull();
    await userEvent.keyboard('{Backspace}');
    const { view, editor } = await type(canvasElement, '@old');
    await waitFor(() => expect(cancel.calls).toHaveLength(1));
    expect(view.getByText('Looking up account…')).toHaveAttribute('role', 'status');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(editor).not.toHaveAttribute('aria-activedescendant');
    await userEvent.keyboard('x');
    expect(cancel.calls[0]!.signal.aborted).toBe(true);
    await userEvent.keyboard('{Control>}a{/Control}{Backspace}');
    const start = Date.now();
    await userEvent.keyboard(`@${handle}`);
    await pause(100);
    expect(cancel.calls).toHaveLength(1);
    const option = await view.findByRole('option', { name: `@${handle} <script>name</script>` });
    expect(cancel.calls.map((call) => call.handle)).toEqual(['old', handle]);
    expect(cancel.calls[1]!.at - start).toBeGreaterThanOrEqual(200);
    await pause(650);
    expect(view.queryByRole('option', { name: /@old/ })).toBeNull();
    expect(editor).toHaveAttribute('aria-activedescendant', option.id);
    expect(canvasElement.querySelector('script')).toBeNull();
    // Leave the menu open so the accessibility addon audits the listbox and combobox.
  },
};
const unknown = demo();
export const UnknownHandle: Story = {
  render: () => <unknown.Demo />,
  async play({ canvasElement }) {
    const { view, editor } = await type(canvasElement, '@nobody');
    await waitFor(() => expect(unknown.calls).toHaveLength(1));
    await pause(250);
    expect(view.queryByRole('option')).toBeNull();
    expect(editor).toHaveTextContent('@nobody');
    expect(unknown.latest.current.doc.content?.[0]?.content?.[0]?.type).toBe('text');
  },
};
const escaped = demo();
export const EscapeKeepsText: Story = {
  render: () => <escaped.Demo />,
  async play({ canvasElement }) {
    const { view, editor } = await type(canvasElement, `@${handle}`);
    await view.findByRole('option');
    await userEvent.keyboard('{Escape}');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(editor).toHaveTextContent(`@${handle}`);
    await userEvent.keyboard('x');
    await pause(300);
    expect(escaped.calls).toHaveLength(1);
  },
};
const literal = demo(false);
export const NoSource: Story = {
  render: () => <literal.Demo />,
  async play({ canvasElement }) {
    const { view, editor } = await type(canvasElement, `@${handle}`);
    await pause(300);
    expect(view.queryByRole('listbox')).toBeNull();
    expect(editor).toHaveTextContent(`@${handle}`);
    expect(literal.calls).toHaveLength(0);
  },
};
