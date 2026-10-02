'use client';

import type { Editor as TiptapEditor } from '@tiptap/core';
import { UploadIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from './button.tsx';
import { safeDocumentUrl } from './document-url.tsx';
import type { RichTextEditorLabels } from './editor-labels.tsx';
import { Field, FieldLabel } from './field.tsx';
import { Input } from './input.tsx';
import { Spinner } from './spinner.tsx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.tsx';

/** Stores an image the writer chose and returns the address the document will reference. */
export type UploadedImage = { src: string; representationId?: string; mediaUseId?: string; conceal?: boolean };
export type ImageUploader = (file: File, occurrenceId: string) => Promise<UploadedImage>;

export function imageFiles(list: FileList | null | undefined): File[] {
  return Array.from(list ?? []).filter(file => file.type.startsWith('image/'));
}

/** Follows a document position through later edits, so an image that finishes uploading lands where it was asked for. */
function trackPosition(editor: TiptapEditor, start: number) {
  let position = start;
  const follow = ({ transaction }: { transaction: { mapping: { map: (pos: number) => number } } }) => { position = transaction.mapping.map(position); };
  editor.on('transaction', follow);
  return { get: () => position, stop: () => { editor.off('transaction', follow); } };
}

function insertImage(editor: TiptapEditor, position: number, image: UploadedImage, alt: string, id = crypto.randomUUID()) {
  editor.chain().focus().insertContentAt(Math.min(position, editor.state.doc.content.size), { type: 'image', attrs: { ...image, id, alt: alt || null } }).run();
}

/**
 * Uploads images one after another into the position they were dropped or pasted at; each lands
 * after the one before. Resolves false if any could not be stored.
 */
export async function uploadImagesAt(editor: TiptapEditor, files: File[], position: number, upload: ImageUploader): Promise<boolean> {
  const tracked = trackPosition(editor, position);
  let ok = true;
  try {
    for (const file of files) {
      try {
        const occurrenceId = crypto.randomUUID();
        const image = await upload(file, occurrenceId);
        const safe = safeDocumentUrl(image.src, true);
        if (safe && !editor.isDestroyed) insertImage(editor, tracked.get(), { ...image, src: safe }, '', occurrenceId);
        else ok = false;
      } catch {
        ok = false;
      }
    }
  } finally {
    tracked.stop();
  }
  return ok;
}

export interface ImageRequest { position: number; caret: DOMRect }

/**
 * Inserting an image opens beside the caret rather than in a dialog: upload a file when the
 * surface can store one, or embed an address from the web. A description is optional.
 */
export function ImageInsert({ editor, labels, request, upload, onClose }: {
  editor: TiptapEditor; labels: RichTextEditorLabels; request: ImageRequest; upload?: ImageUploader; onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const tracked = useRef<ReturnType<typeof trackPosition> | null>(null);

  useEffect(() => {
    tracked.current = trackPosition(editor, request.position);
    return () => tracked.current?.stop();
  }, [editor, request.position]);

  // Below the caret when there is room, above it otherwise; the visual viewport excludes an on-screen keyboard.
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop ?? 0, height = viewport?.height ?? window.innerHeight, width = viewport?.width ?? window.innerWidth;
    const size = panel.current?.getBoundingClientRect();
    const left = Math.max(8, Math.min(request.caret.left, width - (size?.width ?? 320) - 8));
    const below = top + height - request.caret.bottom;
    setPlace(below >= (size?.height ?? 200) + 12 || below >= request.caret.top - top
      ? { left, top: request.caret.bottom + 6 }
      : { left, bottom: window.innerHeight - request.caret.top + 6 });
  }, [request]);

  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onClose]);

  function embed() {
    const safe = safeDocumentUrl(url.trim(), true);
    if (!safe) { setInvalid(true); return; }
    insertImage(editor, tracked.current?.get() ?? request.position, { src: safe }, alt.trim());
    onClose();
  }
  async function send(files: File[]) {
    if (!upload || !files.length) return;
    setBusy(true); setFailed(false);
    const ok = await uploadImagesAt(editor, files, tracked.current?.get() ?? request.position, upload);
    setBusy(false);
    if (ok) onClose(); else setFailed(true);
  }

  const link = <form className="grid gap-2" onSubmit={event => { event.preventDefault(); embed(); }}>
    <Field invalid={invalid}>
      <Input autoFocus={!upload} size="sm" dir="ltr" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        aria-label={labels.url} placeholder={labels.imageLinkPlaceholder} aria-invalid={invalid} value={url}
        onChange={event => { setUrl(event.target.value); setInvalid(false); }} />
    </Field>
    {invalid ? <p role="alert" className="text-xs text-destructive">{labels.invalidUrl}</p> : null}
    <Field>
      <FieldLabel className="text-xs text-muted-foreground">{labels.imageAlt}</FieldLabel>
      <Input size="sm" value={alt} onChange={event => setAlt(event.target.value)} />
    </Field>
    <Button type="submit" size="sm" disabled={!url.trim()}>{labels.embedImage}</Button>
  </form>;

  return <div ref={panel} role="dialog" aria-label={labels.image} data-slot="editor-image-insert"
    style={place ? { position: 'fixed', ...place } : { position: 'fixed', left: request.caret.left, top: request.caret.bottom + 6 }}
    className="z-50 w-80 max-w-[calc(100vw-1rem)] rounded-xl border border-border/60 bg-popover p-2 text-popover-foreground shadow-(--aura-shadow-float)"
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
    onDragOver={event => { if (upload && event.dataTransfer.types.includes('Files')) event.preventDefault(); }}
    onDrop={event => { const files = imageFiles(event.dataTransfer.files); if (upload && files.length) { event.preventDefault(); void send(files); } }}>
    {upload ? <Tabs defaultValue="upload">
      <TabsList variant="underline" aria-label={labels.image}>
        <TabsTrigger value="upload">{labels.upload}</TabsTrigger>
        <TabsTrigger value="link">{labels.link}</TabsTrigger>
      </TabsList>
      <TabsContent value="upload" className="grid gap-2 pt-2">
        <input ref={picker} type="file" accept="image/*" multiple hidden aria-label={labels.uploadFile}
          onChange={event => { const files = imageFiles(event.currentTarget.files); event.currentTarget.value = ''; void send(files); }} />
        <Button autoFocus type="button" variant="outline" size="sm" disabled={busy} onClick={() => picker.current?.click()}>
          {busy ? <Spinner aria-hidden="true" /> : <UploadIcon aria-hidden="true" />}{busy ? labels.uploading : labels.uploadFile}
        </Button>
        {failed ? <p role="alert" className="text-xs text-destructive">{labels.uploadFailed}</p> : null}
      </TabsContent>
      <TabsContent value="link" className="pt-2">{link}</TabsContent>
    </Tabs> : link}
  </div>;
}
