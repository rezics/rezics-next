import {
  documentVersion,
  normalizeDocument,
  fromPlainText,
  checkDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Editor } from '@tiptap/core';
import { useCallback, useState } from 'react';
import { flushSync } from 'react-dom';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';
import { DocumentBody } from './document-body.tsx';
import type { DocumentImageRenderer } from './document-media.tsx';
import { editorMediaRuntime } from './editor-media-runtime.ts';

const asset = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="#426a93"/><circle cx="175" cy="38" r="18" fill="#e2b875"/><path d="M0 120L70 35L140 120L180 80L240 120" fill="#264831"/></svg>')}`;
const payload = { data: [{ value: '漢字', future: [null, false, 4] }], unknown: { retained: '<literal>' } };
const initial = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'body' },
        content: [
          { type: 'text', text: 'Before ' },
          {
            type: 'extensionInline',
            attrs: { id: 'inline', definition: 'example.inline', version: '3', payload, fallback: 'Inline widget' },
          },
          { type: 'text', text: ' after' },
        ],
      },
      {
        type: 'image',
        attrs: {
          id: 'first-image',
          src: 'admitted-fixture',
          alt: 'Visible landscape',
          title: 'Original title',
          width: 120,
          height: 60,
        },
      },
      {
        type: 'image',
        attrs: {
          id: 'second-image',
          src: 'admitted-fixture',
          alt: 'Concealed landscape',
          width: 240,
          height: 120,
          conceal: true,
        },
      },
      { type: 'media', attrs: { id: 'clip', src: 'unavailable-clip', kind: 'audio', caption: 'An audio caption' } },
      {
        type: 'extensionBlock',
        attrs: {
          id: 'block',
          definition: 'example.chart',
          version: '7-beta',
          payload,
          fallback: 'Saved chart fallback',
        },
      },
    ],
  },
});

