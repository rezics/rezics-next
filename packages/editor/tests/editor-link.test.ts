import { expect, test } from 'bun:test';
import { Editor, Extension } from '@tiptap/core';
import { history, closeHistory } from '@tiptap/pm/history';
import type { Transaction } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { applyLink } from '../src/components/editor-link.tsx';
import { undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import { compactTransactionMetrics } from '../src/components/editor-compact-transaction.ts';
import { editorDOM } from './helpers/editor-dom.ts';

const History = Extension.create({ name: 'linkHistory', addProseMirrorPlugins: () => [history()] });

test('a link change across mixed authored runs preserves IDs, marks and native undo/redo in one compact transaction', async () =>
  editorDOM(() => {
    let changed: Transaction | undefined;
    const editor = new Editor({
      extensions: [History, ...documentExtensionsForProfile('blocks')],
      injectCSS: false,
      content: {
        type: 'doc',
        content: Array.from({ length: 600 }, (_, index) => ({
          type: 'paragraph',
          attrs: { id: `paragraph-${index}`, lang: 'ja', textAlign: 'right' },
          content: [
            {
              type: 'text',
              text: `漢字${index}`,
              marks: [
                { type: 'link', attrs: { href: `https://example.test/old/${index}` } },
                { type: 'textStyle', attrs: { color: index % 2 ? 'blue' : 'red' } },
              ],
            },
          ],
        })),
      },
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) changed = transaction;
      },
      editorProps: { handleScrollToSelection: () => true },
    });
    let nativeChanged: Transaction | undefined;
    const native = new Editor({
      extensions: [History, ...documentExtensionsForProfile('blocks')],
      injectCSS: false,
      content: editor.state.doc.toJSON(),
      onTransaction: ({ transaction }) => {
        if (transaction.docChanged) nativeChanged = transaction;
      },
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      const before = editor.state.doc;
      const range = { from: 1, to: before.content.size - 1 };
      expect(applyLink(editor, range, 'https://example.test/new')).toBe(true);
      const linked = editor.state.doc;
      expect(native.chain().setTextSelection(range).setMark('link', { href: 'https://example.test/new' }).run()).toBe(
        true,
      );
      expect(linked.toJSON()).toEqual(native.state.doc.toJSON());
      expect(editor.state.selection.toJSON()).toEqual(native.state.selection.toJSON());
      expect(changed!.steps.map((step) => step.toJSON())).toEqual(nativeChanged!.steps.map((step) => step.toJSON()));
      // Maintained commands may observe an intermediate mark prefix; the complete run stays bounded.
      expect(compactTransactionMetrics(changed!)!.materializations).toBeLessThanOrEqual(2);
      linked.forEach((node, _position, index) => {
        expect(node.attrs).toEqual(before.child(index).attrs);
        expect(node.firstChild!.marks.find((mark) => mark.type.name === 'link')!.attrs.href).toBe(
          'https://example.test/new',
        );
        expect(node.firstChild!.marks.filter((mark) => mark.type.name !== 'link')).toEqual(
          before.child(index).firstChild!.marks.filter((mark) => mark.type.name !== 'link'),
        );
      });
      expect(undoCommand.run(editor, () => undefined)).toBe(true);
      expect(editor.state.doc.eq(before)).toBe(true);
      expect(redoCommand.run(editor, () => undefined)).toBe(true);
      expect(editor.state.doc.eq(linked)).toBe(true);
      editor.view.dispatch(closeHistory(editor.state.tr));
      expect(applyLink(editor, range, null)).toBe(true);
      editor.state.doc.descendants((node) => {
        if (node.isText) expect(node.marks.map((mark) => mark.type.name)).toEqual(['textStyle']);
      });
      expect(undoCommand.run(editor, () => undefined)).toBe(true);
      expect(editor.state.doc.eq(linked)).toBe(true);
    } finally {
      editor.destroy();
      native.destroy();
    }
  }));

test('link caret expansion, explicit unlink, insertion and retired-range guards retain their behavior', async () =>
  editorDOM(() => {
    const editor = new Editor({
      extensions: [History, ...documentExtensionsForProfile('text')],
      injectCSS: false,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'kept' },
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.test/before' } }] },
              { type: 'text', text: 'z' },
            ],
          },
        ],
      },
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      const before = editor.state.doc;
      expect(applyLink(editor, { from: 3, to: 3 }, 'https://example.test/retired', () => false)).toBe(false);
      expect(applyLink(editor, { from: 2, to: 6 }, 'javascript:alert(1)')).toBe(false);
      expect(editor.state.doc.eq(before)).toBe(true);
      expect(applyLink(editor, { from: 3, to: 3 }, 'https://example.test/after')).toBe(true);
      expect(editor.state.doc.firstChild!.child(1).text).toBe('link');
      expect(editor.state.doc.firstChild!.child(1).marks[0]!.attrs.href).toBe('https://example.test/after');
      expect(applyLink(editor, { from: 3, to: 3 }, null)).toBe(true);
      expect(editor.state.doc.firstChild!.childCount).toBe(1);
      expect(editor.state.doc.textContent).toBe('alinkz');
      expect(applyLink(editor, { from: 7, to: 7 }, 'https://example.test/inserted')).toBe(true);
      expect(editor.state.doc.textContent).toBe('alinkzhttps://example.test/inserted');
      expect(editor.state.doc.firstChild!.attrs.id).toBe('kept');
    } finally {
      editor.destroy();
    }
  }));
