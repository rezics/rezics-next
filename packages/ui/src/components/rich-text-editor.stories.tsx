import { fromPlainText, normalizeDocument, withDocumentIds, type DocumentSnapshot } from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fireEvent, userEvent, waitFor, within } from 'storybook/test';
import { Button } from './button.tsx';
import { DocumentBody } from './document-body.tsx';
import type { ImageUploader } from './editor-image.tsx';
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

function Example({ initial = richDocument, readOnly = false, compact = false, contextual = false, pointerMode = 'fine', preview = true, upload }: { initial?: DocumentSnapshot; readOnly?: boolean; compact?: boolean; contextual?: boolean; pointerMode?: 'fine' | 'coarse'; preview?: boolean; upload?: ImageUploader }) {
  const [value, setValue] = useState(initial);
  const [changes, setChanges] = useState(0);
  return <div className="mx-auto flex max-w-4xl flex-col gap-6">
    <RichTextEditor label="Document" lang="zh-Hant" value={value} placeholder="Start writing…" readOnly={readOnly} compact={compact} toolbarMode={contextual ? 'contextual' : 'full'} pointerMode={pointerMode} onUploadImage={upload}
      onChange={next => { setValue(next); setChanges(count => count + 1); }} />
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><output aria-label="Changes">{changes}</output> changes
      <Button variant="outline" size="sm" onClick={() => setValue(fromPlainText('Restored document.', initial.profile))}>Restore document</Button>
    </div>
    {preview ? <><output aria-label="Document JSON" hidden>{JSON.stringify(value)}</output>
      <div aria-label="Reading preview"><DocumentBody document={value} /></div></> : null}
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

const longManuscript = fromPlainText(Array.from({ length: 400 }, (_, line) =>
  `第${line + 1}段。末班车到站时，整座站台只有她一个人。雨从棚顶的缝隙落下来，在灯下拉成细线。`).join('\n'), 'blocks');

/** A chapter-length document: typing must stay immediate however long the manuscript is. */
export const LongManuscript: Story = {
  render: () => <Example initial={longManuscript} contextual preview={false} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    const started = performance.now();
    await userEvent.type(editor, '她抬起头。', { skipClick: true });
    await expect(performance.now() - started).toBeLessThan(2500);
    await waitFor(() => expect(Number(canvas.getByLabelText('Changes').textContent)).toBeGreaterThan(0));
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

/** A drag selection inside the first block, which ProseMirror reads as a text selection rather than the whole document. */
async function selectText(editor: HTMLElement) {
  editor.focus();
  const range = document.createRange();
  range.selectNodeContents(editor.querySelector('p, h1, h2, h3') as Element);
  window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
  await new Promise(resolve => setTimeout(resolve, 100));
}

function selectAll(editor: HTMLElement) {
  return userEvent.click(editor).then(() => userEvent.keyboard('{Control>}a{/Control}'));
}

export const ContextualForum: Story = {
  render: () => <Example initial={fromPlainText('A reply with formatting.', 'blocks')} compact contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await expect(canvasElement.querySelector('[data-slot="editor-toolbar"]')).toBeNull();
    await selectAll(editor);
    const menu = await canvas.findByRole('toolbar', { name: 'Format text' });
    await userEvent.click(within(menu).getByRole('button', { name: 'Bold' }));
    await expect(editor.querySelector('strong')).toHaveTextContent('A reply with formatting.');
    const bounds = menu.getBoundingClientRect();
    await expect(bounds.left).toBeGreaterThanOrEqual(0);
    await expect(bounds.top).toBeGreaterThanOrEqual(0);
    await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  },
};

export const SelectionPanel: Story = {
  render: () => <Example initial={fromPlainText('Turn this line into something else.', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    const before = editor.querySelector('p')?.getAttribute('data-id');
    await expect(before).toBeTruthy();
    await selectAll(editor);
    const panel = await canvas.findByRole('toolbar', { name: 'Format text' });
    // Every row of the panel is visible at once, in fixed positions.
    for (const name of ['Bold', 'Italic', 'Underline', 'Strikethrough', 'Inline code', 'Spoiler', 'Clear formatting', 'More formatting'])
      await expect(within(panel).getByRole('button', { name })).toBeVisible();
    await expect(within(panel).getByRole('button', { name: /^Link/ })).toBeVisible();
    await expect(within(panel).getByRole('button', { name: /^Ruby annotation/ })).toBeVisible();
    await expect(within(panel).getByRole('button', { name: /^Emphasis marks/ })).toBeVisible();
    // A compact grid, not a column of rows.
    await expect(panel.getBoundingClientRect().height).toBeLessThan(130);
    const trigger = within(panel).getByRole('button', { name: /^Turn into/ });
    await userEvent.click(trigger);
    const listEl = await canvas.findByRole('menu', { name: /^Turn into/ });
    const list = within(listEl);
    await expect(list.getAllByRole('menuitemradio')).toHaveLength(9);
    await expect(list.getByRole('menuitemradio', { name: /^Paragraph/ })).toHaveAttribute('aria-checked', 'true');
    const rect = (canvas.getByRole('menu', { name: /^Turn into/ })).getBoundingClientRect();
    await expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    await userEvent.click(list.getByRole('menuitemradio', { name: /^Heading 2/ }));
    await waitFor(() => expect(editor.querySelector('h2')).toBeInTheDocument());
    await waitFor(() => expect(editor).toHaveFocus());
    await expect(editor.querySelector('h2')).toHaveTextContent('Turn this line into something else.');
    // The block keeps its identity when its type changes.
    await expect(editor.querySelector('h2')?.getAttribute('data-id')).toBe(before);
    await userEvent.click(within(panel).getByRole('button', { name: 'Italic' }));
    await expect(editor.querySelector('h2 em')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: /^Turn into/ }));
    const second = await canvas.findByRole('menu', { name: /^Turn into/ });
    await userEvent.click(await within(second).findByRole('menuitemradio', { name: /^Bullet list/ }));
    await waitFor(() => expect(editor.querySelector('ul li p')).toBeInTheDocument());
    await expect(editor.querySelector('ul li p')).toHaveTextContent('Turn this line into something else.');
    await expect(editor.querySelector('h2')).toBeNull();
    await waitFor(() => expect(editor).toHaveFocus());
    await userEvent.click(within(panel).getByRole('button', { name: 'More formatting' }));
    const more = within(await canvas.findByRole('menu', { name: 'More formatting' }));
    await userEvent.click(more.getByRole('menuitem', { name: 'Alignment' }));
    await userEvent.click(within(await canvas.findByRole('menu', { name: 'Alignment' })).getByRole('menuitemradio', { name: 'Center' }));
    await waitFor(() => expect(editor.querySelector('li p')).toHaveStyle({ textAlign: 'center' }));
  },
};

