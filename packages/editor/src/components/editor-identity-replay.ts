import UniqueID from '@tiptap/extension-unique-id';
import { Fragment, Slice, type Node } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { identityPreservingBatch } from './editor-compact-transaction.ts';

const movingDrops = new WeakMap<EditorView, DragEvent>();

function dragCopies(event: DragEvent): boolean {
  const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return mac ? event.altKey : event.ctrlKey;
}

export function isMovingEditorSlice(view: EditorView, slice: Slice): boolean {
  // The drop and its paste transforms run in the same ProseMirror DOM listener.
  return view.dragging?.slice === slice && Boolean(movingDrops.get(view)?.currentTarget);
}

/** A whole-batch proof; UniqueID's per-transaction filter can otherwise hide a structural sibling. */
export const IdentityUniqueID = UniqueID.extend({
  addProseMirrorPlugins() {
    const plugins: Plugin[] = this.parent?.() ?? [];
    const { attributeName, types } = this.options;
    const identified = types === 'all' ? null : new Set(types);
    function clearCopiedIds(fragment: Fragment): Fragment {
      const nodes: Node[] = [];
      fragment.forEach((node) => {
        const content = node.isLeaf ? node.content : clearCopiedIds(node.content);
        nodes.push(
          (!identified || identified.has(node.type.name)) && node.attrs[attributeName] != null
            ? node.type.create({ ...node.attrs, [attributeName]: null }, content, node.marks)
            : node.copy(content),
        );
      });
      return Fragment.fromArray(nodes);
    }

    return plugins.map((plugin) => {
      const append = plugin.spec.appendTransaction;
      if (!append) return plugin;
      // ProseMirror advertises copyMove for internal drags and decides at drop using dragCopies.
      // Replace UniqueID's transfer-based clipboard hooks while keeping its transaction repair.
      const { view: _dragSourceTracker, ...spec } = plugin.spec;
      return new Plugin({
        ...spec,
        props: {
          dragCopies,
          handleDOMEvents: {
            drop(view, event) {
              if (view.dragging && !view.someProp('dragCopies', (copies) => copies(event))) {
                movingDrops.set(view, event);
                queueMicrotask(() => {
                  if (movingDrops.get(view) === event) movingDrops.delete(view);
                });
              } else movingDrops.delete(view);
              return false;
            },
          },
          transformPasted(slice, view) {
            if (isMovingEditorSlice(view, slice)) return slice;
            return new Slice(clearCopiedIds(slice.content), slice.openStart, slice.openEnd);
          },
        },
        appendTransaction(transactions, oldState, newState) {
          if (identityPreservingBatch(transactions)) return null;
          return append.call(this, transactions, oldState, newState);
        },
      });
    });
  },
});
