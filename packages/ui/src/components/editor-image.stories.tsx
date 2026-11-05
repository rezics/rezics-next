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
const altText = demo();
const pasted = demo('blocks', true);
const dropped = demo('blocks', true);
const failure = demo('blocks', true);
const text = demo('text');

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

type DeferredUpload = {
  file: File;
  signal: AbortSignal;
  uploaderToken: symbol;
  resolve: (image: UploadedImage) => void;
  reject: () => void;
};

const uploadLifetime = {
  initial: fromPlainText('Before after', 'blocks'),
  value: { current: fromPlainText('Before after', 'blocks') },
  calls: [] as DeferredUpload[],
  changes: [] as DocumentSnapshot[],
  states: [] as { state: UploadState; count: number }[],
  reset() {
    this.value.current = this.initial;
    this.calls.length = 0;
    this.changes.length = 0;
    this.states.length = 0;
  },
};

function UploadLifetimeDemo() {
  const [value, setValue] = useState(uploadLifetime.initial);
  const [uploadState, setUploadState] = useState<UploadState>('ready');
  const [disabled, setDisabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [shown, setShown] = useState(true);
  const uploaderToken = Symbol('render upload callback');
  uploadLifetime.value.current = value;

  const upload: ImageUploader = (file, signal) =>
    new Promise((resolve, reject) => {
      uploadLifetime.calls.push({
        file,
        signal,
        uploaderToken,
        resolve,
        reject: () => reject(new Error('Offline')),
      });
    });
  const onChange = (next: DocumentSnapshot) => {
    uploadLifetime.changes.push(next);
    const echo: DocumentSnapshot = {
      ...next,
      doc: { ...next.doc, content: [...(next.doc.content ?? [])] },
    };
    uploadLifetime.value.current = echo;
    setValue(echo);
  };
  const onUploadState = (state: UploadState, count: number) => {
    uploadLifetime.states.push({ state, count });
    setUploadState(state);
  };

  return (
    <div className="space-y-3">
      {shown ? (
        <RichTextEditor
          compact
          value={value}
          label="Lifetime post"
          disabled={disabled}
          readOnly={readOnly}
          toolbar="never"
          upload={(file, signal) => upload(file, signal)}
          onChange={onChange}
          onUploadState={onUploadState}
          actions={
            <Button type="button" disabled={uploadState !== 'ready'}>
              Send
            </Button>
          }
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => setDisabled((current) => !current)}>
          {disabled ? 'Enable editor' : 'Disable editor'}
        </Button>
        <Button type="button" onClick={() => setReadOnly((current) => !current)}>
          {readOnly ? 'Allow editing' : 'Make read only'}
        </Button>
        <Button type="button" onClick={() => setValue(fromPlainText('Replacement', 'blocks'))}>
          Replace document
        </Button>
        <Button type="button" onClick={() => setValue(fromPlainText('Text profile', 'text'))}>
          Use text profile
        </Button>
        <Button type="button" onClick={() => setValue(fromPlainText('Fresh blocks', 'blocks'))}>
          Use blocks profile
        </Button>
        <Button type="button" onClick={() => setShown((current) => !current)}>
          {shown ? 'Remove editor' : 'Restore editor'}
        </Button>
      </div>
    </div>
  );
}

async function lifetimeCaret(canvasElement: HTMLElement, offset = 7) {
  const textbox = within(canvasElement).getByRole('textbox', { name: 'Lifetime post' });
  await userEvent.click(textbox);
  const text = textbox.querySelector('p')?.firstChild;
  if (text?.nodeType === Node.TEXT_NODE) {
    window.getSelection()?.collapse(text, Math.min(offset, text.textContent?.length ?? 0));
    document.dispatchEvent(new Event('selectionchange'));
  }
  return textbox;
}

async function chooseLifetimeFile(canvasElement: HTMLElement, name: string, alt: string, slash = false) {
  const canvas = within(canvasElement);
  let textbox = await lifetimeCaret(canvasElement, slash ? Number.MAX_SAFE_INTEGER : 7);
  if (slash) {
    await userEvent.type(textbox, '/i');
    await canvas.findByRole('option', { name: 'Image' });
    await userEvent.keyboard('{Enter}');
  } else {
    await userEvent.click(canvas.getByRole('button', { name: 'Image' }));
  }
  const panel = within(await canvas.findByRole('dialog', { name: 'Image' }));
  await userEvent.upload(panel.getByLabelText('Choose image file'), file(name));
  if (alt) await userEvent.type(panel.getByRole('textbox', { name: 'Alt text' }), alt);
  await userEvent.click(panel.getByRole('button', { name: 'Insert image' }));
  textbox = await lifetimeCaret(canvasElement);
  return textbox;
}

async function settleStoryMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export const UploadImage: Story = {
  render: () => <UploadLifetimeDemo />,
  async play({ canvasElement }) {
    uploadLifetime.reset();
    const canvas = within(canvasElement);

    await lifetimeCaret(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Image' }));
    await canvas.findByRole('dialog', { name: 'Image' });
    await userEvent.click(canvas.getByRole('button', { name: 'Disable editor' }));
    expect(canvas.queryByRole('dialog', { name: 'Image' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Enable editor' }));
    await lifetimeCaret(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Image' }));
    await canvas.findByRole('dialog', { name: 'Image' });
    await userEvent.click(canvas.getByRole('button', { name: 'Make read only' }));
    expect(canvas.queryByRole('dialog', { name: 'Image' })).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Allow editing' }));

    let textbox = await chooseLifetimeFile(canvasElement, 'button.png', 'Button description');
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(1));
    expect(canvas.getByRole('status', { name: 'Uploading image' })).toHaveTextContent('button.png');
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(uploadLifetime.calls[0]!.file.name).toBe('button.png');
    expect(uploadLifetime.calls[0]!.signal.aborted).toBe(false);
    expect(images(uploadLifetime.value.current)).toHaveLength(0);
    await lifetimeCaret(canvasElement, 0);
    await userEvent.keyboard('New ');
    await waitFor(() => expect(uploadLifetime.changes.length).toBeGreaterThan(0));
    expect(uploadLifetime.calls[0]!.signal.aborted).toBe(false);
    expect(checked(uploadLifetime.value.current)[0]?.content?.[0]?.text).toBe('New Before after');
    const changesBeforeButtonImage = uploadLifetime.changes.length;
    uploadLifetime.calls[0]!.resolve({ src: 'opaque-button', width: 640, height: 480 });
    await canvas.findByRole('img', { name: 'Button description' });
    await waitFor(() => expect(uploadLifetime.changes).toHaveLength(changesBeforeButtonImage + 1));
    expect(images(uploadLifetime.value.current)[0]?.attrs).toMatchObject({
      src: 'opaque-button',
      alt: 'Button description',
      width: 640,
      height: 480,
    });
    expect(uploadLifetime.states.slice(0, 2)).toEqual([
      { state: 'pending', count: 1 },
      { state: 'ready', count: 0 },
    ]);

    textbox = await chooseLifetimeFile(canvasElement, 'slash.png', 'Slash description', true);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(2));
    uploadLifetime.calls[1]!.resolve({ src: 'opaque-slash' });
    await canvas.findByRole('img', { name: 'Slash description' });

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('paste.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(3));
    uploadLifetime.calls[2]!.resolve({ src: 'opaque-paste' });
    await canvas.findByRole('img', { name: 'Image' });

    textbox = await lifetimeCaret(canvasElement, 0);
    drop(textbox, [file('drop.png')], 0);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(4));
    uploadLifetime.calls[3]!.resolve({ src: 'opaque-drop' });
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(4));

    paste(await lifetimeCaret(canvasElement, 0), [file('unsafe.svg', 'image/svg+xml')]);
    expect(await canvas.findByRole('status', { name: 'Image' })).toHaveTextContent(
      'Choose a PNG, JPEG, WebP, GIF or AVIF image.',
    );
    expect(uploadLifetime.calls).toHaveLength(4);

    await userEvent.click(canvas.getByRole('button', { name: 'Replace document' }));
    await waitFor(() => expect(uploadLifetime.value.current.doc.content?.[0]?.content?.[0]?.text).toBe('Replacement'));
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(
      textbox,
      Array.from({ length: 33 }, (_, index) => file(`batch-${index}.png`)),
    );
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(36));
    expect(uploadLifetime.calls.slice(4)).toHaveLength(32);
    expect(uploadLifetime.states.at(-1)).toEqual({ state: 'pending', count: 32 });
    expect(await canvas.findByRole('status', { name: 'Image' })).toHaveTextContent(
      'A post can contain up to 32 media files.',
    );
    uploadLifetime.calls.slice(4).forEach((call, index) => call.resolve({ src: `opaque-batch-${index}` }));
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(32));
    expect(uploadLifetime.states.at(-1)).toEqual({ state: 'ready', count: 0 });

    await userEvent.click(canvas.getByRole('button', { name: 'Replace document' }));
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('invalid-dimension.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(37));
    uploadLifetime.calls[36]!.resolve({ src: 'opaque-invalid-dimension', width: 0 });
    await canvas.findByRole('alert', { name: 'Image upload failed' });
    expect(uploadLifetime.states.at(-1)).toEqual({ state: 'failed', count: 0 });
    await userEvent.click(canvas.getByRole('button', { name: 'Retry upload' }));
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(38));
    expect(uploadLifetime.calls[37]!.file).toBe(uploadLifetime.calls[36]!.file);
    expect(uploadLifetime.calls[37]!.uploaderToken).toBe(uploadLifetime.calls[36]!.uploaderToken);
    uploadLifetime.calls[37]!.resolve({ src: 'opaque-retried', width: 20, height: 10 });
    await canvas.findByRole('img', { name: 'Image' });

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('dismiss.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(39));
    const beforeDismiss = uploadLifetime.value.current;
    uploadLifetime.calls[38]!.reject();
    await canvas.findByRole('alert', { name: 'Image upload failed' });
    await userEvent.click(canvas.getByRole('button', { name: 'Dismiss upload' }));
    expect(uploadLifetime.value.current).toEqual(beforeDismiss);
    expect(canvas.getByRole('button', { name: 'Send' })).toBeEnabled();

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('retired-success.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(40));
    const retiredSuccess = uploadLifetime.calls[39]!;
    const changesBeforeReplacement = uploadLifetime.changes.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Replace document' }));
    await waitFor(() => expect(uploadLifetime.value.current.doc.content?.[0]?.content?.[0]?.text).toBe('Replacement'));
    expect(retiredSuccess.signal.aborted).toBe(true);
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('fresh-replacement.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(41));
    const freshReplacement = uploadLifetime.calls[40]!;
    const replacementValue = uploadLifetime.value.current;
    const replacementStates = [...uploadLifetime.states];
    retiredSuccess.resolve({ src: 'late-replacement-success' });
    await settleStoryMicrotasks();
    expect(uploadLifetime.value.current).toBe(replacementValue);
    expect(uploadLifetime.changes).toHaveLength(changesBeforeReplacement);
    expect(uploadLifetime.states).toEqual(replacementStates);
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    freshReplacement.resolve({ src: 'opaque-fresh-replacement' });
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(1));

    await userEvent.click(canvas.getByRole('button', { name: 'Disable editor' }));
    const callsBeforeDisabledPaste = uploadLifetime.calls.length;
    paste(canvas.getByRole('textbox', { name: 'Lifetime post' }), [file('disabled-before-entry.png')]);
    expect(uploadLifetime.calls).toHaveLength(callsBeforeDisabledPaste);
    await userEvent.click(canvas.getByRole('button', { name: 'Enable editor' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Make read only' }));
    const callsBeforeReadOnlyPaste = uploadLifetime.calls.length;
    paste(canvas.getByRole('textbox', { name: 'Lifetime post' }), [file('readonly-before-entry.png')]);
    expect(uploadLifetime.calls).toHaveLength(callsBeforeReadOnlyPaste);
    await userEvent.click(canvas.getByRole('button', { name: 'Allow editing' }));

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('disabled-before-completion.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(42));
    const disabledCompletion = uploadLifetime.calls[41]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Disable editor' }));
    expect(disabledCompletion.signal.aborted).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: 'Enable editor' }));
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('fresh-after-disabled.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(43));
    const freshAfterDisabled = uploadLifetime.calls[42]!;
    const disabledStates = [...uploadLifetime.states];
    const disabledValue = uploadLifetime.value.current;
    const disabledChanges = uploadLifetime.changes.length;
    disabledCompletion.reject();
    await settleStoryMicrotasks();
    expect(uploadLifetime.value.current).toBe(disabledValue);
    expect(uploadLifetime.changes).toHaveLength(disabledChanges);
    expect(uploadLifetime.states).toEqual(disabledStates);
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    freshAfterDisabled.resolve({ src: 'opaque-fresh-after-disabled' });
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(2));

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('readonly-before-completion.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(44));
    const readOnlyCompletion = uploadLifetime.calls[43]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Make read only' }));
    expect(readOnlyCompletion.signal.aborted).toBe(true);
    await userEvent.click(canvas.getByRole('button', { name: 'Allow editing' }));
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('fresh-after-readonly.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(45));
    const freshAfterReadOnly = uploadLifetime.calls[44]!;
    const readOnlyStates = [...uploadLifetime.states];
    const readOnlyValue = uploadLifetime.value.current;
    const readOnlyChanges = uploadLifetime.changes.length;
    readOnlyCompletion.resolve({ src: 'late-readonly-success' });
    await settleStoryMicrotasks();
    expect(uploadLifetime.value.current).toBe(readOnlyValue);
    expect(uploadLifetime.changes).toHaveLength(readOnlyChanges);
    expect(uploadLifetime.states).toEqual(readOnlyStates);
    expect(canvas.getByRole('button', { name: 'Send' })).toBeDisabled();
    freshAfterReadOnly.resolve({ src: 'opaque-fresh-after-readonly' });
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(3));

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('profile-retired.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(46));
    const profileRetired = uploadLifetime.calls[45]!;
    const profileChanges = uploadLifetime.changes.length;
    await userEvent.click(canvas.getByRole('button', { name: 'Use text profile' }));
    await waitFor(() =>
      expect(canvas.getByRole('textbox', { name: 'Lifetime post' })).toHaveTextContent('Text profile'),
    );
    expect(profileRetired.signal.aborted).toBe(true);
    const profileValue = uploadLifetime.value.current;
    const profileStates = [...uploadLifetime.states];
    profileRetired.resolve({ src: 'late-profile-success' });
    await settleStoryMicrotasks();
    expect(uploadLifetime.value.current).toBe(profileValue);
    expect(uploadLifetime.changes).toHaveLength(profileChanges);
    expect(uploadLifetime.states).toEqual(profileStates);
    expect(images(uploadLifetime.value.current)).toHaveLength(0);

    await userEvent.click(canvas.getByRole('button', { name: 'Use blocks profile' }));
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Image' })).toBeInTheDocument());
    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('fresh-profile.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(47));
    uploadLifetime.calls[46]!.resolve({ src: 'opaque-fresh-profile' });
    await waitFor(() => expect(images(uploadLifetime.value.current)).toHaveLength(1));

    textbox = await lifetimeCaret(canvasElement, 0);
    paste(textbox, [file('unmounted.png')]);
    await waitFor(() => expect(uploadLifetime.calls).toHaveLength(48));
    const unmounted = uploadLifetime.calls[47]!;
    await userEvent.click(canvas.getByRole('button', { name: 'Remove editor' }));
    expect(unmounted.signal.aborted).toBe(true);
    const unmountedValue = uploadLifetime.value.current;
    const unmountedChanges = uploadLifetime.changes.length;
    const unmountedStates = [...uploadLifetime.states];
    unmounted.resolve({ src: 'late-unmounted-success' });
    await settleStoryMicrotasks();
    expect(uploadLifetime.value.current).toBe(unmountedValue);
    expect(uploadLifetime.changes).toHaveLength(unmountedChanges);
    expect(uploadLifetime.states).toEqual(unmountedStates);
    checked(uploadLifetime.value.current);
  },
};
