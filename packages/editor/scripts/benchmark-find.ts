import { getSchema } from '@tiptap/core';
import { history } from '@tiptap/pm/history';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { findDocumentMatches, replaceDocumentMatches } from '../src/components/editor-find.tsx';
import { editorSnapshot } from '../src/components/rich-text-editor-snapshot.ts';

type Case = { characters: number; spaced: boolean };
const cases: readonly Case[] = [
  { characters: 100_000, spaced: false },
  { characters: 100_000, spaced: true },
  { characters: 1_900_000, spaced: true },
];
const report = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const round = (milliseconds: number) => Math.round(milliseconds * 100) / 100;

function measure(input: Case): void {
  const schema = getSchema(documentExtensionsForProfile('blocks'));
  const source = input.spaced ? 'a '.repeat(input.characters / 2) : 'a'.repeat(input.characters);
  const replacement = input.characters > 1_000_000 ? 'b' : 'bb';
  const doc = schema.nodes.doc!.create(
    null,
    schema.nodes.paragraph!.create({ id: 'benchmark-paragraph' }, schema.text(source)),
  );
  const snapshot = editorSnapshot(doc, 'blocks');
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  let state = EditorState.create({ schema, doc, plugins: [history()] });
  // A spaced case bookmarks the unchanged space immediately after a match.
  const position = input.spaced ? Math.floor(input.characters / 4) * 2 + 2 : Math.floor(input.characters / 2);
  const bookmark = TextSelection.create(doc, position).getBookmark();
  report({
    stage: 'start',
    ...input,
    bytes,
    bookmark: position,
    scope: 'model; excludes DOM layout and native view dispatch',
  });
  let started = performance.now();
  const found = findDocumentMatches(doc, 'a', { matchCase: true, wholeWord: false });
  const searchMs = round(performance.now() - started);
  report({ stage: 'search', ...input, matches: found.total, searchMs });
  started = performance.now();
  const transaction = replaceDocumentMatches(state, found.matches, replacement);
  const buildMs = round(performance.now() - started);
  if (!transaction) {
    report({ stage: 'refused', ...input, matches: found.total, searchMs, buildMs });
    return;
  }
  report({ stage: 'built', ...input, matches: found.total, steps: transaction.steps.length, buildMs });
  started = performance.now();
  state = state.apply(transaction);
  const applyMs = round(performance.now() - started);
  started = performance.now();
  const mapped = bookmark.map(transaction.mapping).resolve(state.doc).from;
  const bookmarkMs = round(performance.now() - started);
  const expected =
    position +
    found.matches.reduce((count, match) => count + Number(match.to <= position), 0) * (replacement.length - 1);
  if (mapped !== expected) throw new Error(`Insertion bookmark moved to ${mapped}; expected ${expected}`);
  report({
    stage: 'complete',
    ...input,
    matches: found.total,
    steps: transaction.steps.length,
    searchMs,
    buildMs,
    applyMs,
    bookmarkMs,
    bookmark: mapped,
    bookmarkPreserved: true,
  });
}

if (process.argv[2] === '--case') {
  const input = cases[Number(process.argv[3])];
  if (!input) throw new Error('Expected a benchmark case index.');
  measure(input);
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
