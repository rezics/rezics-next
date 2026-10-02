import { fromPlainText, normalizeDocument, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, userEvent, within } from 'storybook/test';
import { dismissed, settled } from '../stories/support.tsx';
import { Button } from './button.tsx';
import { DocumentBody } from './document-body.tsx';
import { RichTextEditor } from './rich-text-editor.tsx';

const richDocument = normalizeDocument({ version: 'rezics-document-v1', profile: 'blocks', doc: withDocumentIds({ type: 'doc', content: [
  { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '雨夜 — a working manuscript' }] },
  { type: 'paragraph', content: [{ type: 'ruby', attrs: { rt: 'ㄏㄢˋ', position: 'inter-character' }, content: [{ type: 'text', text: '漢' }] },
    { type: 'text', text: '字與 ', marks: [{ type: 'textEmphasis', attrs: { shape: 'sesame', fill: 'filled', position: 'under' } }] },
    { type: 'text', text: 'mixed scripts', marks: [{ type: 'bold' }] }, { type: 'text', text: ' in one document.' }] },
  { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep nested structure and stable identities.' }] }] }] },
  { type: 'table', content: [
    { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Chapter' }] }] }, { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] }] },
    { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '雨夜' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Draft' }] }] }] },
  ] },
  { type: 'extensionBlock', attrs: { definition: 'https://example.test/components/timeline', version: '1', payload: { format: 'EDTF', date: '2026-10-02', items: [1, 2] }, fallback: 'Timeline: 2 October 2026' } },
] }) });

function Example({ initial = richDocument, readOnly = false, compact = false, contextual = false }: { initial?: DocumentSnapshot; readOnly?: boolean; compact?: boolean; contextual?: boolean }) {
  const [value, setValue] = useState(initial);
  const [changes, setChanges] = useState(0);
  return <div className="mx-auto flex max-w-4xl flex-col gap-6">
    <RichTextEditor label="Document" lang="zh-Hant" value={value} placeholder="Start writing…" readOnly={readOnly} compact={compact} toolbarMode={contextual ? 'contextual' : 'full'}
      onChange={next => { setValue(next); setChanges(count => count + 1); }} />
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><output aria-label="Changes">{changes}</output> changes
      <Button variant="outline" size="sm" onClick={() => setValue(fromPlainText('Restored document.', initial.profile))}>Restore document</Button>
    </div>
    <output aria-label="Document JSON" hidden>{JSON.stringify(value)}</output>
    <div aria-label="Reading preview"><DocumentBody document={value} /></div>
  </div>;
}

const meta = {
  title: 'Rezics UI/Rich Text Editor', component: RichTextEditor, tags: ['autodocs'],
  args: { value: richDocument, label: 'Document', onChange: () => {} },
  decorators: [Story => <div className="min-h-96 bg-background p-4 text-foreground sm:p-6"><Story /></div>],
  render: () => <Example />,
} satisfies Meta<typeof RichTextEditor>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Document: Story = {
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await expect(canvas.getByRole('status', { name: 'Changes' })).toHaveTextContent('0');
    await userEvent.click(editor);
    const range = document.createRange();
    range.selectNodeContents(editor.querySelector('h2') ?? editor); range.collapse(true);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    await userEvent.type(editor, 'Preface ', { skipClick: true });
    await expect(canvas.queryByRole('alert')).toBeNull();
    await expect(Number(canvas.getByLabelText('Changes').textContent)).toBeGreaterThan(0);
    const savedDocument = JSON.parse(canvas.getByLabelText('Document JSON').textContent ?? '{}') as DocumentSnapshot;
    const embedded = savedDocument.doc.content?.find(node => node.type === 'extensionBlock');
    await expect(embedded?.attrs?.payload).toEqual({ format: 'EDTF', date: '2026-10-02', items: [1, 2] });
    await expect(within(canvas.getByLabelText('Reading preview')).getByText('ㄏㄢˋ')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Restore document' }));
    await expect(editor).toHaveTextContent('Restored document.');
  },
};

export const FormattingAndTables: Story = {
  render: () => <Example initial={fromPlainText('Hello', 'blocks')} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    await userEvent.keyboard('{Control>}a{/Control}');
    const toolbar = within(canvasElement.querySelector('[data-slot="editor-toolbar"]') as HTMLElement);
    await userEvent.click(toolbar.getByRole('button', { name: 'Bold' }));
    await expect(editor.querySelector('strong')).toHaveTextContent('Hello');
    const range = document.createRange();
    range.selectNodeContents(editor); range.collapse(false);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    await userEvent.click(canvas.getByRole('button', { name: 'Insert table' }));
    await expect(editor.querySelectorAll('table tr')).toHaveLength(3);
    await userEvent.click(canvas.getByRole('button', { name: 'Add row' }));
    await expect(editor.querySelectorAll('table tr')).toHaveLength(4);
    await userEvent.click(canvas.getByRole('button', { name: 'Delete table' }));
    await expect(editor.querySelector('table')).toBeNull();
  },
};

