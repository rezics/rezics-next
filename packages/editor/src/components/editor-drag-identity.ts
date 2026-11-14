import type { Node } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';

/** Restore a native same-editor move's complete identity after UniqueID's drop transaction. */
export function restoreMovedUnitIdentity(state: EditorState, from: number, original: Node): Transaction | null {
  const moved = state.doc.nodeAt(from);
  if (!moved) return null;
  const updates: { position: number; id: string; node: Node }[] = [];
  const pair = (before: Node, after: Node, position: number): boolean => {
    if (
      before.type !== after.type ||
      before.childCount !== after.childCount ||
      before.text !== after.text ||
      before.marks.length !== after.marks.length ||
      !before.marks.every((mark, index) => mark.eq(after.marks[index]!))
    )
      return false;
    const beforeAttrs = { ...before.attrs };
    const afterAttrs = { ...after.attrs };
    delete beforeAttrs.id;
    delete afterAttrs.id;
    if (JSON.stringify(beforeAttrs) !== JSON.stringify(afterAttrs)) return false;
    if (typeof before.attrs.id === 'string' && before.attrs.id !== after.attrs.id)
      updates.push({ position, id: before.attrs.id, node: after });
    let offset = position + 1;
    for (let index = 0; index < before.childCount; index++) {
      if (!pair(before.child(index), after.child(index), offset)) return false;
      offset += after.child(index).nodeSize;
    }
    return true;
  };
  if (!pair(original, moved, from) || !updates.length) return null;
  const outside = new Set<string>();
  state.doc.descendants((node, position) => {
    if (position === from) return false;
    if (typeof node.attrs.id === 'string') outside.add(node.attrs.id);
  });
  if (updates.some((update) => outside.has(update.id))) return null;
  const transaction = state.tr;
  for (const update of updates)
    transaction.setNodeMarkup(update.position, undefined, { ...update.node.attrs, id: update.id });
  return transaction.setMeta('addToHistory', false);
}
