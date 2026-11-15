import { expect, test } from 'bun:test';
import { Editor, Extension } from '@tiptap/core';
import { history, undo, redo, undoDepth } from '@tiptap/pm/history';
import { AllSelection, NodeSelection, TextSelection } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { applyLink, captureLink, restoreLinkSelection } from '../src/components/editor-link.tsx';
import { availableCommands, markCommands, undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import { editorDOM } from './helpers/editor-dom.ts';

const History = Extension.create({ name: 'linkSelectionHistory', addProseMirrorPlugins: () => [history()] });
const content = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'first' },
      content: [
        { type: 'text', text: 'first ', marks: [{ type: 'bold' }] },
        { type: 'mention', attrs: { accountId: '00000000-0000-4000-8000-000000000000' } },
        {
          type: 'extensionInline',
          attrs: {
            id: 'opaque',
            definition: 'example.link-proof',
            version: '1',
            payload: { retained: [true, 'opaque'] },
            fallback: 'Kept',
          },
        },
        { type: 'text', text: 'last', marks: [{ type: 'italic' }] },
      ],
    },
    { type: 'codeBlock', attrs: { id: 'code', language: 'text' }, content: [{ type: 'text', text: 'forbidden' }] },
  ],
};
const open = () =>
  new Editor({
    extensions: [History, ...documentExtensionsForProfile('blocks')],
    content,
    injectCSS: false,
    editorProps: { handleScrollToSelection: () => true },
  });
const offered = (editor: Editor) => availableCommands(markCommands, editor).some((command) => command.id === 'link');

test('link capture/availability share eligibility and preserve native selection class, direction, stored marks, bytes and history on cancel', async () =>
  editorDOM(() => {
    const editor = open();
    try {
      const doc = editor.state.doc;
      const bold = editor.schema.marks.bold!.create();
      for (const selection of [TextSelection.create(doc, 2), TextSelection.create(doc, 6, 1), new AllSelection(doc)]) {
        const storedMarks = selection.empty ? [bold] : null;
        editor.view.dispatch(editor.state.tr.setSelection(selection).setStoredMarks(storedMarks));
        const before = JSON.stringify(editor.getJSON()),
          depth = undoDepth(editor.state);
        const captured = captureLink(editor)!;
        expect(captured).not.toBeNull();
        expect(offered(editor)).toBe(true);
        expect(editor.state.selection.toJSON()).toEqual(selection.toJSON());
        expect(JSON.stringify(editor.getJSON())).toBe(before);
        expect(undoDepth(editor.state)).toBe(depth);
        editor.commands.setTextSelection(1);
        expect(restoreLinkSelection(editor, captured)).toBe(true);
        expect(editor.state.selection.toJSON()).toEqual(selection.toJSON());
        expect(editor.state.storedMarks).toEqual(storedMarks);
        expect(editor.state.doc).toBe(doc);
        expect(undoDepth(editor.state)).toBe(depth);
      }
      let mention = 0,
        code = 0;
      doc.descendants((node, position) => {
        if (node.type.name === 'mention') mention = position;
        if (node.type.name === 'codeBlock') code = position;
      });
      for (const selection of [
        NodeSelection.create(doc, mention),
        TextSelection.create(doc, mention, mention + 1),
        TextSelection.create(doc, code + 1, code + 3),
      ]) {
        editor.view.dispatch(editor.state.tr.setSelection(selection));
        const before = editor.state.doc;
        expect(captureLink(editor)).toBeNull();
        expect(offered(editor)).toBe(false);
        expect(applyLink(editor, selection, 'https://example.test/refused')).toBe(false);
        expect(editor.state.doc).toBe(before);
      }
      editor.commands.setTextSelection(2);
      const target = captureLink(editor)!;
      const before = editor.state.doc,
        selection = editor.state.selection;
      expect(captureLink(editor, () => false)).toBeNull();
      expect(applyLink(editor, target, 'https://example.test/stale', () => false)).toBe(false);
      expect(restoreLinkSelection(editor, target, () => false)).toBe(false);
      expect(editor.state.doc).toBe(before);
      expect(editor.state.selection).toBe(selection);
      editor.setEditable(false);
      expect(captureLink(editor)).toBeNull();
      expect(offered(editor)).toBe(false);
      expect(applyLink(editor, target, 'https://example.test/readonly')).toBe(false);
      expect(editor.state.doc).toBe(before);
      const atoms = new Editor({
        extensions: [History, ...documentExtensionsForProfile('blocks')],
        injectCSS: false,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'atoms' },
              content: [{ type: 'mention', attrs: { accountId: '00000000-0000-4000-8000-000000000000' } }],
            },
          ],
        },
      });
      try {
        atoms.view.dispatch(atoms.state.tr.setSelection(new AllSelection(atoms.state.doc)));
        const atomDocument = atoms.state.doc;
        expect(captureLink(atoms)).toBeNull();
        expect(offered(atoms)).toBe(false);
        expect(applyLink(atoms, { from: 1, to: 2 }, 'https://example.test/atom')).toBe(false);
        expect(atoms.state.doc).toBe(atomDocument);
        expect(undoDepth(atoms.state)).toBe(0);
      } finally {
        atoms.destroy();
      }
    } finally {
      editor.destroy();
    }
  }));

