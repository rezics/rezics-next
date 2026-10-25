import type { Editor } from '@tiptap/core';
import type { DocumentProfile } from '@rezics/document';
import type { Transaction } from '@tiptap/pm/state';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { editorSnapshot } from './rich-text-editor-snapshot.ts';

/** src is an opaque media id; resolving it to a URL belongs to the document renderer. */
export type UploadedImage = { src: string; width?: number; height?: number };
export type ImageUploader = (file: File, signal: AbortSignal) => Promise<UploadedImage>;
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

/** A stored upload remains pending until its occurrence is published to the composer. */
export function editorUploads(
  editor: Editor,
  profile: DocumentProfile,
  upload: ImageUploader,
  changed: (state: UploadState, count: number, entries: UploadEntry[]) => void,
  publish: () => void,
  rejected: (reason: 'unsupportedImage' | 'imageLimit') => void,
) {
  const entries = new Map<string, UploadEntry>();
  let disposed = false;
  function report() {
    if (disposed) return;
    const items = [...entries.values()];
    const count = items.filter((entry) => entry.phase !== 'failed').length;
    changed(count ? 'pending' : items.length ? 'failed' : 'ready', count, items);
  }
  function remove(entry: UploadEntry) {
    entry.controller.abort();
    entry.tracked.stop();
    entries.delete(entry.id);
  }
  async function send(entry: UploadEntry) {
    entry.phase = 'pending';
    report();
    try {
      const image = await upload(entry.file, entry.controller.signal);
      if (disposed || entry.controller.signal.aborted || editor.isDestroyed) return;
      if (
        typeof image.src !== 'string' ||
        !image.src.trim() ||
        [image.width, image.height].some((size) => size !== undefined && (!Number.isSafeInteger(size) || size <= 0))
      )
        throw new Error('Invalid uploaded image');
      const inserted = editor
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
      let present = false;
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'image' && node.attrs.id === entry.id) present = true;
      });
      if (!inserted || !present) throw new Error('Image insertion rejected');
      entry.phase = 'stored';
      publish();
    } catch {
      if (disposed || entry.controller.signal.aborted) return;
      entry.phase = 'failed';
    }
    report();
  }
  return {
    add(files: File[], position: number, alt = '') {
      if (disposed || !editor.isEditable || !editor.schema.nodes.image) return;
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
        void send(entry);
      }
    },
    snapshot(document: ProseMirrorNode) {
      document.descendants((node) => {
        const entry = entries.get(node.attrs.id);
        if (node.type.name === 'image' && entry?.phase === 'stored') remove(entry);
      });
      report();
    },
    retry(id: string) {
      const entry = entries.get(id);
      if (entry?.phase === 'failed' && editor.isEditable) {
        entry.controller = new AbortController();
        void send(entry);
      }
    },
    dismiss(id: string) {
      const entry = entries.get(id);
      if (entry) remove(entry);
      report();
    },
    destroy() {
      disposed = true;
      for (const entry of entries.values()) remove(entry);
      changed('ready', 0, []);
    },
  };
}