/** More acts on the blocks the selection touches: move, duplicate and delete, each with its key. */
export const BlockActions: Story = {
  render: () => <Example initial={fromPlainText('First line.\nSecond line.\nThird line.', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    const lines = () => [...editor.querySelectorAll('p')].map(line => line.textContent);
    const select = (index: number) => {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor.querySelectorAll('p')[index]!);
      window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    };
    const more = async () => {
      const panel = await canvas.findByRole('toolbar', { name: 'Format text' });
      await userEvent.click(within(panel).getByRole('button', { name: 'More formatting' }));
      return within(await canvas.findByRole('menu', { name: 'More formatting' }));
    };
    select(1);
    let menu = await more();
    await expect(menu.getByText('Characters selected: 12')).toBeInTheDocument();
    await userEvent.click(menu.getByRole('menuitem', { name: /^Move up/ }));
    await waitFor(() => expect(lines()).toEqual(['Second line.', 'First line.', 'Third line.']));
    // The selection moves with its block, so the move repeats from the keyboard.
    await waitFor(() => expect(editor).toHaveFocus());
    await userEvent.keyboard('{Control>}{Shift>}{ArrowDown}{/Shift}{/Control}');
    await expect(lines()).toEqual(['First line.', 'Second line.', 'Third line.']);
    select(1);
    menu = await more();
    await userEvent.click(menu.getByRole('menuitem', { name: /^Duplicate/ }));
    await waitFor(() => expect(lines()).toEqual(['First line.', 'Second line.', 'Second line.', 'Third line.']));
    const ids = [...editor.querySelectorAll('p')].map(line => line.getAttribute('data-id'));
    await expect(new Set(ids).size).toBe(4);
    select(2);
    menu = await more();
    await userEvent.click(menu.getByRole('menuitem', { name: 'Delete' }));
    await waitFor(() => expect(lines()).toEqual(['First line.', 'Second line.', 'Third line.']));
    await expect(canvas.queryByRole('alert')).toBeNull();
  },
};

