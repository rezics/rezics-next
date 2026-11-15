import { expect, test } from 'bun:test';
import { Editor, Extension, getSchema, type ChainedCommands } from '@tiptap/core';
import { history, closeHistory } from '@tiptap/pm/history';
import { type Mark, type MarkType } from '@tiptap/pm/model';
import { type Transaction } from '@tiptap/pm/state';
import { Transform, type Step } from '@tiptap/pm/transform';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { runCompactEditorChain } from '../src/components/editor-compact-commands.ts';
import {
  compactTransactionMetrics,
  recordTextReplayBatch,
  skipProvenTextReplay,
} from '../src/components/editor-compact-transaction.ts';
import { editorExtensions } from '../src/components/editor-surface.ts';
import { markCommands, undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import { collectNativeMarkRemoval } from '../src/components/editor-native-marks.ts';
import { editorDOM } from './helpers/editor-dom.ts';

const History = Extension.create({ name: 'compactMarkHistory', addProseMirrorPlugins: () => [history()] });
const mixed = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'p1' },
      content: [
        { type: 'text', text: 'plain ' },
        { type: 'text', text: 'styled', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { color: 'red' } }] },
        { type: 'text', text: ' code', marks: [{ type: 'code' }] },
      ],
    },
    {
      type: 'paragraph',
      attrs: { id: 'p2' },
      content: [
        { type: 'text', text: 'next', marks: [{ type: 'italic' }] },
        {
          type: 'ruby',
          attrs: { rt: 'reading' },
          content: [{ type: 'text', text: 'base', marks: [{ type: 'bold' }] }],
        },
        { type: 'mention', attrs: { accountId: '00000000-0000-4000-8000-000000000000' } },
        { type: 'text', text: 'last' },
      ],
    },
  ],
};

test('maintained command chains keep native mixed selections, atoms, caret marks and preventDispatch behavior', async () =>
  editorDOM(() => {
    const transactions: (Transaction | undefined)[] = [];
    const editors = [0, 1].map(
      (index) =>
        new Editor({
          extensions: documentExtensionsForProfile('blocks'),
          injectCSS: false,
          content: mixed,
          onTransaction: ({ transaction }) => {
            transactions[index] = transaction;
          },
          editorProps: { handleScrollToSelection: () => true },
        }),
    );
    const [native, compact] = editors as [Editor, Editor];
    const run = (configure: (chain: ChainedCommands) => ChainedCommands) => {
      transactions.fill(undefined);
      expect(runCompactEditorChain(compact, configure)).toBe(configure(native.chain()).run());
      expect(compact.getJSON()).toEqual(native.getJSON());
      expect(compact.state.selection.toJSON()).toEqual(native.state.selection.toJSON());
      expect(compact.state.selection.$from.doc).toBe(compact.state.doc);
      expect(compact.state.storedMarks?.map((mark) => mark.toJSON())).toEqual(
        native.state.storedMarks?.map((mark) => mark.toJSON()),
      );
      expect(transactions[1]?.steps.map((step) => step.toJSON())).toEqual(
        transactions[0]?.steps.map((step) => step.toJSON()),
      );
    };
    try {
      const end = native.state.doc.content.size - 1;
      run((chain) => chain.setTextSelection({ from: 1, to: end }).toggleMark('bold'));
      run((chain) => chain.toggleMark('italic'));
      run((chain) => chain.unsetAllMarks());
      run((chain) => chain.setMark('textStyle', { color: 'purple' }));
      run((chain) => chain.setTextSelection(2).toggleMark('underline'));
      run((chain) => chain.insertContent('x'));
      const before = compact.state.doc;
      run((chain) =>
        chain.setMark('bold').command(({ tr }) => {
          tr.setMeta('preventDispatch', true);
          return false;
        }),
      );
      expect(compact.state.doc).toBe(before);
      run((chain) => chain.setMark('strike').command(() => false));
    } finally {
      for (const editor of editors) editor.destroy();
    }
  }));

test('indexed native removal emits the exact maintained collector steps for mixed marks and boundaries', () => {
  const schema = getSchema(documentExtensionsForProfile('blocks'));
  let seed = 0x7812ac;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  for (let fixture = 0; fixture < 60; fixture++) {
    const content = Array.from({ length: 24 }, (_, index) => {
      const marks = [schema.marks.textStyle!.create({ color: `color-${next() % 4}` })];
      if (next() % 2) marks.push(schema.marks.bold!.create());
      if (next() % 2) marks.push(schema.marks.italic!.create());
      return schema.text(`word${index} `, marks);
    });
    const source = schema.nodes.doc!.create(null, schema.nodes.paragraph!.create({ id: 'p' }, content));
    const from = 1 + (next() % 12),
      to = source.content.size - 1 - (next() % 12);
    const choices: (Mark | MarkType | null | undefined)[] = [
      undefined,
      null,
      schema.marks.textStyle,
      schema.marks.bold,
      content[next() % content.length]!.marks[0],
    ];
    for (const mark of choices) {
      const native = new Transform(source).removeMark(from, to, mark);
      const steps: Step[] = [];
      collectNativeMarkRemoval(source, from, to, mark, (step) => steps.push(step));
      expect(steps.map((step) => step.toJSON())).toEqual(native.steps.map((step) => step.toJSON()));
    }
  }
});

