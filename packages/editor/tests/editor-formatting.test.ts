import { expect, test } from 'bun:test';
import { getSchema, Editor, Extension } from '@tiptap/core';
import { DOMParser as PMParser, DOMSerializer } from '@tiptap/pm/model';
import { TextSelection, EditorState } from '@tiptap/pm/state';
import { AddMarkStep, RemoveMarkStep, AttrStep, Transform } from '@tiptap/pm/transform';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { documentVersion, normalizeDocument, withDocumentIds, type DocumentNode } from '@rezics/document';
import { documentExtensionsForProfile } from '../src/components/document-extensions.ts';
import { DocumentBody } from '../src/components/document-body.tsx';
import { sanitizePastedHTML, editorExtensions } from '../src/components/editor-surface.ts';
import { safeColor, validFormattingMetadata } from '../src/components/document-style.ts';
import { buildFormattingDocument } from '../src/components/editor-formatting-document.ts';
import {
  captureFormattingTarget,
  applyAuthoredAlignment,
  applyAuthoredMark,
  applyCodeLanguage,
} from '../src/components/editor-formatting-commands.ts';
import { editorDOM } from './helpers/editor-dom.ts';
import { editorStateFixture } from './helpers/editor-state.ts';
import { undo, history, undoDepth } from '@tiptap/pm/history';
import { blockCommands, undoCommand, redoCommand } from '../src/components/editor-commands.ts';
import {
  compactTransactionMetrics,
  recordTextReplayBatch,
  skipProvenTextReplay,
} from '../src/components/editor-compact-transaction.ts';

