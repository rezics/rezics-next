/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { fromPlainText, normalizeDocument, parseDocument, parseStoredDocument, serializeDocument, type DocumentNode } from '@rezics/document';
import { EditorState } from '@tiptap/pm/state';
import { documentExtensions } from './document-extensions.tsx';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';
import { editorUploads } from './rich-text-editor-uploads.ts';
import { controlledEditorContent, readEditorRecovery, removeEditorImages } from './rich-text-editor-recovery.tsx';

const schema = getSchema(documentExtensions({ blocks: true, unknownComponentLabel: 'Unsupported block' }));
const representation = '11111111-1111-4111-8111-111111111111';
const use = '33333333-3333-4333-8333-333333333333';
const stableImage = { type: 'image', attrs: { id: '22222222-2222-4222-8222-222222222222',
  src: `/api/main/v1/media/representations/${representation}/bytes?use=${use}`, representationId: representation, mediaUseId: use } };
const currentDoc = schema.nodeFromJSON({ type: 'doc', content: [
  { type: 'paragraph', content: [{ type: 'text', text: 'Retained current text.', marks: [{ type: 'bold' }] }] },
  stableImage,
  { type: 'image', attrs: { src: '/invalid-image.png', representationId: 'invalid' } },
  { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this quotation too.' }] }] },
] });
const saved = fromPlainText('The older saved body.', 'blocks');
const rawRecovery = JSON.stringify({ ...saved, doc: currentDoc.toJSON() });

test('retry and reopening an invalid snapshot retain the current raw document instead of the old saved body', () => {
  expect(() => editorSnapshot(currentDoc, 'blocks', new WeakMap())).toThrow();
  expect(parseStoredDocument(rawRecovery)).toBeNull();
  expect(rawRecovery).toContain('Retained current text.');
  const recovered = readEditorRecovery(rawRecovery);
  // Reopening must initialize from the same raw content that can still be exported.
  let live = schema.nodeFromJSON(recovered ?? saved.doc);
  // A legacy saved-body fallback creates new block IDs when recovery is fed back.
  const olderFallback = fromPlainText('The older saved body.', 'blocks');
  const replacement = controlledEditorContent(olderFallback, saved, live, recovered);
  expect(replacement).toBeUndefined();
  if (replacement) live = schema.nodeFromJSON(replacement);
  expect(live.textContent).toBe('Retained current text.Keep this quotation too.');
  expect(live.eq(currentDoc)).toBe(true);
  // Retrying an unresolved invalid image must fail again, leaving raw export intact.
  expect(() => editorSnapshot(live, 'blocks', new WeakMap())).toThrow();
  expect(JSON.stringify({ ...saved, doc: live.toJSON() })).toBe(rawRecovery);
  // Once the image is corrected, Retry saves and reopens the whole current edit.
  const state = EditorState.create({ doc: live });
  let position = 0;
  live.descendants((node, offset) => { if (node.attrs.representationId === 'invalid') position = offset; });
  const corrected = state.apply(state.tr.setNodeMarkup(position, undefined, { ...live.nodeAt(position)!.attrs, representationId: null }));
  const complete = editorSnapshot(corrected.doc, 'blocks', new WeakMap());
  const reopened = schema.nodeFromJSON(parseDocument(JSON.parse(serializeDocument(complete))).doc);
  expect(reopened.textContent).toBe(live.textContent);
  expect(reopened.toJSON().content[1].attrs).toMatchObject(stableImage.attrs);
  expect(reopened.toJSON().content[0].content[0].marks).toEqual([{ type: 'bold' }]);
  expect(normalizeDocument(complete)).toEqual(complete);
});

test('Remove repairs the recovered current document while preserving valid images, marks and other blocks through save/reopen', () => {
  const recovered = readEditorRecovery(rawRecovery);
  const state = EditorState.create({ doc: schema.nodeFromJSON(recovered ?? saved.doc) });
  const cleaned = state.apply(removeEditorImages(state, true));
  const complete = editorSnapshot(cleaned.doc, 'blocks', new WeakMap());
  const reopened = parseDocument(JSON.parse(serializeDocument(complete)));
  expect(schema.nodeFromJSON(reopened.doc).textContent).toBe('Retained current text.Keep this quotation too.');
  expect(reopened.doc.content).toHaveLength(3);
  expect(reopened.doc.content![0]!.content![0]).toMatchObject({ text: 'Retained current text.', marks: [{ type: 'bold' }] });
  expect(reopened.doc.content![1]!.attrs).toMatchObject(stableImage.attrs);
  expect(reopened.doc.content![2]!.type).toBe('blockquote');
  expect(serializeDocument(reopened)).not.toContain('/invalid-image.png');
});

test('Remove invalid images leaves stable images intact even before a recovery remount', () => {
  const state = EditorState.create({ doc: currentDoc });
  const cleaned = state.apply(removeEditorImages(state, true));
  expect(cleaned.doc.childCount).toBe(3);
  expect(cleaned.doc.child(1).attrs).toMatchObject(stableImage.attrs);
  expect(cleaned.doc.textContent).toBe(currentDoc.textContent);
});

test('live editor images and text serialize and reopen independently of preview reads', () => {
  const representationId = '11111111-1111-4111-8111-111111111111';
  const mediaUseId = '33333333-3333-4333-8333-333333333333';
  const schema = getSchema(documentExtensions({ blocks: true, unknownComponentLabel: 'Unsupported block' }));
  const live = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Current text' }] },
    { type: 'image', attrs: { id: '22222222-2222-4222-8222-222222222222',
      src: `/api/main/v1/media/representations/${representationId}/bytes?use=${mediaUseId}`, representationId, mediaUseId } },
  ] });
  const current = editorSnapshot(live, 'blocks', new WeakMap());
  const reopened = parseDocument(JSON.parse(serializeDocument(current)));
  expect(reopened.doc.content![1]!.attrs).toMatchObject({ representationId, mediaUseId });
  expect(reopened.doc.content![0]!.content![0]!.text).toBe('Current text');
});

