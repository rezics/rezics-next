import {
  checkDocument,
  documentVersion,
  fromMarkdown,
  normalizeDocument,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { DocumentBody } from './document-body.tsx';
import { RichTextEditor } from './rich-text-editor.tsx';
import { placeEditorCaret, selectEditorText } from '../test/editor-selection.ts';

const initial = normalizeDocument({
  version: documentVersion,
  profile: 'text',
  doc: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'body' },
        content: [
          { type: 'text', text: '漢', marks: [{ type: 'bold' }] },
          { type: 'text', text: '字 outside' },
        ],
      },
      {
        type: 'footnoteDefinition',
        attrs: { id: 'existing-note', label: 'Source-1' },
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'existing-note-body' },
            content: [{ type: 'text', text: 'Existing rich source', marks: [{ type: 'italic' }] }],
          },
        ],
      },
    ],
  },
});

function demo(value = initial, readOnly = false) {
  const latest = { current: value };
  const submissions = { current: 0 };
  const host = { replace: () => {} };
  function Demo() {
    const [document, setDocument] = useState(value);
    host.replace = () => {
      const next = fromMarkdown('Replacement content');
      latest.current = next;
      setDocument(next);
    };
    return (
      <>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submissions.current++;
          }}
        >
          <RichTextEditor
            value={document}
            label="Annotated document"
            toolbar="always"
            readOnly={readOnly}
            onChange={(next) => {
              latest.current = next;
              setDocument(next);
            }}
          />
          <button type="submit">Save chapter</button>
        </form>
        <section aria-label="Reading preview">
          <DocumentBody document={document} />
        </section>
      </>
    );
  }
  return { Demo, latest, host, submissions };
}

function nodes(document: DocumentSnapshot, type: string): DocumentNode[] {
  const result: DocumentNode[] = [];
  const visit = (node: DocumentNode) => {
    if (node.type === type) result.push(node);
    node.content?.forEach(visit);
  };
  visit(document.doc);
  return result;
}

const annotations = demo();
const stale = demo();
const readOnly = demo(fromMarkdown('Read >!concealed text!< and note[^Source].\n\n[^Source]: Saved source'), true);
const meta = { title: 'Editor/Writing/Domain Annotations', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const DomainAnnotations: Story = {
  render: () => <annotations.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Annotated document' });
    await userEvent.click(canvas.getByText('More tools', { exact: true }));
    await selectEditorText(textbox, '漢字');
    await userEvent.click(canvas.getByRole('button', { name: 'Ruby annotation' }));
    let dialog = within(await screen.findByRole('dialog', { name: 'Ruby annotation' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reading' }), 'かんじ');
    await userEvent.type(dialog.getByRole('textbox', { name: 'Language tag' }), 'ja');
    await userEvent.click(dialog.getByRole('combobox', { name: 'Reading position' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Below' }));
    await userEvent.keyboard('{Enter}');
    expect(annotations.submissions.current).toBe(0);
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(nodes(annotations.latest.current, 'ruby')).toHaveLength(1));
    expect(nodes(annotations.latest.current, 'ruby')[0]).toMatchObject({
      attrs: { rt: 'かんじ', position: 'under', lang: 'ja' },
      content: [
        { type: 'text', text: '漢', marks: [{ type: 'bold' }] },
        { type: 'text', text: '字' },
      ],
    });

    await userEvent.click(textbox.querySelector('ruby [data-ruby-base]')!);
    await userEvent.click(canvas.getByRole('button', { name: 'Ruby annotation' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Ruby annotation' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Remove ruby annotation' }));
    await waitFor(() => expect(nodes(annotations.latest.current, 'ruby')).toHaveLength(0));
    await selectEditorText(textbox, '漢字');
    await userEvent.click(canvas.getByRole('button', { name: 'Language and direction' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Language and direction' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Language tag' }), 'zh-Hant-TW');
    await userEvent.click(dialog.getByRole('combobox', { name: 'Text direction' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Automatic' }));
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(annotations.latest.current.doc.content?.[0]?.content?.[0]?.marks).toContainEqual({
        type: 'language',
        attrs: { lang: 'zh-Hant-TW', dir: 'auto' },
      }),
    );
    await selectEditorText(textbox, 'outside');
    await userEvent.click(canvas.getByRole('button', { name: 'Spoiler' }));
    await waitFor(() =>
      expect(
        within(canvas.getByRole('region', { name: 'Reading preview' })).getByRole('button', { name: 'Reveal spoiler' }),
      ).toBeInTheDocument(),
    );

    await placeEditorCaret(textbox, textbox.querySelector('p')!);
    await userEvent.click(canvas.getByRole('button', { name: 'Footnote' }));
    dialog = within(await screen.findByRole('dialog', { name: 'Footnote' }));
    const label = dialog.getByRole('combobox', { name: 'Footnote label' });
    await userEvent.clear(label);
    await userEvent.type(label, 'Source-1');
    expect(dialog.getByText('This label reuses an existing footnote.')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(nodes(annotations.latest.current, 'footnoteReference')).toHaveLength(1));
    expect(nodes(annotations.latest.current, 'footnoteDefinition')).toHaveLength(1);
    expect(nodes(annotations.latest.current, 'footnoteDefinition')[0]!.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: 'italic' },
    ]);
    expect(annotations.latest.current.doc.content?.[0]?.attrs?.id).toBe('body');
    expect(checkDocument(annotations.latest.current)).toBe(true);
    expect(annotations.submissions.current).toBe(0);
  },
};

export const StaleAnnotationTarget: Story = {
  render: () => <stale.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Annotated document' });
    await userEvent.click(canvas.getByText('More tools', { exact: true }));
    await selectEditorText(textbox, '漢字');
    await userEvent.click(canvas.getByRole('button', { name: 'Ruby annotation' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Ruby annotation' }));
    await userEvent.type(dialog.getByRole('textbox', { name: 'Reading' }), 'stale draft');
    const apply = dialog.getByRole('button', { name: 'Apply' });
    stale.host.replace();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ruby annotation' })).toBeNull());
    apply.click();
    expect(stale.latest.current.doc.content?.[0]?.content?.[0]?.text).toBe('Replacement content');
    expect(nodes(stale.latest.current, 'ruby')).toHaveLength(0);
  },
};

export const ReadOnlyAnnotations: Story = {
  render: () => <readOnly.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    expect(canvas.getByRole('textbox', { name: 'Annotated document' })).toHaveAttribute('contenteditable', 'false');
    expect(canvas.queryByRole('button', { name: 'Ruby annotation' })).toBeNull();
    expect(canvas.queryByRole('button', { name: /^Block actions\b/ })).toBeNull();
    const preview = within(canvas.getByRole('region', { name: 'Reading preview' }));
    await userEvent.click(preview.getByRole('button', { name: 'Reveal spoiler' }));
    const disclosure = preview.getByText('Footnote Source');
    expect(preview.getByRole('link', { name: 'Go to footnote Source' })).toHaveAttribute('href', `#${disclosure.id}`);
    await userEvent.click(disclosure);
    await waitFor(() => expect(preview.getByText('Saved source')).toBeVisible());
    expect(checkDocument(readOnly.latest.current)).toBe(true);
  },
};
