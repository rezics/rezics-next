import { expect, test } from 'bun:test';
import { checkDocument } from '@rezics/document';
import { undo } from '@tiptap/pm/history';
import { NodeSelection, TextSelection } from '@tiptap/pm/state';
import {
  applyLanguage,
  applyRuby,
  canInsertFootnote,
  captureAnnotationTarget,
  insertFootnote,
  mapAnnotationTarget,
  removeFootnote,
  removeRuby,
  renameFootnote,
} from '../src/components/editor-domain-commands.ts';
import { editorInputSettings, setEditorInputSettings } from '../src/components/editor-surface.ts';
import { editorStateFixture, nodePositions } from './helpers/editor-state.ts';

test('ruby creation, editing and removal retain base marks, neighboring text and block identity', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'body' },
        content: [
          { type: 'text', text: '漢', marks: [{ type: 'bold' }] },
          { type: 'text', text: '字' },
          { type: 'text', text: ' outside' },
        ],
      },
    ],
  });
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 1, 3));
  const original = editor.state.doc.slice(1, 3).content;
  expect(
    applyRuby(
      editor,
      captureAnnotationTarget(editor)!,
      { base: '漢字', rt: 'かんじ', position: 'over', lang: 'ja' },
      () => true,
    ),
  ).toBe(true);
  let ruby = nodePositions(editor, 'ruby')[0]!;
  expect(ruby.node.content.eq(original)).toBe(true);
  fixture.select(NodeSelection.create(editor.state.doc, ruby.pos));
  expect(
    applyRuby(
      editor,
      captureAnnotationTarget(editor)!,
      { base: '漢字', rt: 'ㄏㄢˋ ㄗˋ', position: 'inter-character', lang: 'zh-Hant-TW' },
      () => true,
    ),
  ).toBe(true);
  ruby = nodePositions(editor, 'ruby')[0]!;
  expect(ruby.node.attrs).toMatchObject({ rt: 'ㄏㄢˋ ㄗˋ', position: 'inter-character', lang: 'zh-Hant-TW' });
  expect(ruby.node.content.eq(original)).toBe(true);
  fixture.select(NodeSelection.create(editor.state.doc, ruby.pos));
  expect(removeRuby(editor, captureAnnotationTarget(editor)!, () => true)).toBe(true);
  expect(editor.state.doc.firstChild!.attrs.id).toBe('body');
  expect(editor.state.doc.textContent).toBe('漢字 outside');
  expect(editor.state.doc.firstChild!.firstChild!.marks[0]!.type.name).toBe('bold');
  expect(checkDocument(fixture.snapshot())).toBe(true);
});

test('language applies a spelling-preserving span or block override and clearing leaves existing formatting', () => {
  const fixture = editorStateFixture(
    {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'body', lang: 'en' },
          content: [{ type: 'text', text: 'mixed text', marks: [{ type: 'italic' }] }],
        },
      ],
    },
    'text',
  );
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 1, 6));
  expect(
    applyLanguage(
      editor,
      captureAnnotationTarget(editor)!,
      { lang: 'zh-Hant-TW', dir: 'auto', scope: 'selection' },
      () => true,
    ),
  ).toBe(true);
  expect(editor.state.doc.firstChild!.firstChild!.marks.find((mark) => mark.type.name === 'language')!.attrs.lang).toBe(
    'zh-Hant-TW',
  );
  expect(
    applyLanguage(editor, captureAnnotationTarget(editor)!, { lang: '', dir: '', scope: 'selection' }, () => true),
  ).toBe(true);
  expect(editor.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(['italic']);
  expect(
    applyLanguage(editor, captureAnnotationTarget(editor)!, { lang: 'not a tag', dir: '', scope: 'block' }, () => true),
  ).toBe(false);
  expect(
    applyLanguage(editor, captureAnnotationTarget(editor)!, { lang: '', dir: 'rtl', scope: 'block' }, () => true),
  ).toBe(true);
  expect(editor.state.doc.firstChild!.attrs).toMatchObject({ id: 'body', lang: null, dir: 'rtl' });
});

