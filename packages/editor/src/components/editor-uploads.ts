import type { Editor } from '@tiptap/core';
import type { DocumentProfile } from '@rezics/document';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';

/** src is an opaque media id; resolving it to a URL belongs to the document renderer. */
export type UploadedImage = { src: string; width?: number; height?: number };
/** Local occurrence identity is stable across retry and never identifies native media. */
export type UploadAttachment = Readonly<{
  id: string;
  file: File;
  alt: string;
  phase: 'pending' | 'stored' | 'failed';
}>;
export type UploadAttachmentActions = {
  retry: () => void;
  dismiss: () => void;
  replace: (file: File) => void;
};
export type ImageUploader = (file: File, signal: AbortSignal, occurrence?: UploadAttachment) => Promise<UploadedImage>;
export type UploadState = 'ready' | 'pending' | 'failed';
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

/** Follow the requested caret through edits without rescanning the document. */
export function trackPosition(editor: Editor, start: number) {
  let position = start;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    position = transaction.mapping.map(position);
  };
  editor.on('transaction', follow);
  return {
    get: () => position,
    stop: () => editor.off('transaction', follow),
  };
}

export interface UploadEntry {
  id: string;
  file: File;
  phase: 'pending' | 'stored' | 'failed';
  alt: string;
  tracked: ReturnType<typeof trackPosition>;
  controller: AbortController;
}

type UploadSource = () => ImageUploader | undefined;

/** A stored upload remains pending until its occurrence is published to the composer. */
export function editorUploads(
  editor: Editor,
  profile: DocumentProfile,
  upload: UploadSource,
  changed: (state: UploadState, count: number, entries: UploadEntry[]) => void,
  publish: () => void,
  rejected: (reason: 'unsupportedImage' | 'imageLimit') => void,
  canUpload: () => boolean = () => true,
) {
  const entries = new Map<string, UploadEntry>();
  const uploaders = new WeakMap<UploadEntry, ImageUploader>();
  const attempts = new WeakMap<UploadEntry, symbol>();
  let disposed = false;
  let lastReport = '';
  function active() {
    return !disposed && !editor.isDestroyed && canUpload();
  }
  function report() {
    if (!active()) return;
    const items = [...entries.values()];
    const count = items.filter((entry) => entry.phase !== 'failed').length;
    const state = count ? 'pending' : items.length ? 'failed' : 'ready';
    const signature = `${state}:${count}:${items.map((entry) => `${entry.id}:${entry.phase}`).join(',')}`;
    if (signature === lastReport) return;
    lastReport = signature;
    changed(state, count, items);
  }
  function remove(entry: UploadEntry) {
    entry.controller.abort();
    entry.tracked.stop();
    if (entries.get(entry.id) === entry) entries.delete(entry.id);
  }
  async function send(entry: UploadEntry) {
    const uploader = uploaders.get(entry);
    if (!uploader || !active() || !editor.isEditable) return;
    const controller = entry.controller;
    const attempt = Symbol();
    attempts.set(entry, attempt);
    const current = () =>
      active() &&
      editor.isEditable &&
      entries.get(entry.id) === entry &&
      attempts.get(entry) === attempt &&
      entry.controller === controller &&
      !controller.signal.aborted;
    entry.phase = 'pending';
    report();
    try {
      const image = await uploader(entry.file, controller.signal, entry);
      if (!current()) return;
      if (
        typeof image.src !== 'string' ||
        !image.src.trim() ||
        [image.width, image.height].some((size) => size !== undefined && (!Number.isSafeInteger(size) || size <= 0))
      )
        throw new Error('Invalid uploaded image');
      // A failed publication may already contain this accepted occurrence. Retry
      // publication rather than inserting a second image with the same identity.
      let existing = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'image' && node.attrs.id === entry.id && node.attrs.src === image.src) existing = true;
      });
      const inserted =
        existing ||
        editor
          .chain()
          .insertContentAt(
            Math.min(entry.tracked.get(), editor.state.doc.content.size),
            {
              type: 'image',
              attrs: {
                id: entry.id,
                src: image.src,
                alt: entry.alt,
                width: image.width ?? null,
                height: image.height ?? null,
              },
            },
            { updateSelection: false },
          )
          .command(({ tr }) => {
            editorSnapshot(tr.doc, profile);
            return true;
          })
          .run();
      if (!current()) return;
      let present = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'image' && node.attrs.id === entry.id) present = true;
      });
      if (!inserted || !present) throw new Error('Image insertion rejected');
      entry.phase = 'stored';
      if (!current()) return;
      publish();
    } catch {
      if (!current()) return;
      entry.phase = 'failed';
    }
    report();
  }
  const manager = {
    add(files: File[], position: number, alt = '') {
      if (!active() || !editor.isEditable || !editor.schema.nodes.image) return;
      const uploader = upload();
      if (!uploader) return;
      let media = 0;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'image' || node.type.name === 'media') media++;
      });
      for (const file of files) {
        if (!imageTypes.includes(file.type)) {
          rejected('unsupportedImage');
          continue;
        }
        if (media + entries.size >= 32) {
          rejected('imageLimit');
          continue;
        }
        const entry: UploadEntry = {
          id: crypto.randomUUID(),
          file,
          alt,
          phase: 'pending',
          tracked: trackPosition(editor, position),
          controller: new AbortController(),
        };
        entries.set(entry.id, entry);
        uploaders.set(entry, uploader);
        void send(entry);
      }
    },
    snapshot(document: ProseMirrorNode) {
      if (!active()) return;
      document.descendants((node) => {
        const entry = entries.get(node.attrs.id);
        if (node.type.name === 'image' && entry?.phase === 'stored') remove(entry);
      });
      report();
    },
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.phase === 'failed' && active() && editor.isEditable) {
        entry.controller = new AbortController();
        void send(entry);
      }
    },
    dismiss(id: string) {
      const entry = entries.get(id);
      if (entry && active() && editor.isEditable) {
        remove(entry);
        const positions: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, position) => {
          if (node.type.name === 'image' && node.attrs.id === entry.id)
            positions.push({ from: position, to: position + node.nodeSize });
        });
        if (positions.length) {
          const transaction = editor.state.tr;
          for (const position of positions.reverse()) transaction.delete(position.from, position.to);
          editor.view.dispatch(transaction);
          publish();
        }
      }
      report();
    },
    replace(id: string, file: File) {
      const entry = entries.get(id);
      if (!entry || !active() || !editor.isEditable) return;
      if (!imageTypes.includes(file.type)) {
        rejected('unsupportedImage');
        return;
      }
      const position = trackPosition(editor, entry.tracked.get());
      const alt = entry.alt;
      manager.dismiss(id);
      manager.add([file], position.get(), alt);
      position.stop();
      report();
    },
    destroy() {
      disposed = true;
      for (const entry of entries.values()) remove(entry);
      entries.clear();
    },
  };
  return manager;
}
