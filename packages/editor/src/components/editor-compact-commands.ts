import { CommandManager, type ChainedCommands, type Editor } from '@tiptap/core';
import { PluginKey, Selection } from '@tiptap/pm/state';
import { compactTransaction } from './editor-compact-transaction.ts';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';

export const editorContentRejected = new PluginKey('editorContentRejected');

/** Maintained Tiptap commands with an owned transaction and unchanged preventDispatch behavior. */
export function runCompactEditorChain(editor: Editor, configure: (chain: ChainedCommands) => ChainedCommands): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const state = editor.state;
  const transaction = compactTransaction(state);
  const result = configure(new CommandManager({ editor }).createChain(transaction)).run();
  if (transaction.getMeta('preventDispatch')) return result;
  if (editor.isDestroyed || editor.state.doc !== state.doc) return false;
  const document = transaction.doc;
  try {
    editorSnapshot(document, editor.schema.nodes.image ? 'blocks' : 'text');
  } catch {
    editor.view.dispatch(editor.state.tr.setMeta(editorContentRejected, true));
    return false;
  }
  const selection = transaction.selection,
    marks = transaction.storedMarks;
  transaction.setSelection(Selection.fromJSON(document, selection.toJSON())).setStoredMarks(marks);
  editor.view.dispatch(transaction);
  return result;
}
