'use client';

import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { identifiableNodeNames } from '@rezics/document';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node } from '@tiptap/pm/model';
import { NodeSelection, Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { Ellipsis } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { behaviorControlLabels } from './editor-behavior-labels.ts';
import { availableCommands, blockCommands, type EditorCommand } from './editor-commands.ts';
import { editorCommandLabel, type RichTextEditorLabels } from './editor-labels.ts';
import { indentList, outdentList, toggleTask } from './editor-list-behavior.ts';
import type { EditorBehaviorAction } from './editor-behavior-actions.ts';
import { editorCommandsForPresentation } from './editor-command-preferences.ts';
import { returnFocus } from './editor-menu-helpers.ts';

export const blockActionNames = ['moveBlockUp', 'moveBlockDown', 'duplicateBlock', 'deleteBlock'] as const;
export type BlockActionName = (typeof blockActionNames)[number];
const identified = new Set<string>(identifiableNodeNames);
const listActions = { indentList, outdentList, toggleTask };
const operationNames = [...Object.keys(listActions), ...blockActionNames] as (
  | keyof typeof listActions
  | BlockActionName
)[];

function currentBlock(editor: Editor): { node: Node; pos: number; index: number } | null {
  const { selection, doc } = editor.state;
  if (selection instanceof NodeSelection && selection.$from.depth === 0)
    return { node: selection.node, pos: selection.from, index: selection.$from.index(0) };
  if (selection.$from.depth < 1) return null;
  const node = selection.$from.node(1);
  const pos = selection.$from.before(1);
  return selection.to <= pos + node.nodeSize ? { node, pos, index: selection.$from.index(0) } : null;
}

function referencedDefinition(editor: Editor, node: Node): boolean {
  if (node.type.name !== 'footnoteDefinition') return false;
  let referenced = false;
  editor.state.doc.descendants((candidate) => {
    if (candidate.type.name === 'footnoteReference' && candidate.attrs.label === node.attrs.label) referenced = true;
  });
  return referenced;
}

export function canRunBlockAction(editor: Editor, name: BlockActionName): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const block = currentBlock(editor);
  if (!block) return false;
  if (name === 'moveBlockUp') return block.index > 0;
  if (name === 'moveBlockDown') return block.index < editor.state.doc.childCount - 1;
  if (name === 'deleteBlock') return !referencedDefinition(editor, block.node);
  return true;
}

function duplicateNode(node: Node, definitionLabel?: string): Node {
  if (node.isText) return node;
  return node.type.create(
    {
      ...node.attrs,
      ...(identified.has(node.type.name) ? { id: crypto.randomUUID() } : {}),
      ...(definitionLabel && node.type.name === 'footnoteDefinition' ? { label: definitionLabel } : {}),
    },
    Fragment.fromArray(Array.from({ length: node.childCount }, (_, index) => duplicateNode(node.child(index)))),
    node.marks,
  );
}

/** A moved unit is inserted intact; duplication assigns every identified descendant a new ID. */
export function runBlockAction(editor: Editor, name: BlockActionName, isCurrent: () => boolean): boolean {
  if (!isCurrent() || !canRunBlockAction(editor, name)) return false;
  const block = currentBlock(editor)!;
  const { doc, selection } = editor.state;
  const transaction = closeHistory(editor.state.tr);
  let newPos = block.pos;
  if (name === 'moveBlockUp' || name === 'moveBlockDown') {
    const before = name === 'moveBlockUp';
    const sibling = doc.child(block.index + (before ? -1 : 1));
    const from = before ? block.pos - sibling.nodeSize : block.pos;
    const to = before ? block.pos + block.node.nodeSize : block.pos + block.node.nodeSize + sibling.nodeSize;
    transaction.replaceWith(from, to, Fragment.fromArray(before ? [block.node, sibling] : [sibling, block.node]));
    newPos += before ? -sibling.nodeSize : sibling.nodeSize;
  } else if (name === 'duplicateBlock') {
    let label: string | undefined;
    if (block.node.type.name === 'footnoteDefinition') {
      const labels = new Set<string>();
      doc.forEach((node) => {
        if (node.type.name === 'footnoteDefinition') labels.add(node.attrs.label);
      });
      let index = 1;
      do {
        label = `${String(block.node.attrs.label).slice(0, 110)}-copy-${index++}`;
      } while (labels.has(label));
    }
    newPos += block.node.nodeSize;
    transaction.insert(newPos, duplicateNode(block.node, label));
  } else {
    transaction.delete(block.pos, block.pos + block.node.nodeSize);
    let ordinaryBlocks = 0;
    transaction.doc.forEach((node) => {
      if (node.type.name !== 'footnoteDefinition') ordinaryBlocks++;
    });
    if (ordinaryBlocks === 0) transaction.insert(0, editor.schema.nodes.paragraph!.create({ id: crypto.randomUUID() }));
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(Math.min(block.pos, transaction.doc.content.size))),
    );
  }
  if (name !== 'deleteBlock') {
    const delta = newPos - block.pos;
    const json = selection.toJSON();
    try {
      transaction.setSelection(
        Selection.fromJSON(transaction.doc, {
          ...json,
          ...(typeof json.anchor === 'number' ? { anchor: json.anchor + delta } : {}),
          ...(typeof json.head === 'number' ? { head: json.head + delta } : {}),
        }),
      );
    } catch {
      transaction.setSelection(TextSelection.near(transaction.doc.resolve(newPos + 1)));
    }
  }
  const oldState = editor.state;
  editor.view.dispatch(transaction.scrollIntoView());
  if (isCurrent() && !editor.isDestroyed && editor.isEditable) editor.view.focus();
  return oldState !== editor.state;
}

