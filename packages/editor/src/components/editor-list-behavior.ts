import { Extension, type Extensions, type Node as TiptapNode, type Editor } from '@tiptap/core';
import { joinBackward, joinForward } from '@tiptap/pm/commands';
import { liftListItem, sinkListItem, splitListItem } from '@tiptap/pm/schema-list';
import { type Node } from '@tiptap/pm/model';
import { Plugin, type Command } from '@tiptap/pm/state';

function listItem(editor: Editor): { node: Node; pos: number } | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name === 'listItem' || node.type.name === 'taskItem') return { node, pos: $from.before(depth) };
  }
  return null;
}

function apply(editor: Editor, command: Command): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  return command(editor.state, (transaction) => editor.view.dispatch(transaction));
}

export function indentList(editor: Editor, dispatch = true): boolean {
  const item = listItem(editor);
  return Boolean(
    item &&
    !editor.isDestroyed &&
    editor.isEditable &&
    !editor.view.composing &&
    sinkListItem(item.node.type)(
      editor.state,
      dispatch ? (transaction) => editor.view.dispatch(transaction) : undefined,
    ),
  );
}

export function outdentList(editor: Editor, dispatch = true): boolean {
  const item = listItem(editor);
  return Boolean(
    item &&
    !editor.isDestroyed &&
    editor.isEditable &&
    !editor.view.composing &&
    liftListItem(item.node.type)(
      editor.state,
      dispatch ? (transaction) => editor.view.dispatch(transaction) : undefined,
    ),
  );
}

export function toggleTask(editor: Editor, dispatch = true): boolean {
  const item = listItem(editor);
  if (!item || item.node.type.name !== 'taskItem' || editor.isDestroyed || !editor.isEditable || editor.view.composing)
    return false;
  if (dispatch)
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(item.pos, undefined, {
        ...item.node.attrs,
        checked: !item.node.attrs.checked,
      }),
    );
  return true;
}

export function splitCurrentListItem(editor: Editor): boolean {
  const item = listItem(editor);
  if (!item || editor.view.composing || !editor.isEditable) return false;
  if (
    splitListItem(item.node.type)(editor.state, (transaction) => {
      const { $from } = transaction.selection;
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type === item.node.type) {
          transaction.setNodeMarkup($from.before(depth), undefined, {
            ...node.attrs,
            id: null,
            ...(node.type.name === 'taskItem' ? { checked: false } : {}),
          });
          break;
        }
      }
      editor.view.dispatch(transaction);
    })
  )
    return true;
  return editor.state.selection.empty && editor.state.selection.$from.parent.content.size === 0 && outdentList(editor);
}

/** Native split/lift/sink/join mechanics operate on this profile's existing item types. */
export const EditorLists = Extension.create({
  name: 'documentListEditing',
  addKeyboardShortcuts() {
    const editor = this.editor;
    return {
      Enter: () => splitCurrentListItem(editor),
      Tab: () => indentList(editor),
      'Shift-Tab': () => outdentList(editor),
      Backspace: () => Boolean(listItem(editor) && apply(editor, joinBackward)),
      Delete: () => Boolean(listItem(editor) && apply(editor, joinForward)),
    };
  },
});

/** A task checkbox belongs to its item and updates the same undoable document transaction. */
export function withTaskItemView(extensions: Extensions, label: () => string): Extensions {
  const views = new Set<() => void>();
  const nodes = extensions.map((extension) =>
    extension.name !== 'taskItem'
      ? extension
      : (extension as TiptapNode).extend({
          addNodeView() {
            const editor = this.editor;
            return ({ node: initial, getPos }) => {
              let node = initial;
              const dom = document.createElement('li');
              dom.dataset.type = 'taskItem';
              const control = document.createElement('label');
              control.className = 'flex min-h-11 min-w-11 shrink-0 items-center justify-center';
              control.contentEditable = 'false';
              const checkbox = document.createElement('input');
              checkbox.type = 'checkbox';
              control.append(checkbox);
              const contentDOM = document.createElement('div');
              dom.append(control, contentDOM);
              const update = () => {
                checkbox.checked = Boolean(node.attrs.checked);
                checkbox.disabled = !editor.isEditable;
                checkbox.setAttribute('aria-label', label());
                dom.dataset.checked = String(Boolean(node.attrs.checked));
                for (const [key, value] of [
                  ['data-block-id', node.attrs.id],
                  ['data-id', node.attrs.id],
                  ['lang', node.attrs.lang],
                  ['dir', node.attrs.dir],
                ] as const) {
                  if (value) dom.setAttribute(key, value);
                  else dom.removeAttribute(key);
                }
              };
              const change = () => {
                const pos = getPos();
                if (typeof pos !== 'number' || editor.isDestroyed || !editor.isEditable || editor.view.composing) {
                  update();
                  return;
                }
                const current = editor.state.doc.nodeAt(pos);
                if (current?.type.name !== 'taskItem' || current.attrs.id !== node.attrs.id) {
                  update();
                  return;
                }
                editor.view.dispatch(
                  editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: checkbox.checked }),
                );
              };
              checkbox.addEventListener('change', change);
              views.add(update);
              update();
              return {
                dom,
                contentDOM,
                update(next) {
                  if (next.type !== node.type) return false;
                  if (next !== node) {
                    node = next;
                    update();
                  }
                  return true;
                },
                stopEvent(event) {
                  return control.contains(event.target as globalThis.Node);
                },
                ignoreMutation(mutation) {
                  return (
                    mutation.type !== 'selection' && (mutation.target === dom || control.contains(mutation.target))
                  );
                },
                destroy() {
                  checkbox.removeEventListener('change', change);
                  views.delete(update);
                },
              };
            };
          },
        }),
  );
  return [
    ...nodes,
    Extension.create({
      name: 'documentTaskViewInvalidation',
      addProseMirrorPlugins: () => [
        new Plugin({
          view(view) {
            let editable = view.editable;
            let currentLabel = label();
            return {
              update(next) {
                const nextLabel = label();
                if (editable === next.editable && nextLabel === currentLabel) return;
                editable = next.editable;
                currentLabel = nextLabel;
                for (const update of views) update();
              },
              destroy() {
                views.clear();
              },
            };
          },
        }),
      ],
    }),
  ];
}
