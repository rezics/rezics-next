import { expect, test } from 'bun:test';
import { Editor, Extension } from '@tiptap/core';
import { fromPlainText, checkDocument } from '@rezics/document';
import { history, undoDepth, redoDepth } from '@tiptap/pm/history';
import { Plugin, TextSelection, type Transaction } from '@tiptap/pm/state';
import { DecorationSet } from '@tiptap/pm/view';
import { editorExtensions } from '../src/components/editor-surface.ts';
import {
  EditorFindHighlights,
  clearEditorFindHighlights,
  findDocumentMatches,
  replaceDocumentMatches,
} from '../src/components/editor-find.tsx';
import { undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import { editorSnapshot } from '../src/components/rich-text-editor-snapshot.ts';
import {
  compactTransactionMetrics,
  identityPreservingBatch,
  recordTextReplayBatch,
  skipProvenTextReplay,
} from '../src/components/editor-compact-transaction.ts';
import { editorDOM } from './helpers/editor-dom.ts';
import { trackPosition } from '../src/components/editor-uploads.ts';

const History = Extension.create({ name: 'bulkHistory', addProseMirrorPlugins: () => [history()] });

function openEditor(text: string, extra: Extension[] = []) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [History, EditorFindHighlights, ...extra, ...editorExtensions('blocks')],
    content: fromPlainText(text, 'blocks').doc,
    injectCSS: false,
    coreExtensionOptions: { delete: { filterTransaction: skipProvenTextReplay } },
    onTransaction: ({ transaction, appendedTransactions }) => recordTextReplayBatch(transaction, appendedTransactions),
    editorProps: { handleScrollToSelection: () => true },
  });
  return {
    editor,
    close() {
      editor.destroy();
      element.remove();
    },
  };
}

test('real plugin dispatch keeps ID repair, native history and pending positions bounded for dense and spaced documents', async () =>
  editorDOM(() => {
    for (const spaced of [false, true]) {
      const source = spaced ? 'a '.repeat(60_000) : 'a'.repeat(120_000);
      const instance = openEditor(source);
      const { editor } = instance;
      try {
        const id = editor.state.doc.firstChild!.attrs.id;
        const bookmarkAt = spaced ? 60_002 : 60_000;
        const bookmark = TextSelection.create(editor.state.doc, bookmarkAt).getBookmark();
        const pending = trackPosition(editor, bookmarkAt);
        const found = findDocumentMatches(editor.state.doc, 'a', { matchCase: true, wholeWord: false });
        const decorations = editor.state.plugins.find(
          (plugin) => plugin.getState(editor.state) instanceof DecorationSet,
        )!;
        editor.view.dispatch(
          editor.state.tr.setMeta(decorations, { matches: found.matches.slice(0, 100), current: 0 }),
        );
        expect((decorations.getState(editor.state) as DecorationSet).find()).toHaveLength(100);
        const started = performance.now();
        const tr = replaceDocumentMatches(editor.state, found.matches, 'bb')!;
        expect(identityPreservingBatch([tr])).toBe(true);
        clearEditorFindHighlights(editor);
        expect((decorations.getState(editor.state) as DecorationSet).find()).toHaveLength(0);
        editor.view.dispatch(tr);
        const dispatched = performance.now();
        expect(editor.state.doc.firstChild!.attrs.id).toBe(id);
        expect(checkDocument(editorSnapshot(editor.state.doc, 'blocks'))).toBe(true);
        expect(editor.state.selection.$from.doc === editor.state.doc).toBe(true);
        expect(bookmark.map(tr.mapping).resolve(editor.state.doc).from).toBe(
          bookmarkAt + (spaced ? bookmarkAt / 2 : bookmarkAt - 1),
        );
        expect(pending.get()).toBe(bookmarkAt + (spaced ? bookmarkAt / 2 : bookmarkAt - 1));
        expect(compactTransactionMetrics(tr)!.materializations).toBe(1);
        expect(compactTransactionMetrics(tr)!.cachedInversions).toBe(found.total);
        editor.view.dispatch(editor.state.tr.setMeta('ordinaryMetadata', true));
        // Real unrecorded positioning, not a bookmark-only observation.
        if (spaced) editor.view.dispatch(editor.state.tr.insertText('!', 60_000).setMeta('addToHistory', false));
        const retainedId = spaced ? `renamed-${id}` : id;
        if (spaced)
          editor.view.dispatch(
            editor.state.tr
              .setNodeMarkup(0, undefined, { ...editor.state.doc.firstChild!.attrs, id: retainedId })
              .setMeta('addToHistory', false),
          );
        editor.view.dispatch(
          editor.state.tr.setMeta(decorations, { matches: [{ from: 1, to: 2, text: 'b' }], current: 0 }),
        );
        expect(undoCommand.run(editor, () => undefined)).toBe(true);
        const undone = performance.now();
        expect((decorations.getState(editor.state) as DecorationSet).find()).toHaveLength(0);
        expect(editor.state.doc.textContent.includes('!')).toBe(spaced);
        expect(editor.state.doc.firstChild!.attrs.id).toBe(retainedId);
        expect(redoCommand.run(editor, () => undefined)).toBe(true);
        expect([undoDepth(editor.state), redoDepth(editor.state)]).toEqual([1, 0]);
        pending.stop();
        console.info(
          JSON.stringify({
            realBulkDispatch: true,
            spaced,
            characters: source.length,
            matches: found.total,
            buildDispatchMs: Math.round(dispatched - started),
            undoMs: Math.round(undone - dispatched),
            redoMs: Math.round(performance.now() - undone),
          }),
        );
      } finally {
        instance.close();
      }
    }
  }));

