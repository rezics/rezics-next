import {
  checkDocument,
  documentVersion,
  normalizeDocument,
  withDocumentIds,
  type DocumentNode,
  type DocumentSnapshot,
} from '@rezics/document';
import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Editor } from '@tiptap/core';
import { closeHistory, redoDepth, undoDepth } from '@tiptap/pm/history';
import { type Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { useState } from 'react';
import { expect, userEvent as storyUserEvent, waitFor, within } from 'storybook/test';
import { RichTextEditor } from './rich-text-editor.tsx';
import { compactTransactionMetrics } from './editor-compact-transaction.ts';
import { editorSnapshot, maxSnapshotBytes } from './rich-text-editor-snapshot.ts';
import { trackPosition } from './editor-uploads.ts';

type Case = 'chapter' | 'dense' | 'spaced';
type RecordValue = Record<string, unknown>;
type Run = {
  kind: Case;
  initial: DocumentSnapshot;
  latest: DocumentSnapshot;
  started: number;
  fixtureMs: number;
  published: number;
  pending: number;
  pendingAt: number;
  publishedAt: number;
  errors: number;
  output: HTMLOutputElement | null;
};
const runs = new WeakMap<HTMLElement, Run>();
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const round = (value: number) => Math.round(value * 100) / 100;
const frames = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const text = (value: string, marks?: DocumentNode['marks']): DocumentNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (id: string, content: DocumentNode[]): DocumentNode => ({
  type: 'paragraph',
  attrs: { id },
  content,
});

function fixture(kind: Case): DocumentSnapshot {
  const runsPerCase = kind === 'chapter' ? 600 : kind === 'dense' ? 3 : 1_024;
  const make = (lengths: readonly number[]) => {
    const payload: DocumentNode[] = [];
    const inline = (index: number) => {
      const pattern = kind === 'dense' ? 'a' : kind === 'spaced' ? 'a ' : 'The sea carries a quiet story. ';
      const value = pattern.repeat(Math.ceil(lengths[index]! / pattern.length)).slice(0, lengths[index]!);
      return text(
        value,
        index % 3 === 0
          ? [{ type: 'bold' }]
          : index % 3 === 1
            ? [
                { type: 'link', attrs: { href: 'https://example.test/chapter' } },
                { type: 'textStyle', attrs: { color: '#b91c1c' } },
              ]
            : undefined,
      );
    };
    if (kind === 'dense')
      payload.push(
        paragraph(
          'perf-body-0',
          lengths.map((_length, index) => inline(index)),
        ),
      );
    else
      for (let index = 0; index < lengths.length; index += 2)
        payload.push(paragraph(`perf-body-${index / 2}`, [inline(index), inline(index + 1)]));
    const content: DocumentNode[] = [
      { type: 'heading', attrs: { id: 'perf-heading', level: 1 }, content: [text('Story')] },
      paragraph('perf-sentinel', [
        text('Keep '),
        text('these styles', [{ type: 'bold' }, { type: 'italic' }]),
        { type: 'ruby', attrs: { rt: 'じ' }, content: [text('字')] },
        {
          type: 'extensionInline',
          attrs: {
            id: 'perf-inline',
            definition: 'example.proof',
            version: '1',
            payload: { retained: ['opaque', 7] },
            fallback: 'Kept widget',
          },
        },
        { type: 'footnoteReference', attrs: { label: 'Proof' } },
      ]),
      ...payload,
    ];
    if (kind === 'chapter')
      content.push(
        {
          type: 'taskList',
          attrs: { id: 'perf-tasks' },
          content: [
            {
              type: 'taskItem',
              attrs: { id: 'perf-task', checked: false },
              content: [paragraph('perf-task-body', [text('Review the chapter')])],
            },
          ],
        },
        {
          type: 'table',
          attrs: { id: 'perf-table' },
          content: Array.from({ length: 4 }, (_row, row) => ({
            type: 'tableRow',
            attrs: { id: `perf-row-${row}` },
            content: Array.from({ length: 4 }, (_column, column) => ({
              type: 'tableCell',
              attrs: { id: `perf-cell-${row}-${column}` },
              content: [paragraph(`perf-cell-body-${row}-${column}`, [text(`${row + 1},${column + 1}`)])],
            })),
          })),
        },
      );
    content.push({
      type: 'footnoteDefinition',
      attrs: { id: 'perf-note', label: 'Proof' },
      content: [paragraph('perf-note-body', [text('Kept note', [{ type: 'italic' }])])],
    });
    return normalizeDocument({
      version: documentVersion,
      profile: 'blocks',
      doc: withDocumentIds({ type: 'doc', content }),
    });
  };
  if (kind === 'chapter') return make(Array.from({ length: runsPerCase }, () => 180));
  const baseline = make(Array.from({ length: runsPerCase }, () => 1));
  const payloadBytes = 1_950_000 - bytes(baseline) + runsPerCase;
  const length = Math.floor(payloadBytes / runsPerCase),
    remainder = payloadBytes % runsPerCase;
  return make(Array.from({ length: runsPerCase }, (_value, index) => length + Number(index < remainder)));
}

function PerformanceHost({ kind }: { kind: Case }) {
  const [run] = useState<Run>(() => {
    const started = performance.now(),
      initial = fixture(kind);
    return {
      kind,
      initial,
      latest: initial,
      started,
      fixtureMs: performance.now() - started,
      published: 0,
      pending: 0,
      pendingAt: started,
      publishedAt: started,
      errors: 0,
      output: null,
    };
  });
  const [value, setValue] = useState(run.initial);
  return (
    <div
      className="mx-auto max-w-5xl"
      data-editor-performance={kind}
      ref={(element) => {
        if (element) runs.set(element, run);
      }}
    >
      <div className="max-h-[70vh] overflow-auto border p-3">
        <RichTextEditor
          value={value}
          label="Measured chapter"
          preferences={{ toolbar: 'fixed' }}
          onSnapshotPending={() => {
            run.pending++;
            run.pendingAt = performance.now();
          }}
          onSnapshotError={() => {
            run.errors++;
          }}
          onChange={(next) => {
            run.latest = next;
            run.published++;
            run.publishedAt = performance.now();
            setValue(next);
          }}
        />
      </div>
      <output
        aria-label="Performance evidence"
        className="mt-3 block whitespace-pre-wrap break-words font-mono text-xs"
        ref={(element) => {
          run.output = element;
        }}
      >
        Ready for measurement. Timings are diagnostic observations, not an interaction SLA.
      </output>
    </div>
  );
}

function memory(): RecordValue {
  const current = (
    performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
    }
  ).memory;
  return current
    ? {
        source: 'Chromium performance.memory checkpoint; not process peak',
        usedJSHeapBytes: current.usedJSHeapSize,
        totalJSHeapBytes: current.totalJSHeapSize,
        jsHeapLimitBytes: current.jsHeapSizeLimit,
      }
    : { source: 'unavailable; no process-peak claim' };
}
function report(run: Run, stage: string, details: RecordValue = {}) {
  const value = {
    editorPerformance: true,
    case: run.kind,
    stage,
    atMs: round(performance.now()),
    memory: memory(),
    ...details,
  };
  console.info(JSON.stringify(value));
  if (run.output) run.output.textContent = JSON.stringify(value, null, 2);
}
function identities(document: ProseMirrorNode): string[] {
  const values: string[] = [];
  document.descendants((node) => {
    if (typeof node.attrs.id === 'string') values.push(node.attrs.id);
  });
  return values;
}
function shape(document: ProseMirrorNode): string {
  const values: unknown[] = [];
  document.descendants((node) => {
    values.push(
      node.isText
        ? { type: node.type.name, marks: node.marks.map((mark) => mark.toJSON()) }
        : { type: node.type.name, attrs: node.attrs, marks: node.marks.map((mark) => mark.toJSON()) },
    );
  });
  return JSON.stringify(values);
}
function payloadRanges(document: ProseMirrorNode) {
  const ranges: { from: number; to: number; value: string }[] = [];
  document.descendants((node, position, parent) => {
    if (node.isText && typeof parent?.attrs.id === 'string' && parent.attrs.id.startsWith('perf-body-'))
      ranges.push({ from: position, to: position + node.nodeSize, value: node.text! });
  });
  return ranges;
}
async function published(run: Run, after: number, editor: Editor) {
  const expected = editor.state.doc;
  await waitFor(
    () => {
      expect(run.published).toBeGreaterThan(after);
      expect(run.errors).toBe(0);
      // A long burst can publish before its last key. Wait for this exact document, not an earlier acknowledgement.
      expect(editor.schema.nodeFromJSON(run.latest.doc).eq(expected)).toBe(true);
    },
    { timeout: 10_000 },
  );
  expect(checkDocument(run.latest)).toBe(true);
  expect(bytes(run.latest)).toBeLessThanOrEqual(maxSnapshotBytes);
  return round(run.publishedAt - run.pendingAt);
}

