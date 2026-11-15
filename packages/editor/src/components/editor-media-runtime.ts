import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { DocumentImageRenderer, DocumentMediaRenderer } from './document-media.tsx';
import type { RichTextEditorLabels } from './editor-labels.ts';

export interface EditorMediaPorts {
  renderImage?: DocumentImageRenderer;
  renderMedia?: DocumentMediaRenderer;
  labels: RichTextEditorLabels;
  isCurrent: () => boolean;
  /** Changes for a new document/account editing visit, including equal document bytes. */
  visit?: unknown;
}

type Preview = { src: string; url: string };
type Runtime = {
  ports: (() => EditorMediaPorts) | null;
  visit: unknown;
  revision: number;
  generation: number;
  listeners: Set<() => void>;
  previews: Map<string, Preview>;
  properties: Map<string, () => boolean>;
};
const runtimes = new WeakMap<Editor, Runtime>();
const imageIndex = new WeakMap<Node, readonly (readonly [string, string])[]>();
function images(node: Node): readonly (readonly [string, string])[] {
  const known = imageIndex.get(node);
  if (known) return known;
  const found: (readonly [string, string])[] = [];
  if (node.type.name === 'image') found.push([node.attrs.id, node.attrs.src]);
  else
    node.forEach((child) => {
      for (const entry of images(child)) found.push(entry);
    });
  imageIndex.set(node, found);
  return found;
}
export function editorMediaRuntime(editor: Editor): Runtime {
  let runtime = runtimes.get(editor);
  if (!runtime) {
    runtime = {
      ports: null,
      visit: undefined,
      revision: 0,
      generation: 0,
      listeners: new Set(),
      previews: new Map(),
      properties: new Map(),
    };
    runtimes.set(editor, runtime);
  }
  return runtime;
}

function notify(runtime: Runtime) {
  runtime.revision++;
  for (const listener of runtime.listeners) listener();
}

export function clearEditorImagePreviews(editor: Editor): void {
  const runtime = editorMediaRuntime(editor);
  for (const preview of runtime.previews.values()) URL.revokeObjectURL(preview.url);
  runtime.previews.clear();
  notify(runtime);
}

export function discardEditorImagePreview(editor: Editor, id: string): void {
  const runtime = editorMediaRuntime(editor);
  const preview = runtime.previews.get(id);
  if (!preview) return;
  URL.revokeObjectURL(preview.url);
  runtime.previews.delete(id);
  notify(runtime);
}

/** Root prop/locale changes publish a visual update without replacing the editor or its node views. */
export function refreshEditorMediaViews(editor: Editor): void {
  const runtime = editorMediaRuntime(editor);
  const visit = runtime.ports?.().visit;
  if (visit !== runtime.visit) {
    runtime.visit = visit;
    runtime.generation++;
    clearEditorImagePreviews(editor);
  } else notify(runtime);
}

/** Only an accepted local occurrence gets a temporary URL; it is never part of a snapshot. */
export function registerEditorImagePreview(editor: Editor, id: string, src: string, file: File): void {
  if (editor.isDestroyed || !editor.isEditable || !URL.createObjectURL) return;
  const runtime = editorMediaRuntime(editor);
  const previous = runtime.previews.get(id);
  if (previous) URL.revokeObjectURL(previous.url);
  runtime.previews.set(id, { src, url: URL.createObjectURL(file) });
  notify(runtime);
}

/** Reuses the upload owner's already collected occurrence IDs; no per-keystroke scan is added. */
export function pruneEditorImagePreviews(editor: Editor, present: ReadonlySet<string>): void {
  const runtime = editorMediaRuntime(editor);
  let changed = false;
  for (const [id, preview] of runtime.previews)
    if (!present.has(id)) {
      URL.revokeObjectURL(preview.url);
      runtime.previews.delete(id);
      changed = true;
    }
  if (changed) notify(runtime);
}

/** Immutable subtree caching avoids transaction-step replay and repeated scans of unchanged content. */
export function pruneEditorImagePreviewsFromDocument(editor: Editor, document: Node): void {
  const runtime = editorMediaRuntime(editor);
  if (!runtime.previews.size) return;
  const present = new Set<string>();
  for (const [id, src] of images(document)) if (runtime.previews.get(id)?.src === src) present.add(id);
  pruneEditorImagePreviews(editor, present);
}
