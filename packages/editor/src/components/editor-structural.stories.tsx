import {
  checkDocument,
  normalizeDocument,
  withDocumentIds,
  documentVersion,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, screen, userEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';
import { placeEditorCaret } from '../test/editor-selection.ts';
import { waitForFocus } from '../../../ui/src/test/focus.ts';

const paragraph = (id: string, text: string): DocumentNode => ({
  type: 'paragraph',
  attrs: { id },
  content: [{ type: 'text', text }],
});
const initial = normalizeDocument({
  version: documentVersion,
  profile: 'blocks',
  doc: withDocumentIds({
    type: 'doc',
    content: [
      {
        type: 'taskList',
        attrs: { id: 'tasks' },
        content: [
          {
            type: 'taskItem',
            attrs: { id: 'task-one', checked: false },
            content: [paragraph('task-one-body', 'First task')],
          },
          {
            type: 'taskItem',
            attrs: { id: 'task-two', checked: false },
            content: [paragraph('task-two-body', 'Second task')],
          },
        ],
      },
      {
        type: 'table',
        attrs: { id: 'table' },
        content: Array.from({ length: 2 }, (_, row) => ({
          type: 'tableRow',
          attrs: { id: `row-${row}` },
          content: Array.from({ length: 2 }, (_, col) => ({
            type: 'tableCell',
            attrs: { id: `cell-${row}-${col}` },
            content: [paragraph(`cell-body-${row}-${col}`, `${row + 1},${col + 1}`)],
          })),
        })),
      },
      { type: 'blockquote', attrs: { id: 'quote' }, content: [paragraph('quote-body', 'A movable quotation')] },
      paragraph('last', 'Final paragraph'),
    ],
  }),
});

function demo(value: DocumentSnapshot = initial) {
  const latest = { current: value };
  function Demo() {
    const [document, setDocument] = useState(value);
    return (
      <RichTextEditor
        value={document}
        label="Structural document"
        toolbar="always"
        onChange={(next) => {
          latest.current = next;
          setDocument(next);
        }}
      />
    );
  }
  return { Demo, latest };
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

function assertUniqueIds(document: DocumentSnapshot) {
  const ids: unknown[] = [];
  const visit = (node: DocumentNode) => {
    if (node.attrs?.id) ids.push(node.attrs.id);
    node.content?.forEach(visit);
  };
  visit(document.doc);
  expect(new Set(ids).size).toBe(ids.length);
  expect(checkDocument(document)).toBe(true);
}

const structural = demo();
const lastBlock = demo(
  normalizeDocument({
    version: documentVersion,
    profile: 'blocks',
    doc: { type: 'doc', content: [paragraph('only', 'Only block')] },
  }),
);
const meta = { title: 'Editor/Structural editing', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const StructuralEditing: Story = {
  render: () => <structural.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Structural document' });
    await placeEditorCaret(textbox, within(textbox).getByText('Second task'));
    await userEvent.keyboard('{Enter}Nested task{Tab}');
    await waitFor(() => expect(nodes(structural.latest.current, 'taskList')).toHaveLength(2));
    expect(nodes(structural.latest.current, 'taskItem').find((node) => node.attrs?.id === 'task-two')).toBeDefined();
    await userEvent.click(within(textbox).getAllByRole('checkbox', { name: 'Task status' })[0]!);
    await waitFor(() => expect(nodes(structural.latest.current, 'taskItem')[0]!.attrs?.checked).toBe(true));
    assertUniqueIds(structural.latest.current);

    await userEvent.click(within(textbox).getByText('1,1'));
    await userEvent.click(await canvas.findByRole('button', { name: 'Select all cells' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Merge cells' }));
    await waitFor(() => expect(nodes(structural.latest.current, 'tableCell')).toHaveLength(1));
    expect(nodes(structural.latest.current, 'tableRow')[1]!.content ?? []).toHaveLength(0);
    expect(nodes(structural.latest.current, 'tableCell')[0]!.attrs).toMatchObject({
      id: 'cell-0-0',
      rowspan: 2,
      colspan: 2,
    });
    assertUniqueIds(structural.latest.current);
    await userEvent.click(canvas.getByRole('button', { name: 'Undo', exact: true }));
    await waitFor(() => expect(nodes(structural.latest.current, 'tableCell')).toHaveLength(4));
    expect(nodes(structural.latest.current, 'tableRow').map((node) => node.attrs?.id)).toEqual(['row-0', 'row-1']);

    await placeEditorCaret(textbox, within(textbox).getByText('A movable quotation'));
    await waitFor(() => expect(canvas.queryByRole('toolbar', { name: 'Table', exact: true })).toBeNull());
    await userEvent.click(canvas.getByRole('button', { name: 'Block actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Duplicate block' }));
    await waitFor(() => expect(nodes(structural.latest.current, 'blockquote')).toHaveLength(2));
    assertUniqueIds(structural.latest.current);
    expect(nodes(structural.latest.current, 'blockquote')[0]!.attrs?.id).toBe('quote');
    expect(nodes(structural.latest.current, 'blockquote')[1]!.attrs?.id).not.toBe('quote');
    await waitForFocus(textbox);
    await userEvent.click(canvas.getByRole('button', { name: 'Block actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move block down' }));
    await waitFor(() => expect(structural.latest.current.doc.content?.at(-1)?.type).toBe('blockquote'));
    assertUniqueIds(structural.latest.current);
    await waitForFocus(textbox);
    const actions = canvas.getByRole('button', { name: 'Block actions' });
    actions.focus();
    await userEvent.keyboard('{Enter}');
    const moveUp = await screen.findByRole('menuitem', { name: 'Move block up' });
    moveUp.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(structural.latest.current.doc.content?.at(-1)?.attrs?.id).toBe('last'));
    expect(nodes(structural.latest.current, 'blockquote')[0]!.attrs?.id).toBe('quote');
    assertUniqueIds(structural.latest.current);
    await waitForFocus(textbox);
  },
};

export const FinalBlockKeyboard: Story = {
  render: () => <lastBlock.Demo />,
  async play({ canvasElement }) {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole('textbox', { name: 'Structural document' });
    await userEvent.click(within(textbox).getByText('Only block'));
    const actions = canvas.getByRole('button', { name: 'Block actions' });
    actions.focus();
    await userEvent.keyboard('{Enter}');
    const deleteItem = await screen.findByRole('menuitem', { name: 'Delete block' });
    deleteItem.focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(lastBlock.latest.current.doc.content).toHaveLength(1));
    await waitFor(() => expect(lastBlock.latest.current.doc.content?.[0]?.content ?? []).toHaveLength(0));
    expect(lastBlock.latest.current.doc.content?.[0]?.type).toBe('paragraph');
    await waitForFocus(textbox);
    assertUniqueIds(lastBlock.latest.current);
  },
};