async function input() {
  // The normal Storybook renderer still loads this story. Only Vitest browser mode supplies this virtual module.
  const browser = await import('vitest/browser').catch(() => null);
  if (browser) {
    expect(browser.server.provider).toBe('playwright');
    expect(browser.server.browser).toBe('chromium');
    return { events: browser.userEvent, provider: 'Vitest Playwright Chromium', trustedKeysExpected: true };
  }
  return {
    events: storyUserEvent,
    provider: 'storybook/test synthetic input in the current browser',
    trustedKeysExpected: false,
  };
}

async function journey(canvasElement: HTMLElement) {
  const host = canvasElement.querySelector<HTMLElement>('[data-editor-performance]')!;
  const run = runs.get(host)!;
  const canvas = within(canvasElement);
  const textbox = await canvas.findByRole('textbox', { name: 'Measured chapter' });
  const editor = (textbox as HTMLElement & { editor: Editor }).editor;
  const driver = await input();
  const events = driver.events;
  const original = editor.state.doc;
  const originalIds = identities(original),
    originalShape = shape(original);
  const inputSamples: { modelMs: number; twoFramesMs: number; trusted: boolean }[] = [];
  const longTasks: number[] = [];
  let transactionAt = 0,
    lastChanged: Transaction | undefined;
  let key: { at: number; trusted: boolean } | null = null;
  const onKey = (event: KeyboardEvent) => {
    if (event.key.length === 1 && event.target instanceof Node && textbox.contains(event.target))
      key = { at: performance.now(), trusted: event.isTrusted };
  };
  const onTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (transaction.docChanged) {
      transactionAt = performance.now();
      lastChanged = transaction;
    }
  };
  const observer =
    typeof PerformanceObserver === 'function' && PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) if (longTasks.length < 50) longTasks.push(round(entry.duration));
        })
      : null;
  observer?.observe({ type: 'longtask', buffered: false });
  // Capture before React's root shortcut listener; target-capture would observe history after it has dispatched.
  document.addEventListener('keydown', onKey, true);
  editor.on('transaction', onTransaction);
  let pending: ReturnType<typeof trackPosition> | null = null;
  try {
    await frames();
    const initialSnapshot = editorSnapshot(original, 'blocks');
    expect(checkDocument(initialSnapshot)).toBe(true);
    const size = bytes(initialSnapshot);
    expect(size).toBeLessThanOrEqual(maxSnapshotBytes);
    if (run.kind !== 'chapter') {
      expect(size).toBeGreaterThanOrEqual(1_900_000);
      expect(size).toBeLessThanOrEqual(2_000_000);
    }
    expect(new Set(originalIds).size).toBe(originalIds.length);
    report(run, 'ready', {
      browser: navigator.userAgent,
      location: location.href,
      sourceIdentity: 'exact committed revision belongs to receiving-run metadata',
      inputProvider: driver.provider,
      trustedKeysExpected: driver.trustedKeysExpected,
      pasteDriver: 'synthetic ClipboardEvent; not trusted OS clipboard input',
      bytes: size,
      characters: original.textContent.length,
      units: originalIds.length,
      domElements: textbox.querySelectorAll('*').length,
      fixtureMs: round(run.fixtureMs),
      fixtureStartToTwoFramesMs: round(performance.now() - run.started),
    });
    expect(
      driver.trustedKeysExpected,
      'Run performance play functions through the existing Vitest Playwright Chromium provider. Interactive fixture rendering remains available without autoplay.',
    ).toBe(true);
    const ranges = payloadRanges(original);
    const positions = [
      ranges[0]!.from + 2,
      Math.floor((ranges[Math.floor(ranges.length / 2)]!.from + ranges[Math.floor(ranges.length / 2)]!.to) / 2),
      ranges.at(-1)!.to - 2,
    ];
    for (const [index, position] of positions.entries()) {
      report(run, 'typing-start', { position: ['beginning', 'middle', 'end'][index] });
      editor.view.dispatch(
        closeHistory(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position))),
      );
      editor.view.focus();
      const before = editor.state.doc,
        publication = run.published,
        sampleStart = inputSamples.length,
        historyBefore = undoDepth(editor.state);
      for (const character of 'xyzxyzxyzxyz') {
        key = null;
        transactionAt = 0;
        await events.keyboard(character);
        await frames();
        const observed = key as { at: number; trusted: boolean } | null;
        expect(observed).not.toBeNull();
        expect(transactionAt).toBeGreaterThanOrEqual(observed!.at);
        inputSamples.push({
          modelMs: round(transactionAt - observed!.at),
          twoFramesMs: round(performance.now() - observed!.at),
          trusted: observed!.trusted,
        });
      }
      const publicationMs = await published(run, publication, editor);
      expect(editor.state.doc.textContent.includes('xyzxyzxyzxyz')).toBe(true);
      expect(identities(editor.state.doc)).toEqual(originalIds);
      report(run, 'typing-complete', {
        position: ['beginning', 'middle', 'end'][index],
        samples: inputSamples.slice(sampleStart),
        deferredPublicationMs: publicationMs,
      });
      const undoPublication = run.published;
      let undoEvents = 0;
      // Slow measured keystrokes may naturally cross the native history grouping delay.
      while (!editor.state.doc.eq(before)) {
        const depth = undoDepth(editor.state);
        expect(depth).toBeGreaterThan(historyBefore);
        await events.keyboard('{Control>}z{/Control}');
        expect(undoDepth(editor.state)).toBeLessThan(depth);
        undoEvents++;
      }
      await published(run, undoPublication, editor);
      report(run, 'typing-history-complete', {
        position: ['beginning', 'middle', 'end'][index],
        nativeUndoEvents: undoEvents,
        originalRestored: true,
      });
    }
    if (driver.trustedKeysExpected) expect(inputSamples.every((sample) => sample.trusted)).toBe(true);
    report(run, 'selection-start');
    const middle = positions[1]!;
    const selectionPublication = run.published,
      selectionPending = run.pending;
    let started = performance.now();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, middle - 4, middle + 4)));
    editor.view.focus();
    await frames();
    const forwardMs = round(performance.now() - started);
    started = performance.now();
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, middle + 4, middle - 4)));
    editor.view.focus();
    await frames();
    const backwardMs = round(performance.now() - started);
    expect(editor.state.selection.anchor).toBeGreaterThan(editor.state.selection.head);
    const domSelection = window.getSelection()!;
    expect(editor.view.posAtDOM(domSelection.anchorNode!, domSelection.anchorOffset)).toBe(
      editor.state.selection.anchor,
    );
    expect(editor.view.posAtDOM(domSelection.focusNode!, domSelection.focusOffset)).toBe(editor.state.selection.head);
    if (driver.trustedKeysExpected) {
      const previousHead = editor.state.selection.head;
      await events.keyboard('{Shift>}{ArrowLeft}{/Shift}');
      await waitFor(() => expect(editor.state.selection.head).toBe(previousHead - 1));
    }
    expect(run.published).toBe(selectionPublication);
    expect(run.pending).toBe(selectionPending);
    report(run, 'selection-complete', {
      forwardTransactionToTwoFramesMs: forwardMs,
      backwardTransactionToTwoFramesMs: backwardMs,
      nativeShiftArrowExercised: driver.trustedKeysExpected,
      directionPreserved: true,
    });

    report(run, 'paste-start', { driver: 'synthetic ClipboardEvent', trusted: false });
    editor.view.dispatch(closeHistory(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, middle))));
    editor.view.focus();
    const pasteBefore = editor.state.doc,
      pastePublication = run.published;
    const transfer = new DataTransfer();
    transfer.setData(
      'text/html',
      `<p><strong>paste-proof</strong> ${'safe text '.repeat(380)} <a href="https://example.test/pasted">safe-link</a> <span style="color:#dc2626">colored-proof</span><script>unsafe-script-proof()</script></p>`,
    );
    transfer.setData('text/plain', `paste-proof ${'safe text '.repeat(380)} safe-link colored-proof`);
    started = performance.now();
    textbox.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    const pasteDispatchMs = round(performance.now() - started);
    await frames();
    const pasteTwoFramesMs = round(performance.now() - started);
    await published(run, pastePublication, editor);
    expect(editor.state.doc.textContent.includes('paste-proof')).toBe(true);
    expect(editor.state.doc.textContent.includes('unsafe-script-proof')).toBe(false);
    let boldPaste = false,
      linkPaste = false,
      colorPaste = false;
    editor.state.doc.descendants((node) => {
      if (node.text?.includes('paste-proof')) boldPaste = node.marks.some((mark) => mark.type.name === 'bold');
      if (node.text?.includes('safe-link'))
        linkPaste = node.marks.some(
          (mark) => mark.type.name === 'link' && mark.attrs.href === 'https://example.test/pasted',
        );
      if (node.text?.includes('colored-proof'))
        colorPaste = node.marks.some((mark) => mark.type.name === 'textStyle' && mark.attrs.color);
    });
    expect(boldPaste && linkPaste && colorPaste).toBe(true);
    const pastedIds = identities(editor.state.doc);
    expect(new Set(pastedIds).size).toBe(pastedIds.length);
    for (const id of originalIds) expect(pastedIds).toContain(id);
    report(run, 'paste-complete', {
      dispatchMs: pasteDispatchMs,
      dispatchToTwoFramesMs: pasteTwoFramesMs,
      deferredPublicationMs: round(run.publishedAt - run.pendingAt),
      idsUnique: true,
      allowedMarksKept: true,
      unsafeContentRemoved: true,
    });
    const pasteUndoPublication = run.published;
    editor.view.focus();
    await events.keyboard('{Control>}z{/Control}');
    await waitFor(() => expect(editor.state.doc.eq(pasteBefore)).toBe(true));
    await published(run, pasteUndoPublication, editor);

    report(run, 'snapshot-start');
    started = performance.now();
    const admitted = editorSnapshot(editor.state.doc, 'blocks');
    const snapshotMs = round(performance.now() - started);
    expect(checkDocument(admitted)).toBe(true);
    expect(bytes(admitted)).toBeLessThanOrEqual(maxSnapshotBytes);
    expect(shape(editor.state.doc) === originalShape).toBe(true);
    report(run, 'snapshot-complete', { synchronousSnapshotMs: snapshotMs, bytes: bytes(admitted) });

    const beforeBulk = editor.state.doc;
    let total = 0;
    beforeBulk.descendants((node) => {
      if (node.isText) for (const character of node.text!) if (character === 'a') total++;
    });
    expect(total).toBeGreaterThan(0);
    editor.commands.setTextSelection(positions[0]!);
    await events.click(canvas.getByRole('button', { name: 'Find and replace' }));
    const find = within(canvas.getByRole('region', { name: 'Find and replace' }));
    await events.click(find.getByRole('checkbox', { name: 'Match case' }));
    report(run, 'search-start', { query: 'a', logicalMatchesExpected: total });
    started = performance.now();
    await events.type(find.getByRole('textbox', { name: 'Find text' }), 'a');
    await waitFor(() => expect(find.getByRole('status')).toHaveTextContent(`of ${total} matches`), { timeout: 10_000 });
    await frames();
    report(run, 'search-complete', {
      searchAndTwoFramesMs: round(performance.now() - started),
      logicalMatches: total,
      retainedHighlightElements: textbox.querySelectorAll('.editor-find-match').length,
    });
    await events.click(find.getByRole('button', { name: 'Next match' }));
    await events.click(find.getByRole('button', { name: 'Previous match' }));
    if (run.kind === 'chapter') {
      await events.click(find.getByRole('button', { name: 'Match case / Whole words' }));
      await events.click(find.getByRole('checkbox', { name: 'Whole words' }));
      await frames();
      await events.click(find.getByRole('checkbox', { name: 'Whole words' }));
      await waitFor(() => expect(find.getByRole('status')).toHaveTextContent(`of ${total} matches`));
    }
    await events.click(find.getByRole('button', { name: 'Replace with' }));
    await events.type(find.getByRole('textbox', { name: 'Replace with' }), 'b');
    const bookmark = TextSelection.create(beforeBulk, middle).getBookmark();
    pending = trackPosition(editor, middle);
    report(run, 'replace-all-start', { logicalMatches: total });
    const bulkPublication = run.published;
    const replaceButton = find.getByRole('button', { name: 'Replace all' });
    let replaceClickAt = 0;
    replaceButton.addEventListener(
      'click',
      () => {
        replaceClickAt = performance.now();
      },
      { capture: true, once: true },
    );
    started = performance.now();
    lastChanged = undefined;
    await events.click(replaceButton);
    const bulk = lastChanged as Transaction | undefined;
    expect(bulk).toBeDefined();
    const replaceDriverMs = round(performance.now() - started);
    expect(bulk!.steps.length).toBe(total);
    expect(compactTransactionMetrics(bulk!)!.fastSteps).toBe(total);
    expect(editor.state.doc.textContent === beforeBulk.textContent.replaceAll('a', 'b')).toBe(true);
    expect(shape(editor.state.doc) === originalShape).toBe(true);
    expect(identities(editor.state.doc)).toEqual(originalIds);
    let expectedBookmark = bookmark.map(bulk!.mapping);
    expect(pending.get()).toBe(expectedBookmark.resolve(editor.state.doc).from);
    await frames();
    const replaceTwoFramesMs = round(performance.now() - started);
    const bulkPublicationMs = await published(run, bulkPublication, editor);
    report(run, 'replace-all-complete', {
      driverCallMs: replaceDriverMs,
      clickToDocumentTransactionMs: round(transactionAt - replaceClickAt),
      driverStartToTwoFramesMs: replaceTwoFramesMs,
      deferredPublicationMs: bulkPublicationMs,
      nativeSteps: bulk!.steps.length,
      metrics: compactTransactionMetrics(bulk!),
      idsAndMarksPreserved: true,
      bookmarkPreserved: true,
    });
    await events.click(find.getByRole('button', { name: 'Close find and replace' }));

    const retainedId = 'perf-renamed-id';
    let firstBody = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.attrs.id === 'perf-body-0') firstBody = position;
    });
    const externalPosition = middle;
    const external = editor.state.tr;
    if (run.kind === 'dense') external.delete(externalPosition, externalPosition + 1);
    else external.insertText('!', externalPosition);
    external.setNodeMarkup(firstBody, undefined, { ...external.doc.nodeAt(firstBody)!.attrs, id: retainedId });
    external.setMeta('addToHistory', false).setMeta('performanceMetadata', true);
    editor.view.dispatch(external);
    expectedBookmark = expectedBookmark.map(external.mapping);
    expect(pending.get()).toBe(expectedBookmark.resolve(editor.state.doc).from);
    const expectedRedo = editor.state.doc;
    const model = EditorState.create({ doc: beforeBulk, schema: editor.schema }).tr;
    // Stock native history merges the adjacent dense replacements into a full-run ReplaceStep. Its Undo
    // restores that original matched run, including this foreign-deleted character; Redo reapplies the deletion.
    // The small stock/compact differential regression pins the complete delete + markup + metadata sequence.
    if (run.kind !== 'dense') model.insertText('!', externalPosition);
    model.setNodeMarkup(firstBody, undefined, { ...model.doc.nodeAt(firstBody)!.attrs, id: retainedId });
    const expectedUndo = model.doc;
    expect(undoDepth(editor.state)).toBeGreaterThan(0);
    report(run, 'history-start', {
      externalEdit:
        run.kind === 'dense' ? 'real nonhistory partial-member deletion' : 'real nonhistory positional insertion',
      idAttributeChanged: true,
    });
    editor.view.focus();
    const undoPublication = run.published;
    lastChanged = undefined;
    key = null;
    started = performance.now();
    await events.keyboard('{Control>}z{/Control}');
    const undoDriverMs = round(performance.now() - started);
    const undoKey = key as { at: number; trusted: boolean } | null;
    expect(undoKey?.trusted).toBe(true);
    const undoDispatchMs = round(transactionAt - undoKey!.at);
    const undoTransaction = lastChanged as Transaction | undefined;
    expect(undoTransaction).toBeDefined();
    expectedBookmark = expectedBookmark.map(undoTransaction!.mapping);
    expect(editor.state.doc.eq(expectedUndo)).toBe(true);
    expect(pending.get()).toBe(expectedBookmark.resolve(editor.state.doc).from);
    expect(redoDepth(editor.state)).toBeGreaterThan(0);
    await frames();
    const undoTwoFramesMs = round(performance.now() - started);
    await published(run, undoPublication, editor);
    const redoPublication = run.published;
    lastChanged = undefined;
    key = null;
    started = performance.now();
    await events.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
    const redoDriverMs = round(performance.now() - started);
    const redoKey = key as { at: number; trusted: boolean } | null;
    expect(redoKey?.trusted).toBe(true);
    const redoDispatchMs = round(transactionAt - redoKey!.at);
    const redoTransaction = lastChanged as Transaction | undefined;
    expect(redoTransaction).toBeDefined();
    expectedBookmark = expectedBookmark.map(redoTransaction!.mapping);
    expect(editor.state.doc.eq(expectedRedo)).toBe(true);
    expect(pending.get()).toBe(expectedBookmark.resolve(editor.state.doc).from);
    expect(identities(editor.state.doc)).toContain(retainedId);
    await frames();
    const redoTwoFramesMs = round(performance.now() - started);
    await published(run, redoPublication, editor);
    const finalSnapshot = editorSnapshot(editor.state.doc, 'blocks');
    expect(checkDocument(finalSnapshot)).toBe(true);
    expect(bytes(finalSnapshot)).toBeLessThanOrEqual(maxSnapshotBytes);
    report(run, 'complete', {
      undoDriverMs,
      undoKeyToDocumentTransactionMs: undoDispatchMs,
      undoDriverStartToTwoFramesMs: undoTwoFramesMs,
      redoDriverMs,
      redoKeyToDocumentTransactionMs: redoDispatchMs,
      redoDriverStartToTwoFramesMs: redoTwoFramesMs,
      nativeHistoryMatched: true,
      externalTextEditOutcome:
        run.kind === 'dense'
          ? 'Native merged Undo restores the deleted matched character; Redo reapplies the deletion'
          : 'Unmatched insertion remains through Undo and Redo',
      idsMarksAndOpaquePayloadPreserved: true,
      liveBookmarkPreserved: true,
      trustedKeyEventsObserved: inputSamples.filter((sample) => sample.trusted).length,
      measuredKeyEvents: inputSamples.length,
      longTasksMs: longTasks,
      snapshotBytes: bytes(finalSnapshot),
      memoryClaim: 'checkpoint JS heap only; receiving run owns process/memory bound and terminal status',
    });
  } finally {
    pending?.stop();
    observer?.disconnect();
    editor.off('transaction', onTransaction);
    document.removeEventListener('keydown', onKey, true);
  }
}

const meta = {
  title: 'Components/EditorPerformance',
  component: PerformanceHost,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PerformanceHost>;
export default meta;
type Story = StoryObj<typeof meta>;
export const StructuredChapter: Story = {
  args: { kind: 'chapter' },
  play: ({ canvasElement }) => journey(canvasElement),
};
export const DenseNearCeiling: Story = { args: { kind: 'dense' }, play: ({ canvasElement }) => journey(canvasElement) };
export const SpacedNearCeiling: Story = {
  args: { kind: 'spaced' },
  play: ({ canvasElement }) => journey(canvasElement),
};