test('formatting appended to owned bulk text retains bounded native undo and normal mark semantics', async () =>
  editorDOM(() => {
    const formatting = Extension.create({
      name: 'formatSibling',
      priority: 1_000,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            appendTransaction(transactions, _oldState, state) {
              if (
                transactions.some((tr) => tr.getMeta('formatBulk')) &&
                !transactions.some((tr) => tr.getMeta('formattedBulk'))
              )
                return state.tr.addMark(1, 2, state.schema.marks.bold!.create()).setMeta('formattedBulk', true);
            },
          }),
        ];
      },
    });
    const instance = openEditor('a '.repeat(10_000), [formatting]);
    const { editor } = instance;
    try {
      const matches = findDocumentMatches(editor.state.doc, 'a', { matchCase: true, wholeWord: false }).matches;
      const tr = replaceDocumentMatches(editor.state, matches, 'bb')!.setMeta('formatBulk', true);
      editor.view.dispatch(tr);
      expect(editor.state.doc.firstChild!.firstChild!.marks.some((mark) => mark.type.name === 'bold')).toBe(true);
      expect(skipProvenTextReplay(tr)).toBe(true);
      let undone: Transaction | undefined;
      editor.on('transaction', ({ transaction }) => {
        if (transaction.docChanged) undone = transaction;
      });
      expect(undoCommand.run(editor, () => undefined)).toBe(true);
      expect(editor.state.doc.textContent === 'a '.repeat(10_000)).toBe(true);
      expect(skipProvenTextReplay(undone!)).toBe(true);
      expect(redoCommand.run(editor, () => undefined)).toBe(true);
      expect(editor.state.doc.firstChild!.firstChild!.marks.some((mark) => mark.type.name === 'bold')).toBe(true);
    } finally {
      instance.close();
    }
  }));

test('a trusted text transaction cannot hide a structural append or ordinary ID attribute repair', async () =>
  editorDOM(() => {
    const structural = Extension.create({
      name: 'structuralSibling',
      priority: 1_000,
      addProseMirrorPlugins() {
        return [
          new Plugin({
            appendTransaction(transactions, _oldState, state) {
              if (
                transactions.some((tr) => tr.getMeta('createStructuralSibling')) &&
                !transactions.some((tr) => tr.getMeta('createdStructuralSibling'))
              )
                return state.tr
                  .insert(
                    state.doc.content.size,
                    state.schema.nodes.paragraph!.create(null, state.schema.text('sibling')),
                  )
                  .setMeta('createdStructuralSibling', true);
            },
          }),
        ];
      },
    });
    const instance = openEditor('a a a', [structural]);
    const { editor } = instance;
    try {
      const found = findDocumentMatches(editor.state.doc, 'a', { matchCase: true, wholeWord: false });
      const tr = replaceDocumentMatches(editor.state, found.matches, 'b')!.setMeta('createStructuralSibling', true);
      let appended: readonly Transaction[] = [];
      editor.on('transaction', ({ appendedTransactions }) => {
        appended = appendedTransactions ?? [];
      });
      editor.view.dispatch(tr);
      expect(appended.some((transaction) => transaction.getMeta('createdStructuralSibling'))).toBe(true);
      expect(identityPreservingBatch([tr, ...appended])).toBe(false);
      expect(typeof editor.state.doc.lastChild!.attrs.id).toBe('string');
      const last = editor.state.doc.child(0).nodeSize;
      editor.view.dispatch(
        editor.state.tr
          .setNodeMarkup(last, undefined, { ...editor.state.doc.lastChild!.attrs, id: null })
          .setMeta('addToHistory', false),
      );
      expect(typeof editor.state.doc.lastChild!.attrs.id).toBe('string');
    } finally {
      instance.close();
    }
  }));

test('escaped output is refused before dispatch, while no-op replacement leaves history untouched', async () =>
  editorDOM(() => {
    const instance = openEditor('a'.repeat(120_000));
    const { editor } = instance;
    try {
      const before = editor.state.doc;
      const matches = findDocumentMatches(before, 'a', { matchCase: true, wholeWord: false }).matches;
      for (const replacement of ['\u0000'.repeat(4), '😀'.repeat(5), '\\'.repeat(10)])
        expect(replaceDocumentMatches(editor.state, matches, replacement)).toBeNull();
      expect(editor.state.doc === before).toBe(true);
      expect(undoDepth(editor.state)).toBe(0);
      expect(replaceDocumentMatches(editor.state, matches, 'a')!.steps).toHaveLength(0);
      expect(undoDepth(editor.state)).toBe(0);
    } finally {
      instance.close();
    }
  }));
