'use client';

import { Menu, type MenuEntry } from '@rezics/ui/menu';
import { Button } from '@rezics/ui/shadcn/button';
import { identifiableNodeNames } from '@rezics/document';
import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, type Node } from '@tiptap/pm/model';
import { Selection, TextSelection, type Transaction } from '@tiptap/pm/state';
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

type BlockRange = { nodes: Node[]; from: number; to: number; first: number; last: number };

function currentBlocks(editor: Editor): BlockRange | null {
  const { selection, doc } = editor.state;
  const { $from, $to } = selection;
  const first = $from.index(0);
  const last = Math.max(first, $to.index(0) - ($to.depth === 0 ? 1 : 0));
  if (last >= doc.childCount || ($from.depth === 0 && selection.empty)) return null;
  const nodes: Node[] = [];
  const from = $from.depth === 0 ? $from.pos : $from.before(1);
  let to = from;
  for (let index = first; index <= last; index += 1) {
    const node = doc.child(index);
    nodes.push(node);
    to += node.nodeSize;
  }
  return { nodes, from, to, first, last };
}

function leavesUnresolvedFootnote(doc: Node, block: BlockRange): boolean {
  const removed = new Set(
    block.nodes.filter((node) => node.type.name === 'footnoteDefinition').map((node) => node.attrs.label),
  );
  if (!removed.size) return false;
  let referenced = false;
  const inspect = (node: Node) => {
    if (referenced) return false;
    if (node.type.name === 'footnoteReference' && removed.has(node.attrs.label)) referenced = true;
    return !referenced;
  };
  if (block.from > 0) doc.nodesBetween(0, block.from, inspect);
  if (!referenced && block.to < doc.content.size) doc.nodesBetween(block.to, doc.content.size, inspect);
  return referenced;
}

function canApplyBlockRange(editor: Editor, block: BlockRange, name: BlockActionName): boolean {
  if (name === 'moveBlockUp') return block.first > 0;
  if (name === 'moveBlockDown') return block.last < editor.state.doc.childCount - 1;
  if (name === 'deleteBlock') return !leavesUnresolvedFootnote(editor.state.doc, block);
  return true;
}

export function canRunBlockAction(editor: Editor, name: BlockActionName): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const block = currentBlocks(editor);
  return block !== null && canApplyBlockRange(editor, block, name);
}

function duplicateNode(node: Node, copiedLabels: ReadonlyMap<string, string>): Node {
  const note = ['footnoteDefinition', 'footnoteReference'].includes(node.type.name)
    ? copiedLabels.get(node.attrs.label)
    : undefined;
  if (node.isText) return node;
  return node.type.create(
    {
      ...node.attrs,
      ...(identified.has(node.type.name) ? { id: crypto.randomUUID() } : {}),
      ...(note ? { label: note } : {}),
    },
    Fragment.fromArray(Array.from({ length: node.childCount }, (_, index) => duplicateNode(node.child(index), copiedLabels))),
    node.marks,
  );
}

/** A moved unit is inserted intact; duplication assigns every identified descendant a new ID. */
export function runBlockAction(editor: Editor, name: BlockActionName, isCurrent: () => boolean): boolean {
  if (!isCurrent() || editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const block = currentBlocks(editor);
  if (!block || !canApplyBlockRange(editor, block, name)) return false;
  const { doc, selection } = editor.state;
  const transaction = closeHistory(editor.state.tr);
  let newPos = block.from;
  if (name === 'moveBlockUp' || name === 'moveBlockDown') {
    const before = name === 'moveBlockUp';
    const sibling = doc.child(before ? block.first - 1 : block.last + 1);
    const from = before ? block.from - sibling.nodeSize : block.from;
    const to = before ? block.to : block.to + sibling.nodeSize;
    transaction.replaceWith(from, to, Fragment.fromArray(before ? [...block.nodes, sibling] : [sibling, ...block.nodes]));
    newPos += before ? -sibling.nodeSize : sibling.nodeSize;
  } else if (name === 'duplicateBlock') {
    const labels = new Set<string>();
    if (block.nodes.some((node) => node.type.name === 'footnoteDefinition'))
      doc.forEach((node) => {
        if (node.type.name === 'footnoteDefinition') labels.add(node.attrs.label);
      });
    const copiedLabels = new Map<string, string>();
    for (const node of block.nodes) {
      if (node.type.name !== 'footnoteDefinition') continue;
      let label: string;
      let index = 1;
      do {
        label = `${String(node.attrs.label).slice(0, 110)}-copy-${index++}`;
      } while (labels.has(label));
      labels.add(label);
      copiedLabels.set(node.attrs.label, label);
    }
    const copies = block.nodes.map((node) => duplicateNode(node, copiedLabels));
    newPos = block.to;
    transaction.insert(block.to, Fragment.fromArray(copies));
  } else {
    transaction.delete(block.from, block.to);
    let ordinaryBlocks = 0;
    transaction.doc.forEach((node) => {
      if (node.type.name !== 'footnoteDefinition') ordinaryBlocks++;
    });
    if (ordinaryBlocks === 0) transaction.insert(0, editor.schema.nodes.paragraph!.create({ id: crypto.randomUUID() }));
    transaction.setSelection(
      TextSelection.near(transaction.doc.resolve(Math.min(block.from, transaction.doc.content.size))),
    );
  }
  if (name !== 'deleteBlock') {
    const delta = newPos - block.from;
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
    selector: ({ editor: current }) => {
      const block = currentBlocks(current);
      const editable = current.isEditable && !current.view.composing;
      const excerpt = (node: Node) => node.textBetween(0, Math.min(node.content.size, 100), ' ', ' ').trim();
      return {
        block: block ? String(block.nodes[0]!.attrs.id ?? block.from) : undefined,
        target: block
          ? {
              first: excerpt(block.nodes[0]!),
              last: block.nodes.length > 1 ? excerpt(block.nodes.at(-1)!) : undefined,
              count: block.nodes.length,
            }
          : undefined,
        can: Object.fromEntries(
          blockActionNames.map((name) => [name, editable && block !== null && canApplyBlockRange(current, block, name)]),
        ) as Record<BlockActionName, boolean>,
        list: {
          indentList: indentList(current, false),
          outdentList: outdentList(current, false),
          toggleTask: toggleTask(current, false),
        },
        presented: editorCommandsForPresentation(
          operationNames.map((id) => ({ id })),
          current,
        ),
      };
    },
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
  const target = state.target;
  const description = target && target.count > 1
    ? `${target.count} · ${target.first} … ${target.last ?? ''}`
    : target?.first;
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
            aria-description={description}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Ellipsis aria-hidden="true" />
            <span className="min-w-0">{title}</span>
            {description ? <bdi className="max-w-36 truncate text-muted-foreground">{description}</bdi> : null}
          </Button>
        }
      />
    </div>
  );
}