export const LinkInPanel: Story = {
  render: () => <Example initial={fromPlainText('Read the guide today.', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await selectAll(editor);
    const panel = await canvas.findByRole('toolbar', { name: 'Format text' });
    await userEvent.click(within(panel).getByRole('button', { name: /^Link/ }));
    const field = await canvas.findByRole('textbox', { name: 'URL' });
    await expect(canvas.queryByRole('dialog')).toBeNull();
    await userEvent.type(field, 'javascript:alert(1){Enter}');
    await expect(await canvas.findByRole('alert')).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, 'https://example.test/guide{Enter}');
    await expect(editor.querySelector('a')).toHaveAttribute('href', 'https://example.test/guide');
    await expect(editor.querySelector('a')).toHaveTextContent('Read the guide today.');
  },
};

export const LinkPopover: Story = {
  render: () => <Example initial={normalizeDocument({ version: 'rezics-document-v1', profile: 'blocks', doc: withDocumentIds({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'text', text: 'the guide', marks: [{ type: 'link', attrs: { href: 'https://example.test/old' } }] }, { type: 'text', text: ' now.' }] },
  ] }) })} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor.querySelector('a') as HTMLElement);
    const menu = await canvas.findByRole('group', { name: 'Link' });
    await expect(within(menu).getByText('https://example.test/old')).toBeInTheDocument();
    await expect(within(menu).getByRole('link', { name: 'Open link' })).toHaveAttribute('rel', 'noopener noreferrer');
    await userEvent.click(within(menu).getByRole('button', { name: 'Edit link' }));
    const field = await canvas.findByRole('textbox', { name: 'URL' });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://example.test/new{Enter}');
    await expect(editor.querySelector('a')).toHaveAttribute('href', 'https://example.test/new');
    await userEvent.click(await canvas.findByRole('button', { name: 'Remove link' }, { timeout: 2000 }).catch(() => editor));
    await userEvent.click(editor.querySelector('a') ?? editor);
    const again = canvas.queryByRole('button', { name: 'Remove link' });
    if (again) await userEvent.click(again);
    await expect(editor.querySelector('a')).toBeNull();
    await expect(editor).toHaveTextContent('See the guide now.');
  },
};

