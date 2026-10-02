'use client';

import {
  documentText,
  fromMarkdown,
  fromPlainText,
  parseDocument,
  parseStoredDocument,
  serializeDocument,
} from '@rezics/document';
import { Button } from '@rezics/ui/button';
import { RichTextEditor, type RichTextEditorProps } from '@rezics/ui/rich-text-editor';
import { DownloadIcon, UploadIcon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localImageUpload } from './local-image.ts';
import { messages } from './messages.ts';

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
  /** Studio offers the complete toolbar; discussion writing uses contextual controls. */
  allowAdvanced?: boolean;
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
  ...props
}: BodyEditorProps) {
  const t = messages[locale];
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
  const [advanced, setAdvanced] = useState(false);

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
      onChange(serializeDocument(next));
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
        onChange={(next) => {
          onChange(serializeDocument(next));
          setError(false);
        }}
        labels={t}
        compact={compact}
        readOnly={readOnly}
        disabled={disabled}
        toolbarMode={advanced ? 'full' : 'contextual'}
        onUploadImage={localImageUpload}
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
    </div>
  );
}
