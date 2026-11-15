import { Editor, Extension } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { TextSelection, type Transaction } from '@tiptap/pm/state';
import { fromPlainText } from '@rezics/document';
import { editorExtensions } from '../src/components/editor-surface.ts';
import {
  clearEditorFindHighlights,
  EditorFindHighlights,
  findDocumentMatches,
  replaceDocumentMatches,
} from '../src/components/editor-find.tsx';
import { editorSnapshot } from '../src/components/rich-text-editor-snapshot.ts';
import {
  recordTextReplayBatch,
  skipProvenTextReplay,
  compactTransactionMetrics,
} from '../src/components/editor-compact-transaction.ts';
import { undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import { trackPosition } from '../src/components/editor-uploads.ts';
import { editorDOM } from '../tests/helpers/editor-dom.ts';

type Case = { characters: number; spaced: boolean };
const cases: readonly Case[] = [
  { characters: 100_000, spaced: false },
  { characters: 100_000, spaced: true },
  { characters: 1_900_000, spaced: true },
  { characters: 1_900_000, spaced: false },
];
const report = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const round = (milliseconds: number) => Math.round(milliseconds * 100) / 100;

const History = Extension.create({ name: 'benchmarkHistory', addProseMirrorPlugins: () => [history()] });
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function measure(input: Case): Promise<void> {
  return editorDOM(async () => {
    const source = input.spaced ? 'a '.repeat(input.characters / 2) : 'a'.repeat(input.characters);
    const replacement = input.characters > 1_000_000 ? 'b' : 'bb';
    const element = document.createElement('div');
    document.body.append(element);
    const editor = new Editor({
      element,
      extensions: [History, EditorFindHighlights, ...editorExtensions('blocks')],
      content: fromPlainText(source, 'blocks').doc,
      injectCSS: false,
      coreExtensionOptions: { delete: { filterTransaction: skipProvenTextReplay } },
      onTransaction: ({ transaction, appendedTransactions }) =>
        recordTextReplayBatch(transaction, appendedTransactions),
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      await tick();
      const doc = editor.state.doc;
      const snapshot = editorSnapshot(doc, 'blocks');
      const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
      // A spaced case bookmarks the unchanged space immediately after a match.
      const position = input.spaced ? Math.floor(input.characters / 4) * 2 + 2 : Math.floor(input.characters / 2);
      const bookmark = TextSelection.create(doc, position).getBookmark();
      const pending = trackPosition(editor, position);
      report({
        stage: 'start',
        ...input,
        bytes,
        bookmark: position,
        scope: 'real DOM-backed Tiptap EditorView dispatch; excludes Chromium layout',
      });
      let started = performance.now();
      const found = findDocumentMatches(doc, 'a', { matchCase: true, wholeWord: false });
      const searchMs = round(performance.now() - started);
      report({ stage: 'search', ...input, matches: found.total, searchMs });
      started = performance.now();
      let transaction: Transaction | null = replaceDocumentMatches(editor.state, found.matches, replacement);
      const buildMs = round(performance.now() - started);
      if (!transaction) {
        report({ stage: 'refused', ...input, matches: found.total, searchMs, buildMs });
        return;
      }
      const steps = transaction.steps.length;
      report({ stage: 'built', ...input, matches: found.total, steps, buildMs });
      started = performance.now();
      clearEditorFindHighlights(editor);
      editor.view.dispatch(transaction);
      const applyMs = round(performance.now() - started);
      started = performance.now();
      const mapped = bookmark.map(transaction.mapping).resolve(editor.state.doc).from;
      const bookmarkMs = round(performance.now() - started);
      const expected =
        position +
        found.matches.reduce((count, match) => count + Number(match.to <= position), 0) * (replacement.length - 1);
      if (mapped !== expected) throw new Error(`Insertion bookmark moved to ${mapped}; expected ${expected}`);
      if (pending.get() !== expected)
        throw new Error('The live insertion tracker disagrees with native bookmark mapping');
      const construction = compactTransactionMetrics(transaction);
      transaction = null;
      await tick();
      if (input.spaced) {
        editor.view.dispatch(editor.state.tr.insertText('!', pending.get()).setMeta('addToHistory', false));
        editor.view.dispatch(
          editor.state.tr
            .setNodeMarkup(0, undefined, { ...editor.state.doc.firstChild!.attrs, id: 'benchmark-retained-id' })
            .setMeta('addToHistory', false),
        );
        await tick();
      }
      const undoStart = performance.now();
      if (!undoCommand.run(editor, () => undefined)) throw new Error('Bulk undo was not applied');
      const undoMs = round(performance.now() - undoStart);
      if (input.spaced && pending.get() !== editor.state.doc.textContent.indexOf('!') + 2)
        throw new Error('Undo lost the pending gap insertion');
      editorSnapshot(editor.state.doc, 'blocks');
      await tick();
      const redoStart = performance.now();
      if (!redoCommand.run(editor, () => undefined)) throw new Error('Bulk redo was not applied');
      const redoMs = round(performance.now() - redoStart);
      if (input.spaced && pending.get() !== editor.state.doc.textContent.indexOf('!') + 2)
        throw new Error('Redo lost the pending gap insertion');
      editorSnapshot(editor.state.doc, 'blocks');
      pending.stop();
      const peak =
        process.platform === 'linux' ? /VmHWM:\s+(\d+) kB/.exec(await Bun.file('/proc/self/status').text()) : null;
      report({
        stage: 'complete',
        ...input,
        matches: found.total,
        steps,
        searchMs,
        buildMs,
        applyMs,
        bookmarkMs,
        bookmark: mapped,
        bookmarkPreserved: true,
        undoMs,
        redoMs,
        construction,
        ...(peak ? { peakRssKiB: Number(peak[1]) } : {}),
      });
    } finally {
      editor.destroy();
      element.remove();
    }
  });
}

if (process.argv[2] === '--case') {
  const input = cases[Number(process.argv[3])];
  if (!input) throw new Error('Expected a benchmark case index.');
  await measure(input);
} else {
  let active: Bun.Subprocess | null = null;
  let interrupted = false;
  let incomplete = false;
  const stop = () => {
    interrupted = true;
    active?.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    for (const [index, input] of cases.entries()) {
      if (interrupted) break;
      const started = performance.now();
      const child = Bun.spawn([process.execPath, import.meta.path, '--case', String(index)], {
        stdout: 'inherit',
        stderr: 'inherit',
      });
      active = child;
      let timedOut = false;
      let kill: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        kill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      }, 45_000);
      try {
        const code = await child.exited;
        if (timedOut || code !== 0) {
          incomplete = true;
          report({
            stage: timedOut ? 'time-limit' : 'child-failed',
            ...input,
            code,
            elapsedMs: round(performance.now() - started),
            boundMs: 45_000,
          });
        }
      } finally {
        clearTimeout(timeout);
        if (kill) clearTimeout(kill);
        active = null;
      }
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    active?.kill('SIGTERM');
  }
  process.exitCode = interrupted ? 143 : incomplete ? 1 : 0;
}
