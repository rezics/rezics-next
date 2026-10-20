'use client';

import {
  documentText,
  fromMarkdown,
  fromPlainText,
  parseDocument,
  parseStoredDocument,
} from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { RichTextEditor, type RichTextEditorProps, type RichTextEditorRecovery } from '@rezics/ui/rich-text-editor';
import { readEditorRecovery } from '@rezics/ui/rich-text-editor-recovery';
import { DownloadIcon, UploadIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { storedImageLabelEditor, storedImageUpload } from './local-image.ts';
import { messages } from './messages.ts';
import { imageUseReconciler } from './image-uses.ts';
import { resolveMediaMetadata } from '../api/media-metadata.ts';
import type { ImageMetadataResolver } from '@rezics/ui/media-image';
import { documentPublication, type DocumentSaveState } from './publication.ts';
import type { ImageUploader } from '@rezics/ui/editor-image';
import type { ImageUseTarget } from './image-target.ts';

export interface BodyEditorProps extends Omit<
  RichTextEditorProps,
  'value' | 'onChange' | 'labels' | 'recoveryRef' | 'recoveryDocument'
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
  mediaTarget?: ImageUseTarget;
  onSaveStateChange?: (state: DocumentSaveState) => void;
  /** A complete edit retained separately from the last successfully bound snapshot. */
  recoveryValue?: string;
  onRecoveryChange?: (value: string) => void;
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
  onSaveStateChange,
  recoveryValue,
  onRecoveryChange,
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
  const recoveryDocument = useMemo(() => readEditorRecovery(recoveryValue), [recoveryValue]);
  const upload = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(false);
  const [imageError, setImageError] = useState(false);
  const recovery = useRef<RichTextEditorRecovery>(null);
  const snapshotFailed = useRef(false);
  const uploadState = useRef<DocumentSaveState>('ready');
  const saveState = useRef<DocumentSaveState>('ready');
  const [failedUpload, setFailedUpload] = useState(false);
  const callbacks = useRef({ onChange, onSaveStateChange, onRecoveryChange, onSnapshotError: props.onSnapshotError });
  callbacks.current = { onChange, onSaveStateChange, onRecoveryChange, onSnapshotError: props.onSnapshotError };
  const initialDocument = useRef(parseStoredDocument(value) ?? document);
  const currentDocumentRef = useRef(document);
  currentDocumentRef.current = document;
  const reconcile = useMemo(() => actingSubject && mediaTarget
    ? imageUseReconciler(typeof mediaTarget === 'string' ? initialDocument.current : currentDocumentRef.current,
      actingSubject, mediaTarget) : undefined, [actingSubject, mediaTarget]);
  function reportState() {
    const state = saveState.current === 'failed' || uploadState.current === 'failed' ? 'failed'
      : uploadState.current === 'pending' ? 'pending' : saveState.current;
    callbacks.current.onSaveStateChange?.(state);
  }
  const publication = useMemo(() => documentPublication(
    reconcile ?? (async next => next),
    next => callbacks.current.onChange(next),
    (state, cause, retained) => {
      saveState.current = state;
      setImageError(state === 'failed');
      if (state === 'ready') { setError(false); snapshotFailed.current = false; }
      reportState();
      if (retained) callbacks.current.onRecoveryChange?.(JSON.stringify(retained));
      if (state === 'failed') callbacks.current.onSnapshotError?.(cause);
    },
  ), [reconcile]);
  useEffect(() => () => publication.cancel(), [publication]);
  useEffect(() => {
    if (!recoveryValue || publication.current()) return;
    const retained = parseStoredDocument(recoveryValue);
    if (retained) void publication.publish(retained);
    else {
      snapshotFailed.current = true; saveState.current = 'failed'; setError(true); reportState();
    }
  }, [recoveryValue, publication]);
  const uploadImageWithReceipt = useMemo<ImageUploader | undefined>(() => {
    const upload = props.onUploadImage ?? uploadImage;
    if (!upload) return undefined;
    return async (file, occurrence) => {
      const image = await upload(file, occurrence);
      reconcile?.rememberUpload(occurrence, image);
      return image;
    };
  }, [props.onUploadImage, uploadImage, reconcile]);
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
  function currentDocument() {
    return snapshotFailed.current
      ? { ...document, doc: recovery.current?.document() ?? recoveryDocument ?? document.doc }
      : publication.current() ?? document;
  }
  function exportDocument() {
    // Raw recovery is deliberately not portable yet; export must not try to normalize it.
    download(snapshotFailed.current && recoveryValue ? recoveryValue : JSON.stringify(currentDocument()), 'rezics.json', 'application/json');
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
      await publication.publish(next, true);
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
        recoveryDocument={recoveryDocument}
        onChange={(next) => { snapshotFailed.current = false; void publication.publish(next); }}
        labels={t}
        compact={compact}
        readOnly={readOnly}
        disabled={disabled}
        toolbarMode={advanced ? 'full' : 'contextual'}
        onUploadImage={uploadImageWithReceipt}
        onEditImageLabels={props.onEditImageLabels ?? editImageLabels}
        resolveImageMetadata={props.resolveImageMetadata ?? resolveImages}
        imageMetadataScope={props.imageMetadataScope ?? actingSubject}
        recoveryRef={recovery}
        onSnapshotPending={() => { publication.invalidate(); props.onSnapshotPending?.(); }}
        onUploadStateChange={(state) => {
          uploadState.current = state; setFailedUpload(state === 'failed'); reportState();
          props.onUploadStateChange?.(state);
        }}
        onSnapshotError={(cause) => {
          snapshotFailed.current = true; setError(true); saveState.current = 'failed';
          publication.cancel(); reportState(); callbacks.current.onSnapshotError?.(cause);
          callbacks.current.onRecoveryChange?.(JSON.stringify({ ...document, doc: recovery.current?.document() ?? document.doc }));
        }}
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
            onClick={exportDocument}
          >
            <DownloadIcon aria-hidden="true" />
            {t.exportDocument}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => download(snapshotFailed.current ? recovery.current?.text() ?? '' : documentText(currentDocument()), 'txt', 'text/plain;charset=utf-8')}
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
      {snapshotFailed.current || imageError || failedUpload ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={readOnly || disabled}
            onClick={() => {
              recovery.current?.focus();
              if (failedUpload) recovery.current?.retryUploads();
              else if (snapshotFailed.current) recovery.current?.retrySnapshot();
              else void publication.retry();
            }}>{t.retrySave}</Button>
          <Button type="button" variant="ghost" size="sm" disabled={readOnly || disabled}
            onClick={() => {
              recovery.current?.focus();
              if (failedUpload) recovery.current?.cancelUploads();
              else recovery.current?.removeImages(snapshotFailed.current);
            }}>{failedUpload ? t.cancel : t.removeImages}</Button>
          <Button type="button" variant="ghost" size="sm" onClick={exportDocument}>{t.exportDocument}</Button>
        </div>
      ) : null}
    </div>
  );
}