test('a collapsed URL insertion retains native stored text marks and rejects a destroyed target without reading its state', async () =>
  editorDOM(() => {
    const editor = open(),
      native = open();
    try {
      for (const current of [editor, native])
        current.view.dispatch(
          current.state.tr
            .setSelection(TextSelection.create(current.state.doc, 2))
            .setStoredMarks([current.schema.marks.bold!.create()]),
        );
      const captured = captureLink(editor)!,
        href = 'https://example.test/caret';
      expect(applyLink(editor, captured, href, () => true, captured.storedMarks)).toBe(true);
      const linked = native.schema.marks.link!.create({ href }).addToSet(native.state.storedMarks!);
      native.view.dispatch(native.state.tr.setStoredMarks(linked).insertText(href, 2));
      expect(editor.getJSON()).toEqual(native.getJSON());
      let insertion = false;
      editor.state.doc.descendants((node) => {
        if (node.text === href)
          insertion =
            node.marks.some((mark) => mark.type.name === 'bold') &&
            node.marks.some((mark) => mark.type.name === 'link');
      });
      expect(insertion).toBe(true);
      editor.destroy();
      expect(captureLink(editor)).toBeNull();
      expect(applyLink(editor, captured, href)).toBe(false);
      expect(restoreLinkSelection(editor, captured)).toBe(false);
    } finally {
      if (!editor.isDestroyed) editor.destroy();
      native.destroy();
    }
  }));

test('Ctrl+A link submission matches maintained native text mark operations, preserves atoms/payloads and native AllSelection through undo/redo', async () =>
  editorDOM(() => {
    const editor = open(),
      native = open();
    try {
      const before = editor.state.doc;
      editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(before)));
      native.view.dispatch(native.state.tr.setSelection(new AllSelection(native.state.doc)));
      const captured = captureLink(editor)!;
      expect(offered(editor)).toBe(true);
      const href = 'https://example.test/all';
      const reference = native.state.tr;
      const projected = TextSelection.between(native.state.selection.$anchor, native.state.selection.$head);
      reference.setSelection(projected);
      // Independent stock Transform marks only the fixture's text nodes. Native parent rules exclude code blocks.
      native.state.doc.descendants((node, position) => {
        if (node.isText)
          reference.addMark(position, position + node.nodeSize, native.schema.marks.link!.create({ href }));
      });
      native.view.dispatch(reference);
      native.view.dispatch(
        native.state.tr.setSelection(new AllSelection(native.state.doc)).setMeta('addToHistory', false),
      );
      expect(applyLink(editor, captured, href, () => true, captured.storedMarks)).toBe(true);
      expect(restoreLinkSelection(editor, captured)).toBe(true);
      expect(editor.getJSON()).toEqual(native.getJSON());
      expect(editor.state.selection).toBeInstanceOf(AllSelection);
      expect(editor.state.selection.toJSON()).toEqual(native.state.selection.toJSON());
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'mention' || node.type.name === 'extensionInline' || node.type.name === 'codeBlock')
          expect(node.toJSON()).toEqual(before.nodeAt(position)!.toJSON());
      });
      const linked = editor.state.doc;
      expect(undoCommand.run(editor, () => undefined)).toBe(true);
      expect(undo(native.state, (tr) => native.view.dispatch(tr))).toBe(true);
      expect(editor.state.doc.eq(before)).toBe(true);
      expect(editor.getJSON()).toEqual(native.getJSON());
      expect(editor.state.selection.toJSON()).toEqual(native.state.selection.toJSON());
      expect(redoCommand.run(editor, () => undefined)).toBe(true);
      expect(redo(native.state, (tr) => native.view.dispatch(tr))).toBe(true);
      expect(editor.state.doc.eq(linked)).toBe(true);
      expect(editor.getJSON()).toEqual(native.getJSON());
      expect(editor.state.selection).toBeInstanceOf(AllSelection);
    } finally {
      editor.destroy();
      native.destroy();
    }
  }));