test('annotation targets retire after selection/content replacement and respect read-only or retired visits', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first second' }] }],
  });
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 1, 6));
  const target = captureAnnotationTarget(editor)!;
  const transaction = editor.state.tr.insertText('changed', 1, 6);
  editor.view.dispatch(transaction);
  expect(mapAnnotationTarget(target, transaction, editor)).toBeNull();
  const before = editor.state.doc;
  expect(applyRuby(editor, target, { base: 'first', rt: 'x', position: 'over', lang: '' }, () => true)).toBe(false);
  const current = captureAnnotationTarget(editor)!;
  fixture.setEditable(false);
  expect(applyLanguage(editor, current, { lang: 'ja', dir: '', scope: 'block' }, () => true)).toBe(false);
  fixture.setEditable(true);
  expect(applyLanguage(editor, current, { lang: 'ja', dir: '', scope: 'block' }, () => false)).toBe(false);
  expect(editor.state.doc).toBe(before);
});

test('footnotes share one rich definition, rename atomically, preserve unreferenced notes and reject nesting', () => {
  const fixture = editorStateFixture(
    {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'body' }, content: [{ type: 'text', text: 'A finding' }] },
        {
          type: 'footnoteDefinition',
          attrs: { id: 'note', label: 'Source-1' },
          content: [
            {
              type: 'paragraph',
              attrs: { id: 'note-body' },
              content: [{ type: 'text', text: 'Rich source', marks: [{ type: 'bold' }] }],
            },
          ],
        },
      ],
    },
    'text',
  );
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 10));
  expect(
    insertFootnote(editor, captureAnnotationTarget(editor)!, 'Source-1', 'must not replace body', () => true),
  ).toBe(true);
  expect(insertFootnote(editor, captureAnnotationTarget(editor)!, 'Source-1', '', () => true)).toBe(true);
  expect(nodePositions(editor, 'footnoteReference')).toHaveLength(2);
  expect(nodePositions(editor, 'footnoteDefinition')).toHaveLength(1);
  const ref = nodePositions(editor, 'footnoteReference')[0]!;
  fixture.select(NodeSelection.create(editor.state.doc, ref.pos));
  expect(renameFootnote(editor, captureAnnotationTarget(editor)!, 'Source.Renamed', () => true)).toBe(true);
  expect(nodePositions(editor, 'footnoteReference').map(({ node }) => node.attrs.label)).toEqual([
    'Source.Renamed',
    'Source.Renamed',
  ]);
  const definition = nodePositions(editor, 'footnoteDefinition')[0]!;
  expect(definition.node.attrs.id).toBe('note');
  expect(definition.node.firstChild!.attrs.id).toBe('note-body');
  expect(definition.node.firstChild!.firstChild!.marks[0]!.type.name).toBe('bold');
  expect(definition.node.textContent).toBe('Rich source');
  fixture.select(TextSelection.create(editor.state.doc, definition.pos + 2));
  expect(canInsertFootnote(captureAnnotationTarget(editor)!)).toBe(false);
  for (const refNode of nodePositions(editor, 'footnoteReference').reverse()) {
    fixture.select(NodeSelection.create(editor.state.doc, refNode.pos));
    expect(removeFootnote(editor, captureAnnotationTarget(editor)!, false, () => true)).toBe(true);
  }
  expect(nodePositions(editor, 'footnoteReference')).toHaveLength(0);
  expect(nodePositions(editor, 'footnoteDefinition')).toHaveLength(1);
  expect(checkDocument(fixture.snapshot())).toBe(true);
  expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(nodePositions(editor, 'footnoteReference')).toHaveLength(1);
});

test('new footnote reference and multiline definition use one undo event; input preferences stay instance-local', () => {
  const fixture = editorStateFixture({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }],
  });
  const other = editorStateFixture({ type: 'doc', content: [{ type: 'paragraph' }] });
  const { editor } = fixture;
  fixture.select(TextSelection.create(editor.state.doc, 5));
  expect(
    insertFootnote(editor, captureAnnotationTarget(editor)!, 'new-note', 'First line\nSecond line', () => true),
  ).toBe(true);
  expect(nodePositions(editor, 'footnoteDefinition')[0]!.node.childCount).toBe(2);
  expect(checkDocument(fixture.snapshot())).toBe(true);
  expect(undo(editor.state, (transaction) => editor.view.dispatch(transaction))).toBe(true);
  expect(nodePositions(editor, 'footnoteReference')).toHaveLength(0);
  expect(nodePositions(editor, 'footnoteDefinition')).toHaveLength(0);
  const before = editor.state.doc;
  setEditorInputSettings(editor, { markdownShortcuts: false, autoLink: false, paste: 'plain' });
  expect(editorInputSettings(editor)).toEqual({ markdownShortcuts: false, autoLink: false, paste: 'plain' });
  expect(editorInputSettings(other.editor)).toEqual({ markdownShortcuts: true, autoLink: true, paste: 'rich' });
  expect(editor.state.doc).toBe(before);
});
