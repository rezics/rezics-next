import { checkDocument, fromPlainText, type DocumentSnapshot } from '@rezics/document';
import { Button } from '@rezics/ui/shadcn/button';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';
import type { ImageUploader, UploadedImage, UploadState } from './editor-uploads.ts';

const file = (name = 'landscape.png', type = 'image/png') => new File(['image'], name, { type });
function demo(profile: 'blocks' | 'text' = 'blocks', delayed = false) {
  const initial = fromPlainText('Before after', profile);
  const latest = { current: initial };
  const calls: { file: File; signal: AbortSignal; resolve: (image: UploadedImage) => void; reject: () => void }[] = [];
  const states: { state: UploadState; count: number }[] = [];
  const upload: ImageUploader = (file, signal) =>
    new Promise((resolve, reject) => {
      calls.push({ file, signal, resolve, reject: () => reject(new Error('Offline')) });
      if (!delayed) resolve({ src: 'media-landscape', width: 640, height: 480 });
    });
  function Demo() {
    const [value, setValue] = useState(initial);
    const [state, setState] = useState<UploadState>('ready');
    const [shown, setShown] = useState(true);
    return (
      <>
        {shown ? (
          <RichTextEditor
            compact
            value={value}
            label="Post"
            upload={(file, signal) => upload(file, signal)}
            onChange={(next) => {
              latest.current = next;
              setValue(next);
            }}
            onUploadState={(state, count) => {
              states.push({ state, count });
              setState(state);
            }}
            actions={
              <Button type="button" disabled={state !== 'ready'}>
                Send
              </Button>
            }
          />
        ) : null}
        <button type="button" onClick={() => setShown(false)}>
          Remove editor
        </button>
        {profile === 'text' ? (
          <RichTextEditor
            compact
            value={fromPlainText('Plain', 'blocks')}
            label="Without uploads"
            onChange={() => undefined}
          />
        ) : null}
      </>
    );
  }
  return { Demo, initial, latest, calls, states };
}
function checked(snapshot: DocumentSnapshot) {
  expect(checkDocument(snapshot)).toBe(true);
  return snapshot.doc.content ?? [];
}
function images(snapshot: DocumentSnapshot) {
  return checked(snapshot).filter((node) => node.type === 'image');
}
async function caret(canvasElement: HTMLElement, offset = 7) {
  const textbox = within(canvasElement).getByRole('textbox', { name: 'Post' });
  await userEvent.click(textbox);
  window.getSelection()?.collapse(textbox.querySelector('p')!.firstChild!, offset);
  document.dispatchEvent(new Event('selectionchange'));
  return textbox;
}
async function choose(canvasElement: HTMLElement, alt = '') {
  const canvas = within(canvasElement);
  await caret(canvasElement);
  await userEvent.click(canvas.getByRole('button', { name: 'Image' }));
  const panel = within(await canvas.findByRole('dialog', { name: 'Image' }));
  await userEvent.upload(panel.getByLabelText('Choose image file'), file());
  if (alt) await userEvent.type(panel.getByRole('textbox', { name: 'Alt text' }), alt);
  await userEvent.click(panel.getByRole('button', { name: 'Insert image' }));
  return canvas;
}
function transfer(files: File[]) {
  const data = new DataTransfer();
  for (const file of files) data.items.add(file);
  return data;
}
function paste(textbox: HTMLElement, files: File[]) {
  const data = transfer(files);
  data.setData('text/html', '<p>Unrequested file fallback</p>');
  textbox.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
}
function drop(textbox: HTMLElement, files: File[], offset = 0) {
  const range = document.createRange();
  range.setStart(textbox.querySelector('p')!.firstChild!, offset);
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  textbox.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer(files),
      clientX: rect.left + 1,
      clientY: rect.top + rect.height / 2,
    }),
  );
}
const meta = {
  title: 'Components/Editor Image',
  component: RichTextEditor,
  args: { value: fromPlainText('', 'blocks'), onChange: () => undefined, label: 'Post' },
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
const insert = demo('blocks', true);
const altText = demo();
const pasted = demo('blocks', true);
const dropped = demo('blocks', true);
const failure = demo('blocks', true);
const text = demo('text');

export const UploadImage: Story = {
  render: () => <insert.Demo />,
  async play({ canvasElement }) {
    const canvas = await choose(canvasElement, 'A mountain at dawn');
    expect(canvas.getByRole('status', { name: 'Uploading image' })).toHaveTextContent('landscape.png');
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(insert.calls).toHaveLength(1);
    expect(insert.calls[0]!.file.name).toBe('landscape.png');
    expect(insert.calls[0]!.signal.aborted).toBe(false);
    expect(images(insert.latest.current)).toHaveLength(0);
    // Move the caret and edit before the requested insertion point while the upload is pending.
    await caret(canvasElement, 0);
    await userEvent.keyboard('New ');
    insert.calls[0]!.resolve({ src: 'media-landscape', width: 640, height: 480 });
    await canvas.findByRole('img', { name: 'A mountain at dawn' });
    await waitFor(() => {
      expect(images(insert.latest.current)[0]?.attrs).toMatchObject({
        src: 'media-landscape',
        alt: 'A mountain at dawn',
        width: 640,
        height: 480,
      });
      expect(checked(insert.latest.current)[0]?.content?.[0]?.text).toBe('New Before ');
      expect(canvas.getByRole('button', { name: 'Send' })).toBeEnabled();
    });
    expect(insert.states).toContainEqual({ state: 'pending', count: 1 });
    expect(insert.states.at(-1)).toEqual({ state: 'ready', count: 0 });
    // Removing the editor aborts a second upload and late completions cannot change the snapshot.
    paste(await caret(canvasElement, 0), [file('cancel.png')]);
    await waitFor(() => expect(insert.calls).toHaveLength(2));
    const before = insert.latest.current;
    await userEvent.click(canvas.getByRole('button', { name: 'Remove editor' }));
    expect(insert.calls[1]!.signal.aborted).toBe(true);
    insert.calls[1]!.resolve({ src: 'cancelled' });
    await Promise.resolve();
    expect(insert.latest.current).toEqual(before);
    checked(insert.latest.current);
  },
};

export const AltText: Story = {
  render: () => <altText.Demo />,
  async play({ canvasElement }) {
    const canvas = await choose(canvasElement, 'Original description');
    await canvas.findByRole('img', { name: 'Original description' });
    await userEvent.click(canvas.getByRole('button', { name: 'Edit alt text' }));
    const field = canvas.getByRole('textbox', { name: 'Alt text' });
    expect(field).toHaveValue('Original description');
    await userEvent.clear(field);
    await userEvent.type(field, 'A ridge above the clouds');
    await userEvent.click(canvas.getByRole('button', { name: 'Apply' }));
    await canvas.findByRole('img', { name: 'A ridge above the clouds' });
    await waitFor(() => expect(images(altText.latest.current)[0]?.attrs?.alt).toBe('A ridge above the clouds'));
    expect(altText.calls).toHaveLength(1);
  },
};

export const PasteImage: Story = {
  render: () => <pasted.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await caret(canvasElement);
    paste(textbox, [file('unsafe.svg', 'image/svg+xml'), file('notes.txt', 'text/plain')]);
    expect(await canvas.findByRole('status', { name: 'Image' })).toHaveTextContent(
      'Choose a PNG, JPEG, WebP, GIF or AVIF image.',
    );
    expect(pasted.calls).toHaveLength(0);
    expect(checked(pasted.latest.current)).toEqual(checked(pasted.initial));
    const types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];
    paste(
      textbox,
      types.map((type, index) => file(`image-${index}`, type)),
    );
    await waitFor(() => expect(pasted.calls).toHaveLength(5));
    expect(pasted.states.at(-1)).toEqual({ state: 'pending', count: 5 });
    expect(canvas.getByRole('status', { name: 'Uploading image' })).toHaveTextContent('image-4');
    pasted.calls.forEach((call, index) => call.resolve({ src: `media-${index}` }));
    await waitFor(() => expect(canvas.getAllByRole('img', { name: 'Image' })).toHaveLength(5));
    await waitFor(() => expect(images(pasted.latest.current)).toHaveLength(5));
    expect(checked(pasted.latest.current)[0]?.content?.[0]?.text).toBe('Before ');
    expect(pasted.states.at(-1)).toEqual({ state: 'ready', count: 0 });
    paste(
      await caret(canvasElement, 0),
      Array.from({ length: 28 }, (_, index) => file(`batch-${index}.png`)),
    );
    await waitFor(() => expect(pasted.calls).toHaveLength(32));
    expect(canvas.getByRole('status', { name: 'Image' })).toHaveTextContent('A post can contain up to 32 media files.');
    expect(pasted.states.at(-1)).toEqual({ state: 'pending', count: 27 });
    await userEvent.click(canvas.getByRole('button', { name: 'Remove editor' }));
    expect(pasted.calls.slice(5).every((call) => call.signal.aborted)).toBe(true);
    expect(images(pasted.latest.current)).toHaveLength(5);
  },
};

