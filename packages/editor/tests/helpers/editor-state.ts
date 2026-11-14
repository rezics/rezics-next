import { getSchema, type Editor } from '@tiptap/core';
import {
  normalizeDocument,
  withDocumentIds,
  documentVersion,
  type DocumentNode,
  type DocumentProfile,
} from '@rezics/document';
import { history } from '@tiptap/pm/history';
import { EditorState, type Selection, type Transaction } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../../src/components/document-extensions.ts';
import { EditorTables } from '../../src/components/editor-table-commands.ts';

/** A real ProseMirror state/history with a minimal view port; browser stories exercise rendering and ID repair. */
export function editorStateFixture(doc: DocumentNode, profile: DocumentProfile = 'blocks') {
  const schema = getSchema([...documentExtensionsForProfile(profile), ...(profile === 'blocks' ? [EditorTables] : [])]);
  let state = EditorState.create({ schema, doc: schema.nodeFromJSON(withDocumentIds(doc)), plugins: [history()] });
  let editable = true;
  let transactionCount = 0;
  const view = {
    composing: false,
    get state() {
      return state;
    },
    get editable() {
      return editable;
    },
    dispatch(transaction: Transaction) {
      state = state.applyTransaction(transaction).state;
      transactionCount++;
    },
    focus() {},
  };
  const editor = {
    get state() {
      return state;
    },
    schema,
    view,
    storage: {},
    isDestroyed: false,
    get isEditable() {
      return editable;
    },
  } as unknown as Editor;
  return {
    editor,
    select(selection: Selection) {
      view.dispatch(state.tr.setSelection(selection));
    },
    setEditable(value: boolean) {
      editable = value;
    },
    get transactionCount() {
      return transactionCount;
    },
    snapshot() {
      return normalizeDocument({
        version: documentVersion,
        profile,
        doc: withDocumentIds(state.doc.toJSON() as DocumentNode),
      });
    },
  };
}

export function nodePositions(editor: Editor, type: string) {
  const result: { node: Editor['state']['doc']; pos: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === type) result.push({ node, pos });
  });
  return result;
}

export function documentIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.attrs.id) ids.push(node.attrs.id);
  });
  return ids;
}
