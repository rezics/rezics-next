'use client';

import {
  documentText,
  fromMarkdown,
  fromPlainText,
  parseDocument,
  parseStoredDocument,
  serializeDocument,
  type DocumentSnapshot,
} from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { RichTextEditor, type RichTextEditorProps } from '@rezics/ui/rich-text-editor';
import { DownloadIcon, UploadIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { storedImageLabelEditor, storedImageUpload } from './local-image.ts';
import { messages } from './messages.ts';
import { imageUseReconciler } from './image-uses.ts';
import { resolveMediaMetadata } from '../api/media-metadata.ts';
import type { ImageMetadataResolver } from '@rezics/ui/media-image';

export interface BodyEditorProps extends Omit<
  RichTextEditorProps,
  'value' | 'onChange' | 'labels'
> {
  value: string;
  onChange: (value: string) => void;
  locale: UiLocale;
  /** Only old post/reply drafts use Markdown; manuscript strings are literal text. */
  legacyMarkdown?: boolean;
  /** Interface placeholder direction is independent from the manuscript's direction. */
  placeholderDirection?: 'ltr' | 'rtl';
  /** Studio opens with the complete toolbar and can return to contextual controls; discussion writing uses contextual controls only. */
  allowAdvanced?: boolean;
  actingSubject?: string;
  mediaTarget?: string;
}

/** UI-owned drafts serialize the portable snapshot; API adapters send it as an explicit document. */
export function BodyEditor({
  value,
  onChange,
  locale,
  legacyMarkdown = false,
  compact,
  readOnly,
  disabled,
  placeholderDirection = 'ltr',
  allowAdvanced = false,
  actingSubject,
  mediaTarget,
  ...props
}: BodyEditorProps) {
  const t = messages[locale];
  const uploadImage = useMemo(() => actingSubject && mediaTarget ? storedImageUpload(actingSubject, mediaTarget) : undefined, [actingSubject, mediaTarget]);
  const editImageLabels = useMemo(() => actingSubject ? storedImageLabelEditor(actingSubject) : undefined, [actingSubject]);
  const resolveImages = useMemo<ImageMetadataResolver | undefined>(() => actingSubject
    ? references => resolveMediaMetadata(references, actingSubject) : undefined, [actingSubject]);
  const document = useMemo(() => {
    const source =
      parseStoredDocument(value) ??
      (legacyMarkdown ? fromMarkdown(value, 'blocks') : fromPlainText(value, 'blocks'));
    // The application editor can add blocks to Text imports. Opening or switching modes
    // never writes; an explicit edit saves the same nodes under the Blocks profile.
    return source.profile === 'text' ? { ...source, profile: 'blocks' as const } : source;
  }, [value, legacyMarkdown]);
  const upload = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const sequence = useRef(0);
  const initialDocument = useRef(document);
  const reconcile = useMemo(() => actingSubject && mediaTarget
    ? imageUseReconciler(initialDocument.current, actingSubject, mediaTarget) : undefined, [actingSubject, mediaTarget]);
  useEffect(() => { sequence.current++; }, [value, actingSubject, mediaTarget]);
  async function publish(next: DocumentSnapshot, imported = false) {
    const current = ++sequence.current;
    try {
      const bound = reconcile ? await reconcile(next, imported) : next;
      if (sequence.current !== current) return;
      onChange(serializeDocument(bound));
      setError(false); setImageError(false);
    } catch {
      if (sequence.current === current) setImageError(true);
    }
  }
  // Long-form writing starts with the complete toolbar; discussion composers never show it.
  const [advanced, setAdvanced] = useState(allowAdvanced);

  function download(text: string, extension: string, mediaType: string) {
    const url = URL.createObjectURL(new Blob([text], { type: mediaType }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = `manuscript.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  }
  async function importFile(file: File) {
    try {
      if (file.size > 1_048_576) throw new Error('Document too large');
      const text = await file.text();
      const next = /\.json$/i.test(file.name)
        ? parseDocument(JSON.parse(text))
        : /\.(md|markdown)$/i.test(file.name)
          ? fromMarkdown(text, 'blocks')
          : fromPlainText(text, 'blocks');
      if (props.maxLength && documentText(next).length > props.maxLength)
        throw new Error('Text too long');
      await publish(next, true);
      setError(false);
    } catch {
      setError(true);
    }
  }
  return (
    <div className="grid min-w-0 gap-2" data-placeholder-dir={placeholderDirection}>
      {allowAdvanced && !readOnly ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-expanded={advanced}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setAdvanced((current) => !current)}
          >
            {advanced ? t.basicMode : t.advancedMode}
          </Button>
        </div>
      ) : null}
      <RichTextEditor
        {...props}
        value={document}
        onChange={(next) => { void publish(next); }}
        labels={t}
        compact={compact}
        readOnly={readOnly}
        disabled={disabled}
        toolbarMode={advanced ? 'full' : 'contextual'}
        onUploadImage={props.onUploadImage ?? uploadImage}
        onEditImageLabels={props.onEditImageLabels ?? editImageLabels}
        resolveImageMetadata={props.resolveImageMetadata ?? resolveImages}
        imageMetadataScope={props.imageMetadataScope ?? actingSubject}
        onSnapshotError={() => setError(true)}
      />
      {allowAdvanced && advanced ? (
        <div className="flex flex-wrap gap-1">
          <input
            ref={upload}
            type="file"
            accept=".json,.txt,.md,.markdown"
            className="hidden"
            aria-label={t.importFile}
            disabled={readOnly || disabled}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) void importFile(file);
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={readOnly || disabled}
            onClick={() => upload.current?.click()}
          >
            <UploadIcon aria-hidden="true" />
            {t.importFile}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => download(serializeDocument(document), 'rezics.json', 'application/json')}
          >
            <DownloadIcon aria-hidden="true" />
            {t.exportDocument}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => download(documentText(document), 'txt', 'text/plain;charset=utf-8')}
          >
            <DownloadIcon aria-hidden="true" />
            {t.exportText}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground text-sm">
          {t.invalidDocument}
        </p>
      ) : null}
      {imageError ? <p role="alert" className="text-destructive-foreground text-sm">{t.documentError}</p> : null}
    </div>
  );
}
