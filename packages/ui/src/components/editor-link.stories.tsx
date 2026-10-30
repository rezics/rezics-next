import { checkDocument, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';

function demo(linked = false) {
  const initial = structuredClone(fromPlainText('A useful resource'));
  if (linked)
    initial.doc.content![0]!.content![0]!.marks = [{ type: 'link', attrs: { href: 'https://example.com/original' } }];
  const latest = { current: initial };
  function Demo() {
    const [value, setValue] = useState(initial);
    return (
      <RichTextEditor
        compact
        value={value}
        label="Post"
        onChange={(next) => {
          latest.current = next;
          setValue(next);
        }}
      />
    );
  }
  return { Demo, latest, initial };
}
function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content?.[0]?.content?.[0];
}
async function select(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole('textbox', { name: 'Post' }));
  const range = document.createRange();
  range.selectNodeContents(canvas.getByRole('textbox', { name: 'Post' }));
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await canvas.findByRole('toolbar', { name: 'Format text' });
  return canvas;
}
const meta = {
  title: 'Components/Editor Link',
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
const insert = demo();
const unsafe = demo();
const existing = demo(true);

export const InsertLink: Story = {
  render: () => <insert.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    await userEvent.keyboard('{Control>}k{/Control}');
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveFocus();
    await userEvent.type(address, 'https://example.com/resource');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(checked(insert.latest.current)?.marks?.[0]?.attrs?.href).toBe('https://example.com/resource'),
    );
    expect(checked(insert.latest.current)?.text).toBe('A useful resource');
    // The editor returns focus on the next animation frame and restores its own selection then, so collapse after that.
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveFocus());
    // An empty selection accepts an address as linked text.
    window.getSelection()?.collapseToEnd();
    document.dispatchEvent(new Event('selectionchange'));
    await waitFor(() => expect(canvas.queryByRole('toolbar')).toBeNull());
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await canvas.findByRole('textbox', { name: 'URL' }), 'mailto:hello@example.com');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(checkDocument(insert.latest.current)).toBe(true);
      expect(JSON.stringify(insert.latest.current)).toContain('mailto:hello@example.com');
    });
  },
};

export const UnsafeLinkRefused: Story = {
  render: () => <unsafe.Demo />,
  async play({ canvasElement }) {
    const canvas = await select(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Link' }));
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    for (const url of ['javascript:alert(1)', 'data:text/html,unsafe', '/relative', 'ftp://example.com']) {
      await userEvent.clear(address);
      await userEvent.type(address, url);
      await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
      expect(await canvas.findByRole('alert')).toHaveTextContent('Enter an http:, https: or mailto: address.');
      expect(address).toHaveAttribute('aria-invalid', 'true');
      expect(getComputedStyle(address).color).toBe(
        getComputedStyle(canvas.getByRole('textbox', { name: 'Post' })).color,
      );
      expect(unsafe.latest.current).toEqual(unsafe.initial);
      checked(unsafe.latest.current);
    }
    await userEvent.keyboard('{Escape}');
    expect(canvas.queryByRole('textbox', { name: 'URL' })).toBeNull();
    await waitFor(() => expect(canvas.getByRole('textbox', { name: 'Post' })).toHaveFocus());
    expect(window.getSelection()?.toString()).toBe('A useful resource');
    expect(checked(unsafe.latest.current)?.marks ?? []).toEqual([]);
  },
};

export const EditAndRemoveLink: Story = {
  render: () => <existing.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('textbox', { name: 'Post' }));
    const text = canvas.getByRole('textbox', { name: 'Post' }).querySelector('a')!.firstChild!;
    window.getSelection()?.collapse(text, 1);
    document.dispatchEvent(new Event('selectionchange'));
    const open = await canvas.findByRole('link', { name: 'Open link' });
    expect(open).toHaveAttribute('href', 'https://example.com/original');
    await userEvent.click(canvas.getByRole('button', { name: 'Edit link' }));
    const address = await canvas.findByRole('textbox', { name: 'URL' });
    expect(address).toHaveValue('https://example.com/original');
    await userEvent.clear(address);
    await userEvent.type(address, 'http://example.com/edited');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(checked(existing.latest.current)?.marks?.[0]?.attrs?.href).toBe('http://example.com/edited'),
    );
    window.getSelection()?.collapse(canvas.getByRole('textbox', { name: 'Post' }).querySelector('a')!.firstChild!, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }));
    await waitFor(() => expect(checked(existing.latest.current)?.marks ?? []).toEqual([]));
    expect(checked(existing.latest.current)?.text).toBe('A useful resource');
  },
};