export const RubyAndLink: Story = {
  render: () => <Example initial={fromPlainText('', 'text')} compact />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    await userEvent.click(canvas.getByRole('button', { name: 'Ruby annotation' }));
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole('dialog', { name: 'Ruby annotation' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Base text' }), '漢');
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Pronunciation' }), 'ㄏㄢˋ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await expect(editor.querySelector('ruby rt')).toHaveTextContent('ㄏㄢˋ');
    await userEvent.click(canvas.getByRole('button', { name: 'Link' }));
    const linkDialog = await page.findByRole('dialog', { name: 'Link' });
    await userEvent.type(within(linkDialog).getByRole('textbox', { name: 'URL' }), 'javascript:alert(1)');
    await userEvent.click(within(linkDialog).getByRole('button', { name: 'Apply' }));
    await expect(within(linkDialog).getByRole('alert')).toBeInTheDocument();
    await userEvent.click(within(linkDialog).getByRole('button', { name: 'Cancel' }));
  },
};

export const ReadOnly: Story = {
  render: () => <Example readOnly />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await expect(canvas.queryByRole('group', { name: 'Text formatting' })).toBeNull();
    await expect(canvas.getByLabelText('Changes')).toHaveTextContent('0');
  },
};

export const Phone: Story = {
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    await within(canvasElement).findByRole('textbox', { name: 'Document' });
    await expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  },
};
export const Dark: Story = { globals: { theme: 'dark' } };
export const RightToLeft: Story = {
  render: () => <RichTextEditor label="Arabic document" value={fromPlainText('بدأ المطر عند الغروب.', 'text')} onChange={() => {}} lang="ar" dir="rtl" />,
};

export const ContextualForum: Story = {
  render: () => <Example initial={fromPlainText('A reply with formatting.', 'blocks')} compact contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await expect(canvasElement.querySelector('[data-slot="editor-toolbar"]')).toBeNull();
    await userEvent.click(editor);
    await userEvent.keyboard('{Control>}a{/Control}');
    const menu = await canvas.findByRole('group', { name: 'Text formatting' });
    await userEvent.click(within(menu).getByRole('button', { name: 'Bold' }));
    await expect(editor.querySelector('strong')).toHaveTextContent('A reply with formatting.');
    const bounds = menu.getBoundingClientRect();
    await expect(bounds.left).toBeGreaterThanOrEqual(0);
    await expect(bounds.top).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const ContextMenuFormatting: Story = {
  render: () => <Example initial={fromPlainText('Preserve this selection.', 'text')} compact contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    await userEvent.keyboard('{Control>}a{/Control}');
    const { left, top, width, height } = editor.getBoundingClientRect();
    await fireEvent.contextMenu(editor, { clientX: left + width / 2, clientY: top + height / 2 });
    const page = within(canvasElement.ownerDocument.body);
    const menu = await page.findByRole('menu', { name: 'Format text' });
    await userEvent.click(within(menu).getByRole('menuitemcheckbox', { name: 'Italic' }));
    await expect(editor.querySelector('em')).toHaveTextContent('Preserve this selection.');
    await dismissed('menu');
    await userEvent.click(canvas.getByRole('button', { name: 'Format text' }));
    await expect(await settled(await page.findByRole('menu', { name: 'Format text' }))).toBeVisible();
    await userEvent.keyboard('{Escape}');
    await dismissed('menu');
    await userEvent.click(editor);
    await userEvent.keyboard('{Alt>}{F10}{/Alt}');
    await expect(await settled(await page.findByRole('menu', { name: 'Format text' }))).toBeVisible();
    await userEvent.keyboard('{Escape}');
  },
};

export const ContextualPhone: Story = {
  ...ContextualForum,
  globals: { viewport: { value: 'phone' } },
};

export const Spoilers: Story = {
  render: () => <DocumentBody document={normalizeDocument({ version: 'rezics-document-v1', profile: 'text', doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The answer is ' }, { type: 'text', text: 'hidden until requested', marks: [{ type: 'spoiler' }] }] },
  ] }) })} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText('hidden until requested')).toBeNull();
    await userEvent.click(canvas.getByRole('button', { name: 'Reveal spoiler' }));
    await expect(canvas.getByText('hidden until requested')).toBeInTheDocument();
  },
};