// This is a fixture + six real EditorView dispatches, not a five-second product latency SLA. Phase costs stay reported.
test(
  'real many-run mark commands and clear formatting dispatch native steps with bounded prefix materialization and undo',
  async () =>
    editorDOM(() => {
      const setupStarted = performance.now();
      let changed: Transaction | undefined;
      const count = 6_000;
      const editor = new Editor({
        extensions: [History, ...editorExtensions('blocks')],
        injectCSS: false,
        coreExtensionOptions: { delete: { filterTransaction: skipProvenTextReplay } },
        content: {
          type: 'doc',
          content: Array.from({ length: count }, (_, index) => ({
            type: 'paragraph',
            attrs: { id: `p${index}`, lang: 'ja', textAlign: 'right' },
            content: [
              {
                type: 'text',
                text: 'sample',
                marks: [{ type: 'textStyle', attrs: { color: `color-${index}` } }, { type: 'italic' }],
              },
            ],
          })),
        },
        onTransaction: ({ transaction, appendedTransactions }) => {
          recordTextReplayBatch(transaction, appendedTransactions);
          if (transaction.docChanged) changed = transaction;
        },
        editorProps: { handleScrollToSelection: () => true },
      });
      const setupFinished = performance.now();
      try {
        const before = editor.state.doc;
        editor.commands.setTextSelection({ from: 1, to: before.content.size - 1 });
        const started = performance.now();
        markCommands.find((command) => command.id === 'bold')!.run(editor, () => undefined);
        const marked = performance.now();
        const bold = editor.state.doc;
        const boldStats = compactTransactionMetrics(changed!)!;
        expect(boldStats.fastSteps).toBe(count);
        expect(boldStats.materializations).toBeLessThanOrEqual(2);
        expect(boldStats.ordinarySteps).toBe(0);
        expect(skipProvenTextReplay(changed!)).toBe(true);
        bold.forEach((node, _position, index) => {
          expect(node.attrs).toEqual(before.child(index).attrs);
          expect(node.firstChild!.marks.some((mark) => mark.type.name === 'bold')).toBe(true);
        });
        const boldHistoryStart = performance.now();
        expect(undoCommand.run(editor, () => undefined)).toBe(true);
        expect(editor.state.doc.eq(before)).toBe(true);
        expect(redoCommand.run(editor, () => undefined)).toBe(true);
        expect(editor.state.doc.eq(bold)).toBe(true);
        const boldHistoryEnd = performance.now();
        editor.view.dispatch(closeHistory(editor.state.tr));
        const clearStart = performance.now();
        markCommands.find((command) => command.id === 'clearFormatting')!.run(editor, () => undefined);
        const cleared = performance.now();
        const clearStats = compactTransactionMetrics(changed!)!;
        expect(clearStats.materializations).toBeLessThanOrEqual(3);
        // The uniform bold/italic runs each span multiple paragraphs: two ordinary native steps,
        // rather than one retained document per differently styled text run.
        expect(clearStats.ordinarySteps).toBe(2);
        expect(skipProvenTextReplay(changed!)).toBe(true);
        editor.state.doc.forEach((node, _position, index) => {
          expect(node.attrs).toEqual(before.child(index).attrs);
          expect(node.firstChild!.marks).toHaveLength(0);
        });
        const clearHistoryStart = performance.now();
        expect(undoCommand.run(editor, () => undefined)).toBe(true);
        expect(editor.state.doc.eq(bold)).toBe(true);
        expect(redoCommand.run(editor, () => undefined)).toBe(true);
        expect(editor.state.doc.firstChild!.firstChild!.marks).toHaveLength(0);
        console.info(
          JSON.stringify({
            nativeMarkCommands: true,
            paragraphs: count,
            fixtureAndEditorViewSetupMs: Math.round(setupFinished - setupStarted),
            boldSteps: boldStats.fastSteps,
            boldMaterializations: boldStats.materializations,
            boldDispatchMs: Math.round(marked - started),
            boldUndoRedoMs: Math.round(boldHistoryEnd - boldHistoryStart),
            clearSteps: clearStats.fastSteps,
            clearMaterializations: clearStats.materializations,
            clearDispatchMs: Math.round(cleared - clearStart),
            clearUndoRedoMs: Math.round(performance.now() - clearHistoryStart),
          }),
        );
      } finally {
        const destroyStarted = performance.now();
        editor.destroy();
        console.info(
          JSON.stringify({
            nativeMarkCommandCleanup: true,
            editorViewDestroyMs: Math.round(performance.now() - destroyStarted),
            fixtureThroughDestroyMs: Math.round(performance.now() - setupStarted),
          }),
        );
      }
    }),
  10_000,
);