export const blockOperationCommands: readonly EditorCommand[] = blockActionNames.map((name) => ({
  id: name,
  label: name,
  available: (editor) => canRunBlockAction(editor, name),
  run: (editor) => runBlockAction(editor, name, () => true),
}));

export function BlockActions({
  editor,
  labels,
  isCurrent,
  onCommands,
}: {
  editor: Editor;
  labels: RichTextEditorLabels;
  isCurrent: () => boolean;
  onCommands?: (commands: readonly EditorBehaviorAction[]) => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      block: currentBlock(current)?.node.attrs.id as string | undefined,
      can: Object.fromEntries(blockActionNames.map((name) => [name, canRunBlockAction(current, name)])) as Record<
        BlockActionName,
        boolean
      >,
      list: {
        indentList: indentList(current, false),
        outdentList: outdentList(current, false),
        toggleTask: toggleTask(current, false),
      },
      presented: editorCommandsForPresentation(
        operationNames.map((id) => ({ id })),
        current,
      ),
    }),
  });
  const [revision, setRevision] = useState(0);
  useLayoutEffect(() => {
    const update = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged || transaction.selectionSet) setRevision((value) => value + 1);
    };
    editor.on('transaction', update);
    return () => {
      editor.off('transaction', update);
    };
  }, [editor]);
  useLayoutEffect(() => {
    onCommands?.([
      ...blockActionNames.map((name) => ({
        id: name,
        label: labels[name] ?? behaviorControlLabels[name],
        disabled: !state.can[name],
        run: () => runBlockAction(editor, name, isCurrent),
      })),
      ...Object.entries({ indentList, outdentList, toggleTask }).map(([id, run]) => ({
        id,
        label: labels[id as keyof typeof state.list] ?? behaviorControlLabels[id as keyof typeof state.list],
        disabled: !state.list[id as keyof typeof state.list],
        run: () => {
          if (!isCurrent()) return false;
          const handled = run(editor);
          if (handled && isCurrent()) editor.view.focus();
          return handled;
        },
      })),
    ]);
    return () => onCommands?.([]);
  }, [onCommands, editor, labels, isCurrent, state.can, state.list]);
  const admitted = { doc: editor.state.doc, selection: editor.state.selection };
  const current = () =>
    isCurrent() &&
    !editor.isDestroyed &&
    editor.isEditable &&
    !editor.view.composing &&
    editor.state.doc === admitted.doc &&
    editor.state.selection.eq(admitted.selection);
  if (!isCurrent() || !state.block) return null;
  const entries: MenuEntry[] = [
    ...availableCommands(blockCommands, editor).map((command): MenuEntry => ({
      type: 'item',
      label: `${labels.turnInto}: ${editorCommandLabel(labels, command.label)}`,
      onSelect: () => {
        if (current()) {
          command.run(editor, () => undefined);
          returnFocus(editor, isCurrent)();
        }
      },
    })),
    { type: 'separator' },
    ...state.presented.map(({ id: name }): MenuEntry => ({
      type: name === 'deleteBlock' ? 'destructive' : 'item',
      label: labels[name] ?? behaviorControlLabels[name],
      disabled: name in state.list ? !state.list[name as keyof typeof state.list] : !state.can[name as BlockActionName],
      onSelect: () => {
        if (!current()) return;
        if (name in listActions) listActions[name as keyof typeof listActions](editor);
        else runBlockAction(editor, name as BlockActionName, isCurrent);
        returnFocus(editor, isCurrent)();
      },
    })),
  ];
  const title = labels.blockActions ?? behaviorControlLabels.blockActions;
  return (
    <div data-slot="editor-block-actions">
      <Menu
        key={`${state.block}:${revision}`}
        title={title}
        entries={entries}
        trigger={
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-7 max-w-full whitespace-normal text-start"
            aria-label={title}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Ellipsis aria-hidden="true" />
            {title}
          </Button>
        }
      />
    </div>
  );
}