test('supported authored colors, emphasis, alignment and code metadata survive clipboard and static reading', async () =>
  editorDOM(() => {
    const schema = getSchema(documentExtensionsForProfile('blocks'));
    let original = schema.nodeFromJSON(
      withDocumentIds({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 6, textAlign: 'left' },
            content: [
              {
                type: 'text',
                text: 'Heading',
                marks: [{ type: 'textStyle', attrs: { color: '#654321', backgroundColor: 'rgb(255, 255, 0)' } }],
              },
            ],
          },
          {
            type: 'paragraph',
            attrs: { textAlign: 'justify' },
            content: [
              {
                type: 'ruby',
                attrs: { rt: 'reading', position: 'under' },
                content: [
                  {
                    type: 'text',
                    text: 'base',
                    marks: [
                      {
                        type: 'textEmphasis',
                        attrs: { shape: 'sesame', fill: 'open', position: 'under', color: 'blue' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: 'codeBlock',
            attrs: { language: 'javascript', lang: 'en' },
            content: [{ type: 'text', text: 'int value;' }],
          },
          {
            type: 'table',
            content: [
              {
                type: 'tableRow',
                content: [
                  {
                    type: 'tableHeader',
                    attrs: { align: 'center' },
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const fixture = editorStateFixture(original.toJSON() as DocumentNode),
      editor = fixture.editor;
    fixture.select(TextSelection.create(editor.state.doc, 1, 8));
    expect(
      applyAuthoredMark(editor, captureFormattingTarget(editor)!, 'textStyle', { color: '#123456' }, () => true),
    ).toBe(true);
    expect(applyAuthoredAlignment(editor, captureFormattingTarget(editor)!, 'right', () => true)).toBe(true);
    let code = 0;
    editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'codeBlock') code = position;
    });
    fixture.select(TextSelection.create(editor.state.doc, code + 1));
    expect(applyCodeLanguage(editor, captureFormattingTarget(editor)!, 'c++', () => true)).toBe(true);
    original = editor.state.doc;
    const container = document.createElement('div');
    container.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(original.content));
    const pasted = document.createElement('div');
    pasted.innerHTML = sanitizePastedHTML(container.innerHTML);
    expect(validFormattingMetadata(pasted)).toBe(true);
    const readback = PMParser.fromSchema(editor.schema).parse(pasted);
    expect(readback.eq(original)).toBe(true);
    const snapshot = normalizeDocument({
      version: documentVersion,
      profile: 'blocks',
      doc: readback.toJSON() as DocumentNode,
    });
    const html = renderToStaticMarkup(createElement(DocumentBody, { document: snapshot }));
    expect(html).toContain('text-align:right');
    expect(html).toContain('text-align:justify');
    expect(html).toContain('text-align:center');
    expect(html).toContain('text-emphasis-style:open sesame');
    expect(html).toContain('data-language="c++"');
  }));

test('all admitted heading levels use the real shared command vocabulary without losing authored attrs', async () =>
  editorDOM(() => {
    const editor = new Editor({
      extensions: documentExtensionsForProfile('text'),
      injectCSS: false,
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            attrs: { id: 'kept', textAlign: 'right', lang: 'ja' },
            content: [{ type: 'text', text: 'Heading' }],
          },
        ],
      },
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      editor.commands.setTextSelection(2);
      for (const level of [4, 5, 6]) {
        blockCommands.find((command) => command.id === `heading${level}`)!.run(editor, () => {});
        expect(editor.state.doc.firstChild!.attrs).toMatchObject({ level, id: 'kept', textAlign: 'right', lang: 'ja' });
      }
    } finally {
      editor.destroy();
    }
  }));

test('rich paste retains supported CSS on block elements while removing resource and executable properties', async () =>
  editorDOM(() => {
    const schema = getSchema(documentExtensionsForProfile('text'));
    const html = sanitizePastedHTML(
      '<p style="text-align:center;color:rgb(1, 2, 3);background-color:yellow;background-image:url(https://example.invalid/track);position:fixed" onclick="alert(1)">safe</p>',
    );
    const root = document.createElement('div');
    root.innerHTML = html;
    expect(root.querySelector('p')!.style.backgroundImage).toBe('');
    expect(root.querySelector('p')!.style.position).toBe('');
    expect(root.querySelector('p')!.hasAttribute('onclick')).toBe(false);
    const doc = PMParser.fromSchema(schema).parse(root);
    expect(doc.firstChild!.attrs.textAlign).toBe('center');
    expect(doc.firstChild!.firstChild!.marks.find((mark) => mark.type.name === 'textStyle')?.attrs).toMatchObject({
      color: 'rgb(1, 2, 3)',
      backgroundColor: 'yellow',
    });
  }));

test('raw non-displayable colors remain data and cannot create additional CSS declarations', async () =>
  editorDOM(() => {
    const schema = getSchema(documentExtensionsForProfile('text'));
    const raw = 'paint(unsupported)';
    const doc = schema.node(
      'doc',
      null,
      schema.node('paragraph', null, schema.text('kept', [schema.mark('textStyle', { color: raw })])),
    );
    const root = document.createElement('div');
    root.append(DOMSerializer.fromSchema(schema).serializeFragment(doc.content));
    expect(root.querySelector('span')!.style.color).toBe('');
    expect(PMParser.fromSchema(schema).parse(root).firstChild!.firstChild!.marks[0]!.attrs.color).toBe(raw);
    const nonDisplayable = schema.node(
      'doc',
      null,
      schema.node('paragraph', null, schema.text('raw', [schema.mark('textStyle', { color: '\u007f' })])),
    );
    root.replaceChildren(DOMSerializer.fromSchema(schema).serializeFragment(nonDisplayable.content));
    root.innerHTML = sanitizePastedHTML(root.innerHTML);
    expect(validFormattingMetadata(root)).toBe(true);
    expect(PMParser.fromSchema(schema).parse(root).firstChild!.firstChild!.marks[0]!.attrs.color).toBe('\u007f');
    expect(root.querySelector('span')!.style.color).toBe('');
    expect(safeColor('red;background-image:url(https://example.invalid)')).toBeUndefined();
    expect(safeColor('rgb(1,2,3')).toBeUndefined();
    expect(safeColor('red/*')).toBeUndefined();
    root.innerHTML = '<span data-document-text-style=\'{"color":"red;background:red"}\'>text</span>';
    expect(validFormattingMetadata(root)).toBe(false);
  }));

test('code language metadata preserves admitted whitespace through inert rich clipboard data', async () =>
  editorDOM(() => {
    const schema = getSchema(documentExtensionsForProfile('text'));
    const language = 'custom\r\nparser\tmetadata';
    const original = schema.node('doc', null, schema.node('codeBlock', { language, lang: 'ja' }, schema.text('code')));
    const root = document.createElement('div');
    root.append(DOMSerializer.fromSchema(schema).serializeFragment(original.content));
    root.innerHTML = sanitizePastedHTML(root.innerHTML);
    expect(validFormattingMetadata(root)).toBe(true);
    expect(PMParser.fromSchema(schema).parse(root).firstChild!.attrs).toMatchObject({ language, lang: 'ja' });
  }));

test('every one-pass mark/attribute prefix equals maintained native steps', () => {
  const schema = getSchema(documentExtensionsForProfile('text'));
  const before = schema.node('doc', null, [
    schema.node('paragraph', { id: 'one' }, schema.text('first', [schema.mark('bold')])),
    schema.node('paragraph', { id: 'two' }, schema.text('second')),
  ]);
  const color = schema.mark('textStyle', { color: 'red' });
  const steps = [new AddMarkStep(2, 5, color), new RemoveMarkStep(2, 5, color), new AttrStep(0, 'textAlign', 'right')];
  const transform = new Transform(before);
  expect(buildFormattingDocument(before, steps, 0).eq(before)).toBe(true);
  steps.forEach((step, index) => {
    transform.step(step);
    expect(buildFormattingDocument(before, steps, index + 1).eq(transform.doc)).toBe(true);
  });
});

test('formatting edits preserve marks, IDs, selection and one undo event, and stale targets cannot apply', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'paragraph' },
        content: [
          {
            type: 'text',
            text: 'selected',
            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://example.test' } }],
          },
        ],
      },
    ],
  });
  const editor = fixture.editor;
  fixture.select(TextSelection.create(editor.state.doc, 2, 6));
  const original = editor.state.doc;
  const target = captureFormattingTarget(editor)!;
  expect(applyAuthoredMark(editor, target, 'textStyle', { color: 'red' }, () => true)).toBe(true);
  expect(editor.state.selection.eq(target.selection)).toBe(true);
  expect(editor.state.doc.firstChild!.attrs.id).toBe('paragraph');
  expect(editor.state.doc.firstChild!.child(1).marks.map((mark) => mark.type.name)).toContain('link');
  expect(applyAuthoredAlignment(editor, target, 'center', () => true)).toBe(false);
  expect(undo(editor.state, editor.view.dispatch)).toBe(true);
  expect(editor.state.doc.eq(original)).toBe(true);
});

test('real multi-paragraph formatting dispatch, native undo and redo stay in the compact identity path', async () =>
  editorDOM(() => {
    const element = document.createElement('div');
    document.body.append(element);
    const content = withDocumentIds({
      type: 'doc',
      content: Array.from({ length: 1000 }, (_, index) => ({
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: `Paragraph ${index}`,
            marks: [
              {
                type: 'textStyle',
                attrs: {
                  color: `#${index.toString(16).padStart(6, '0')}`,
                  backgroundColor: index % 2 ? 'yellow' : 'white',
                },
              },
            ],
          },
        ],
      })),
    });
    const History = Extension.create({ name: 'formattingHistory', addProseMirrorPlugins: () => [history()] });
    const observations: NonNullable<ReturnType<typeof compactTransactionMetrics>>[] = [];
    const editor = new Editor({
      element,
      content,
      extensions: [History, ...editorExtensions('blocks')],
      injectCSS: false,
      coreExtensionOptions: { delete: { filterTransaction: skipProvenTextReplay } },
      onTransaction: ({ transaction, appendedTransactions }) => {
        recordTextReplayBatch(transaction, appendedTransactions);
        const metrics = compactTransactionMetrics(transaction);
        if (metrics) observations.push(metrics);
      },
      editorProps: { handleScrollToSelection: () => true },
    });
    try {
      editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });
      const original = editor.state.doc;
      const selection = editor.state.selection.getBookmark();
      expect(
        applyAuthoredMark(editor, captureFormattingTarget(editor)!, 'textStyle', { color: 'red' }, () => true),
      ).toBe(true);
      expect(editor.state.doc.childCount).toBe(1000);
      for (const paragraph of editor.state.doc.children)
        expect(paragraph.firstChild!.marks[0]!.attrs.color).toBe('red');
      expect(undoDepth(editor.state)).toBe(1);
      undoCommand.run(editor, () => {});
      expect(editor.state.doc.eq(original)).toBe(true);
      expect(editor.state.selection.eq(selection.resolve(editor.state.doc))).toBe(true);
      redoCommand.run(editor, () => {});
      expect(editor.state.doc.firstChild!.firstChild!.marks[0]!.attrs.color).toBe('red');
      expect(observations).toHaveLength(3);
      for (const metrics of observations) expect(metrics.ordinarySteps).toBe(0);
      expect(applyAuthoredAlignment(editor, captureFormattingTarget(editor)!, 'center', () => true)).toBe(true);
      expect(editor.state.doc.lastChild!.attrs.textAlign).toBe('center');
      undoCommand.run(editor, () => {});
      expect(editor.state.doc.lastChild!.attrs.textAlign).toBeNull();
      expect(editor.state.doc.children.map((node) => node.attrs.id)).toEqual(
        original.children.map((node) => node.attrs.id),
      );
      for (const metrics of observations) expect(metrics.ordinarySteps).toBe(0);
    } finally {
      editor.destroy();
      element.remove();
    }
  }));