export const SlashMenu: Story = {
  render: () => <Example initial={fromPlainText('', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    await userEvent.keyboard('/');
    const list = await canvas.findByRole('listbox', { name: 'Insert block' });
    await expect(within(list).getAllByRole('option').length).toBeGreaterThanOrEqual(9);
    await expect(editor).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('head');
    await expect(within(list).getAllByRole('option')).toHaveLength(3);
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await expect(editor.querySelector('h2')).toBeInTheDocument();
    await expect(editor).toHaveTextContent('');
    await expect(canvas.queryByRole('listbox')).toBeNull();
    await userEvent.type(editor, 'Title{Enter}/zzz', { skipClick: true });
    await expect(await canvas.findByText('No matching blocks')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await expect(canvas.queryByRole('listbox')).toBeNull();
    await expect(editor).toHaveTextContent('Title/zzz');
    await userEvent.keyboard('{Enter}/div{Enter}');
    await expect(editor.querySelector('hr')).toBeInTheDocument();
  },
};

export const KeyboardLink: Story = {
  render: () => <Example initial={fromPlainText('Shortcut text.', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await selectAll(editor);
    await userEvent.keyboard('{Control>}k{/Control}');
    await userEvent.type(await canvas.findByRole('textbox', { name: 'URL' }), 'https://example.test/{Enter}');
    await expect(editor.querySelector('a')).toHaveAttribute('href', 'https://example.test/');
  },
};

export const TouchToolbar: Story = {
  render: () => <Example initial={fromPlainText('Phone writing.', 'blocks')} contextual pointerMode="coarse" />,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    // A finger selects with the system's own handles: no floating panel, and no button below the text.
    await expect(canvas.queryByRole('button', { name: 'Format text' })).toBeNull();
    await selectText(editor);
    await expect(canvasElement.querySelector('[data-slot="editor-selection-menu"]')).toBeNull();
    const bar = await page.findByRole('toolbar', { name: 'Text formatting' });
    await expect(bar.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight);
    await userEvent.click(within(bar).getByRole('button', { name: 'Bold' }));
    await expect(editor.querySelector('strong')).toHaveTextContent('Phone writing.');
    // The keyboard stays up: the editor still has focus after a tap on the bar.
    await expect(editor).toHaveFocus();
    for (const button of within(bar).getAllByRole('button')) await expect(button.getBoundingClientRect().width).toBeGreaterThanOrEqual(40);
    await userEvent.click(within(bar).getByRole('button', { name: 'Format text' }));
    const drawer = await page.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Heading 1' }));
    await waitFor(() => expect(editor.querySelector('h1')).toHaveTextContent('Phone writing.'));
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('button', { name: 'Insert block' }));
    const insert = await page.findByRole('dialog');
    await userEvent.click(within(insert).getByRole('button', { name: 'Divider' }));
    await waitFor(() => expect(editor.querySelector('hr')).toBeInTheDocument());
    // Inserting a block keeps the text that was selected.
    await expect(editor.querySelector('h1')).toHaveTextContent('Phone writing.');
  },
};

export const TouchRuby: Story = {
  render: () => <Example initial={fromPlainText('漢', 'blocks')} contextual pointerMode="coarse" />,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await selectText(editor);
    await userEvent.click(await page.findByRole('button', { name: 'Format text' }));
    const drawer = await page.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Ruby annotation' }));
    const dialog = await page.findByRole('dialog', { name: 'Ruby annotation' });
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Pronunciation' }), 'ㄏㄢˋ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    await expect(editor.querySelector('ruby rt')).toHaveTextContent('ㄏㄢˋ');
  },
};

export const CompactTouchToolbar: Story = {
  render: () => <Example initial={fromPlainText('Reply.', 'text')} compact contextual pointerMode="coarse" />,
  globals: { viewport: { value: 'phone' } },
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole('textbox', { name: 'Document' }));
    const bar = await page.findByRole('toolbar', { name: 'Text formatting' });
    await expect(within(bar).queryByRole('button', { name: 'Insert block' })).toBeNull();
    await expect(within(bar).getByRole('button', { name: 'Spoiler' })).toBeVisible();
  },
};

/** Right-click stays the browser's: spelling suggestions and paste work as everywhere else. */
export const NativeContextMenu: Story = {
  render: () => <Example initial={fromPlainText('Preserve this selection.', 'text')} compact contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await selectAll(editor);
    const { left, top, width, height } = editor.getBoundingClientRect();
    const opened = fireEvent.contextMenu(editor, { clientX: left + width / 2, clientY: top + height / 2 });
    await expect(opened).toBe(true);
    await expect(within(canvasElement.ownerDocument.body).queryByRole('menu')).toBeNull();
  },
};