export const DropImage: Story = {
  render: () => <dropped.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await caret(canvasElement, 12);
    // The drop position differs from the caret position.
    drop(textbox, [file('dropped.webp', 'image/webp')], 7);
    await waitFor(() => expect(dropped.calls).toHaveLength(1));
    expect(canvas.getByRole('status', { name: 'Uploading image' })).toHaveTextContent('dropped.webp');
    await caret(canvasElement, 0);
    await userEvent.keyboard('New ');
    dropped.calls[0]!.resolve({ src: 'media-dropped' });
    await canvas.findByRole('img', { name: 'Image' });
    await waitFor(() => {
      expect(images(dropped.latest.current)[0]?.attrs?.src).toBe('media-dropped');
      expect(checked(dropped.latest.current)[0]?.content?.[0]?.text).toBe('New Before ');
    });
  },
};

export const UploadFailure: Story = {
  render: () => <failure.Demo />,
  async play({ canvasElement }) {
    const canvas = await choose(canvasElement, 'Retried description');
    failure.calls[0]!.reject();
    expect(await canvas.findByRole('alert', { name: 'Image upload failed' })).toHaveTextContent('landscape.png');
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(failure.latest.current).toEqual(failure.initial);
    checked(failure.latest.current);
    expect(failure.states.at(-1)).toEqual({ state: 'failed', count: 0 });
    await userEvent.click(canvas.getByRole('button', { name: 'Retry upload' }));
    await waitFor(() => expect(failure.calls).toHaveLength(2));
    expect(failure.calls[1]!.file).toBe(failure.calls[0]!.file);
    failure.calls[1]!.resolve({ src: 'media-retried' });
    await canvas.findByRole('img', { name: 'Retried description' });
    await waitFor(() => expect(images(failure.latest.current)[0]?.attrs?.src).toBe('media-retried'));
    paste(await caret(canvasElement, 0), [file('fail-again.png')]);
    await waitFor(() => expect(failure.calls).toHaveLength(3));
    const before = failure.latest.current;
    failure.calls[2]!.reject();
    await canvas.findByRole('alert', { name: 'Image upload failed' });
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss upload' }));
    expect(canvas.queryByRole('alert', { name: 'Image upload failed' })).toBeNull();
    expect(canvas.getByRole('button', { name: 'Send' })).toBeEnabled();
    expect(failure.latest.current).toEqual(before);
    checked(failure.latest.current);
  },
};

export const TextProfileHasNoImages: Story = {
  render: () => <text.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = await caret(canvasElement);
    expect(canvas.queryByRole('button', { name: 'Image' })).toBeNull();
    paste(textbox, [file()]);
    drop(textbox, [file()]);
    const noUpload = canvas.getByRole('textbox', { name: 'Without uploads' });
    await userEvent.click(noUpload);
    paste(noUpload, [file()]);
    drop(noUpload, [file()]);
    expect(text.calls).toHaveLength(0);
    expect(text.latest.current).toEqual(text.initial);
    expect(images(text.latest.current)).toHaveLength(0);
    expect(noUpload).toHaveTextContent('Plain');
    checked(text.latest.current);
  },
};
