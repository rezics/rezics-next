/// <reference types="bun" />
import { expect, test } from 'bun:test';
import { getSchema } from '@tiptap/core';
import { parseDocument, serializeDocument, type DocumentNode } from '@rezics/document';
import { documentExtensions } from './document-extensions.tsx';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';
import { editorUploads } from './rich-text-editor-uploads.ts';

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