/** Alt+F10 reaches the selection panel from the keyboard; arrows move within it and Escape returns to the text. */
export const KeyboardToolbar: Story = {
  render: () => <Example initial={fromPlainText('Reach the toolbar by keyboard.', 'text')} compact contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await selectAll(editor);
    const panel = await canvas.findByRole('toolbar', { name: 'Format text' });
    await userEvent.keyboard('{Alt>}{F10}{/Alt}');
    await expect(within(panel).getByRole('button', { name: /^Turn into/ })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(within(panel).getByRole('button', { name: 'Bold' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    await expect(editor.querySelector('strong')).toHaveTextContent('Reach the toolbar by keyboard.');
    await userEvent.keyboard('{Escape}');
    // Tiptap focuses on the next frame.
    await waitFor(() => expect(editor).toHaveFocus());
  },
};

/** The panel sits over the first line of the selection, centred on it, like other writing tools. */
export const PanelPlacement: Story = {
  render: () => <Example initial={fromPlainText(Array.from({ length: 8 }, (_, line) => `Line ${line + 1} of a short story.`).join('\n'), 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    const line = editor.querySelectorAll('p')[5]!;
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(line);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range);
    const panel = await canvas.findByRole('toolbar', { name: 'Format text' });
    await waitFor(() => expect(panel.getBoundingClientRect().bottom).toBeLessThanOrEqual(range.getBoundingClientRect().top + 1));
    const text = range.getBoundingClientRect(), box = panel.getBoundingClientRect();
    await expect(Math.abs((box.left + box.right) / 2 - (text.left + text.right) / 2)).toBeLessThan(4);
  },
};

/** Without an uploader an image comes from a link; the description is optional. */
export const ImageFromLink: Story = {
  render: () => <Example initial={fromPlainText('', 'blocks')} contextual />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    await userEvent.keyboard('/image{Enter}');
    const panel = await page.findByRole('dialog', { name: 'Image' });
    await expect(within(panel).queryByRole('tab')).toBeNull();
    await expect(within(panel).getByRole('button', { name: 'Embed image' })).toBeDisabled();
    await userEvent.type(within(panel).getByRole('textbox', { name: 'URL' }), 'javascript:alert(1)');
    await userEvent.click(within(panel).getByRole('button', { name: 'Embed image' }));
    await expect(within(panel).getByRole('alert')).toBeInTheDocument();
    const field = within(panel).getByRole('textbox', { name: 'URL' });
    await userEvent.clear(field);
    await userEvent.type(field, 'https://example.test/rain.png');
    await userEvent.type(within(panel).getByRole('textbox', { name: 'Description (optional)' }), 'Rain at the station');
    await userEvent.click(within(panel).getByRole('button', { name: 'Embed image' }));
    await expect(editor.querySelector('img')).toHaveAttribute('src', 'https://example.test/rain.png');
    await expect(editor.querySelector('img')).toHaveAttribute('alt', 'Rain at the station');
    await expect(page.queryByRole('dialog', { name: 'Image' })).toBeNull();
  },
};

const storyUpload = async (file: File) => ({ src: `/media/${encodeURIComponent(file.name)}` });

/** With an uploader, Upload is the first tab; dropping image files on the text uploads them in place. */
export const ImageUpload: Story = {
  render: () => <Example initial={fromPlainText('Before the picture.', 'blocks')} contextual upload={storyUpload} />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const page = within(canvasElement.ownerDocument.body);
    const editor = await canvas.findByRole('textbox', { name: 'Document' });
    await userEvent.click(editor);
    const end = document.createRange();
    end.selectNodeContents(editor); end.collapse(false);
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(end);
    await userEvent.keyboard('{Enter}/image{Enter}');
    const panel = await page.findByRole('dialog', { name: 'Image' });
    await expect(within(panel).getByRole('tab', { name: 'Upload' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.upload(panel.querySelector('input[type=file]') as HTMLInputElement, new File(['x'], 'station.png', { type: 'image/png' }));
    await waitFor(() => expect(editor.querySelector('img')).toHaveAttribute('src', '/media/station.png'));
    await expect(editor).toHaveTextContent('Before the picture.');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['y'], 'dropped.png', { type: 'image/png' }));
    const { left, top, height } = (editor.querySelector('p') as HTMLElement).getBoundingClientRect();
    editor.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, clientX: left + 4, clientY: top + height / 2, bubbles: true, cancelable: true }));
    await waitFor(() => expect(editor.querySelectorAll('img')).toHaveLength(2));
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