function nodes(snapshot: DocumentSnapshot, type: string): DocumentNode[] {
  const found: DocumentNode[] = [];
  const visit = (node: DocumentNode) => {
    if (node.type === type) found.push(node);
    node.content?.forEach(visit);
  };
  visit(snapshot.doc);
  return found;
}
function unique(snapshot: DocumentSnapshot) {
  const ids: unknown[] = [];
  const visit = (node: DocumentNode) => {
    if (node.attrs?.id) ids.push(node.attrs.id);
    node.content?.forEach(visit);
  };
  visit(snapshot.doc);
  expect(new Set(ids).size).toBe(ids.length);
  expect(checkDocument(snapshot)).toBe(true);
}
function demo(readOnly = false) {
  const latest = { current: initial };
  const controls = { retire: () => {}, renderer: () => {} };
  function Demo() {
    const [document, setDocument] = useState(initial);
    latest.current = document;
    const [saves, setSaves] = useState(0);
    const [visit, setVisit] = useState(0);
    const [revision, setRevision] = useState(0);
    controls.retire = () => setVisit((value) => value + 1);
    controls.renderer = () => setRevision((value) => value + 1);
    const renderImage: DocumentImageRenderer = useCallback(
      (image) => (
        <img
          data-renderer-version={revision}
          src={asset}
          alt={image.alt}
          title={image.title ?? undefined}
          width={image.width ?? undefined}
          height={image.height ?? undefined}
          style={{ width: image.width ?? undefined, height: image.height ?? undefined }}
        />
      ),
      [revision],
    );
    return (
      <>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaves((count) => count + 1);
          }}
        >
          <RichTextEditor
            label="Media document"
            value={document}
            toolbar="always"
            readOnly={readOnly}
            mediaVisitKey={visit}
            renderImage={renderImage}
            onChange={(next) => {
              latest.current = next;
              setDocument(next);
            }}
          />
          <button type="submit">Save chapter</button>
        </form>
        <output aria-label="Saved chapters">{saves}</output>
        <section aria-label="Reading preview">
          <DocumentBody document={document} renderImage={renderImage} visitKey={String(visit)} />
        </section>
      </>
    );
  }
  return { Demo, latest, controls };
}
const properties = demo();
const retirement = demo();
const readonly = demo(true);
const meta = { title: 'Editor/Writing/Media and Opaque Content', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ImageProperties: Story = {
  render: () => <properties.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Media document' });
    const image = await within(textbox).findByRole('img', { name: 'Visible landscape' });
    await waitFor(() => expect((image as HTMLImageElement).naturalWidth).toBeGreaterThan(0));
    expect(within(textbox).queryByRole('img', { name: 'Concealed landscape' })).toBeNull();
    expect(within(textbox).getByText('Saved chart fallback')).toBeVisible();
    expect(within(textbox).getByText('Inline widget')).toBeVisible();
    expect(within(textbox).getByText('An audio caption')).toBeVisible();
    expect(within(textbox).getByText('Media unavailable')).toBeVisible();
    const occurrence = within(textbox.querySelector<HTMLElement>('[data-id="first-image"]')!);
    await userEvent.click(occurrence.getByRole('button', { name: 'Image properties' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Image properties' }));
    await userEvent.clear(dialog.getByRole('textbox', { name: 'Alt text' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Alt text' }), 'Edited landscape');
    await userEvent.clear(dialog.getByRole('textbox', { name: 'Title' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Title' }), 'Authored title');
    await userEvent.clear(dialog.getByRole('spinbutton', { name: 'Width (px)' }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: 'Width (px)' }), '200');
    await userEvent.clear(dialog.getByRole('spinbutton', { name: 'Height (px)' }));
    await userEvent.type(dialog.getByRole('spinbutton', { name: 'Height (px)' }), '70');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(nodes(properties.latest.current, 'image')[0]!.attrs).toMatchObject({
        id: 'first-image',
        src: 'admitted-fixture',
        alt: 'Edited landscape',
        title: 'Authored title',
        width: 200,
        height: 70,
      }),
    );
    expect(canvas.getByRole('status', { name: 'Saved chapters' })).toHaveTextContent('0');
    const edited = within(textbox).getByRole('img', { name: 'Edited landscape' });
    expect(edited).toHaveAttribute('width', '200');
    expect(edited).toHaveAttribute('height', '70');
    expect(edited).toHaveAttribute('title', 'Authored title');
    await waitFor(() => {
      expect((edited as HTMLImageElement).naturalWidth).toBeGreaterThan(0);
      expect(edited.getBoundingClientRect().width).toBeCloseTo(200, 1);
      expect(edited.getBoundingClientRect().height).toBeCloseTo(70, 1);
    });
    const readingImage = await within(canvas.getByRole('region', { name: 'Reading preview' })).findByRole('img', {
      name: 'Edited landscape',
    });
    await waitFor(() => {
      expect((readingImage as HTMLImageElement).naturalWidth).toBeGreaterThan(0);
      expect(readingImage.getBoundingClientRect().width).toBeCloseTo(200, 1);
      expect(readingImage.getBoundingClientRect().height).toBeCloseTo(70, 1);
    });
    await userEvent.click(within(textbox).getByRole('button', { name: 'Reveal image — Concealed landscape' }));
    expect(await within(textbox).findByRole('img', { name: 'Concealed landscape' })).toHaveAttribute('width', '240');
    expect(
      within(canvas.getByRole('region', { name: 'Reading preview' })).queryByRole('img', {
        name: 'Concealed landscape',
      }),
    ).toBeNull();
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    properties.controls.renderer();
    await waitFor(() =>
      expect(within(textbox).getByRole('img', { name: 'Edited landscape' })).toHaveAttribute(
        'data-renderer-version',
        '1',
      ),
    );
    expect((textbox as HTMLElement & { editor: Editor }).editor).toBe(editor);
    unique(properties.latest.current);
  },
};

export const MediaVisitRetirement: Story = {
  render: () => <retirement.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Media document' });
    await userEvent.click(
      within(textbox.querySelector<HTMLElement>('[data-id="first-image"]')!).getByRole('button', {
        name: 'Image properties',
      }),
    );
    const dialog = within(await screen.findByRole('dialog', { name: 'Image properties' }));
    await userEvent.clear(dialog.getByRole('textbox', { name: 'Alt text' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Alt text' }), 'Retired draft');
    const staleApply = dialog.getByRole('button', { name: 'Apply' });
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    const generation = editorMediaRuntime(editor).generation;
    flushSync(() => retirement.controls.retire());
    await waitFor(() => expect(editorMediaRuntime(editor).generation).toBeGreaterThan(generation));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Image properties' })).toBeNull());
    staleApply.click();
    expect(nodes(retirement.latest.current, 'image')[0]!.attrs!.alt).toBe('Visible landscape');
    expect((textbox as HTMLElement & { editor: Editor }).editor).toBe(editor);
    expect(canvas.getByRole('status', { name: 'Saved chapters' })).toHaveTextContent('0');
  },
};

export const ReadOnlyMedia: Story = {
  render: () => <readonly.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Media document' });
    expect(textbox).toHaveAttribute('contenteditable', 'false');
    expect(within(textbox).queryByRole('button', { name: 'Image properties' })).toBeNull();
    expect(within(textbox).getByRole('img', { name: 'Visible landscape' })).toBeVisible();
    await userEvent.click(within(textbox).getByRole('button', { name: 'Reveal image — Concealed landscape' }));
    expect(await within(textbox).findByRole('img', { name: 'Concealed landscape' })).toBeVisible();
  },
};

const clipboardInitial = fromPlainText('', 'blocks');
const clipboard = { pasted: clipboardInitial };
function ClipboardDemo() {
  const [value, setValue] = useState(clipboardInitial);
  clipboard.pasted = value;
  return (
    <>
      <RichTextEditor value={initial} label="Copy source" onChange={() => undefined} />
      <RichTextEditor
        value={value}
        label="Paste destination"
        onChange={(next) => {
          clipboard.pasted = next;
          setValue(next);
        }}
      />
    </>
  );
}
export const OpaqueClipboard: Story = {
  render: () => <ClipboardDemo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const source = canvas.getByRole('textbox', { name: 'Copy source' });
    await userEvent.click(source);
    await userEvent.keyboard('{Control>}a{/Control}');
    const transfer = new DataTransfer();
    source.dispatchEvent(new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }));
    expect(transfer.getData('text/html')).toContain('data-document-component-payload');
    expect(transfer.getData('text/plain')).toContain('Inline widget');
    expect(transfer.getData('text/plain')).toContain('Saved chart fallback');
    const target = canvas.getByRole('textbox', { name: 'Paste destination' });
    await userEvent.click(target);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    await waitFor(() => expect(nodes(clipboard.pasted, 'extensionBlock')).toHaveLength(1));
    for (const type of ['extensionBlock', 'extensionInline']) {
      const original = nodes(initial, type)[0]!;
      const copied = nodes(clipboard.pasted, type)[0]!;
      expect(copied.attrs).toMatchObject({
        definition: original.attrs!.definition,
        version: original.attrs!.version,
        payload,
        fallback: original.attrs!.fallback,
      });
    }
    unique(clipboard.pasted);
    const editor = (target as HTMLElement & { editor: Editor }).editor;
    const before = editor.state.doc;
    const malformed = new DataTransfer();
    malformed.setData(
      'text/html',
      '<div data-document-component="example.missing-payload">Fallback must not replace the component</div>',
    );
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: malformed, bubbles: true, cancelable: true }));
    expect(editor.state.doc).toBe(before);
    await canvas.findByRole('alert');
  },
};
