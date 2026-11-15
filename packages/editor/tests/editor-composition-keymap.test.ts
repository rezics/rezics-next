import { expect, test } from 'bun:test';
import { Editor, Node } from '@tiptap/core';
import { EditorCompositionKeymap } from '../src/components/editor-composition-keymap.ts';
import { editorDOM } from './helpers/editor-dom.ts';

const nodes = [
  Node.create({ name: 'doc', topNode: true, content: 'block+' }),
  Node.create({
    name: 'paragraph',
    group: 'block',
    content: 'inline*',
    parseHTML: () => [{ tag: 'p' }],
    renderHTML: () => ['p', 0],
  }),
  Node.create({
    name: 'heading',
    group: 'block',
    content: 'inline*',
    parseHTML: () => [{ tag: 'h2' }],
    renderHTML: () => ['h2', 0],
  }),
  Node.create({ name: 'text', group: 'inline' }),
];

function fixture(guarded: boolean, content: string) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [...nodes, ...(guarded ? [EditorCompositionKeymap] : [])],
    ...(guarded ? { enableCoreExtensions: { keymap: false } } : {}),
    content,
  });
  return {
    editor,
    close: () => {
      editor.destroy();
      element.remove();
    },
  };
}

function backspace(editor: Editor) {
  // This is the maintained DOM-change reader's key probe, not native OS input evidence.
  const event = new KeyboardEvent('keydown', { key: 'Backspace', keyCode: 8 });
  return editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event)) ?? false;
}

test('a composing DOM Backspace probe leaves preedit alone while the stock keymap dispatches an empty transaction', async () => {
  await editorDOM(() => {
    for (const guarded of [false, true]) {
      const f = fixture(guarded, '<p>にほんご</p>');
      try {
        f.editor.commands.setTextSelection(f.editor.state.doc.content.size - 1);
        f.editor.view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }));
        expect(f.editor.view.composing).toBe(true);
        const before = f.editor.state.doc;
        const transactions: { changed: boolean; steps: number; selection: boolean }[] = [];
        f.editor.on('transaction', ({ transaction }) =>
          transactions.push({
            changed: transaction.docChanged,
            steps: transaction.steps.length,
            selection: transaction.selectionSet,
          }),
        );
        expect(backspace(f.editor)).toBe(false);
        expect(f.editor.state.doc).toBe(before);
        expect(f.editor.view.composing).toBe(true);
        expect(transactions).toEqual(guarded ? [] : [{ changed: false, steps: 0, selection: false }]);
      } finally {
        f.close();
      }
    }
  });
});

test('outside composition inherited Backspace joins blocks and retains native whole-document clearing', async () => {
  await editorDOM(() => {
    const results = [false, true].map((guarded) => {
      const f = fixture(guarded, '<p>First</p><p>Second</p>');
      try {
        f.editor.commands.setTextSelection(f.editor.state.doc.child(0).nodeSize + 1);
        expect(backspace(f.editor)).toBe(true);
        expect(f.editor.state.doc.childCount).toBe(1);
        expect(f.editor.state.doc.textContent).toBe('FirstSecond');
        const joined = { doc: f.editor.state.doc.toJSON(), selection: f.editor.state.selection.toJSON() };
        f.editor.commands.setContent('<h2>Heading</h2>');
        expect(f.editor.commands.selectAll()).toBe(true);
        expect(backspace(f.editor)).toBe(true);
        expect(f.editor.state.doc.firstChild!.type.name).toBe('paragraph');
        expect(f.editor.state.doc.textContent).toBe('');
        return { joined, cleared: { doc: f.editor.state.doc.toJSON(), selection: f.editor.state.selection.toJSON() } };
      } finally {
        f.close();
      }
    });
    expect(results[1]).toEqual(results[0]);
  });
});