test('snapshot conversion errors escape to the editor owner instead of emitting old text', () => {
  const schema = getSchema(documentExtensions({ blocks: true, unknownComponentLabel: 'Unsupported block' }));
  const invalid = schema.nodeFromJSON({ type: 'doc', content: [{ type: 'image', attrs: { src: 'bad', representationId: 'invalid' } }] });
  expect(() => editorSnapshot(invalid, 'blocks', new WeakMap<object, DocumentNode>())).toThrow();
});

test('an upload remains pending until its image occurrence reaches the live document', () => {
  const states: string[] = [];
  const uploads = editorUploads(state => { states.push(state); });
  const file = new File(['image'], 'draft.png', { type: 'image/png' });
  const schema = getSchema(documentExtensions({ blocks: true, unknownComponentLabel: 'Unsupported block' }));
  uploads.start('image-occurrence', file, 1);
  uploads.stored('image-occurrence');
  uploads.snapshot(schema.nodeFromJSON({ type: 'doc', content: [{ type: 'paragraph' }] }));
  expect(states.at(-1)).toBe('pending');
  uploads.snapshot(schema.nodeFromJSON({ type: 'doc', content: [{ type: 'image', attrs: { id: 'image-occurrence', src: '/image.png' } }] }));
  expect(states.at(-1)).toBe('ready');
});

test('failed uploads retain their files for retry or explicit cancellation', () => {
  const states: string[] = [];
  const uploads = editorUploads(state => { states.push(state); });
  const file = new File(['image'], 'draft.png', { type: 'image/png' });
  uploads.start('image-occurrence', file, 7);
  uploads.failed('image-occurrence');
  expect(states.at(-1)).toBe('failed');
  expect(uploads.takeFailures()).toEqual([{ file, position: 7 }]);
  uploads.start('retry-occurrence', file, 7);
  uploads.failed('retry-occurrence');
  uploads.takeFailures();
  expect(states.at(-1)).toBe('ready');
});
