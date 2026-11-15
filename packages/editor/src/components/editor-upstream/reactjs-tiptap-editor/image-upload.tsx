'use client';

// Adapted from src/components/SlashDialogTrigger/RenderDialogUploadImage.tsx; see README.md and LICENSE.
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { ImageUp } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { RichTextEditorLabels } from '../../editor-labels.ts';
import { ResponsiveDialog } from '@rezics/ui/responsive-dialog';

/** The product's upload/alt dialog hands the chosen file to the existing authorized attachment port. */
export function ImageUploadDialog({
  labels,
  accept,
  isCurrent,
  onInsert,
  onCancel,
}: {
  labels: RichTextEditorLabels;
  accept: string;
  isCurrent: () => boolean;
  onInsert: (file: File, alt: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && isCurrent()) onCancel();
      }}
      title={labels.insertImage}
      description={labels.uploadFile}
      closeLabel={labels.cancel}
      finalFocus={() => false}
    >
      <form
        className="grid min-w-0 gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (isCurrent() && file && !composing.current) onInsert(file, alt);
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229 || composing.current) event.stopPropagation();
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-file`}>{labels.uploadFile}</FieldLabel>
          <Button
            id={`${id}-file-button`}
            type="button"
            variant="outline"
            className="h-auto min-h-7 w-full whitespace-normal"
            onClick={() => {
              if (isCurrent()) fileInput.current?.click();
            }}
          >
            <ImageUp aria-hidden="true" />
            {labels.uploadFile}
          </Button>
          <input
            id={`${id}-file`}
            ref={fileInput}
            hidden
            type="file"
            accept={accept}
            onChange={(event) => {
              if (isCurrent()) setFile(event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
          />
          <p role="status" className="min-w-0 break-words text-sm text-muted-foreground">
            {file?.name}
          </p>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-alt`}>{labels.imageAlt}</FieldLabel>
          <Input
            id={`${id}-alt`}
            value={alt}
            onChange={(event) => {
              if (isCurrent()) setAlt(event.target.value);
            }}
          />
        </Field>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-h-7 max-w-full whitespace-normal"
            onClick={() => {
              if (isCurrent()) onCancel();
            }}
          >
            {labels.cancel}
          </Button>
          <Button type="submit" className="h-auto min-h-7 max-w-full whitespace-normal" disabled={!file}>
            {labels.insertImage}
          </Button>
        </div>
      </form>
    </ResponsiveDialog>
  );
}
