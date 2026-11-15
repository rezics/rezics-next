'use client';

import { Button } from '@rezics/ui/shadcn/button';
import { LocateFixed } from 'lucide-react';
import { useRef } from 'react';
import type { RichTextEditorLabels } from './editor-labels.ts';
import { imageTypes, type UploadAttachment, type UploadAttachmentActions } from './editor-uploads.ts';
import { productControlLabels } from './editor-upstream/reactjs-tiptap-editor/control-labels.ts';

export function EditorUploadControls({
  entry,
  labels,
  editable,
  actions,
  onLocate,
}: {
  entry: UploadAttachment;
  labels: RichTextEditorLabels;
  editable: boolean;
  actions: UploadAttachmentActions;
  onLocate: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const failed = entry.phase === 'failed';
  const status = failed
    ? labels.uploadFailed
    : entry.phase === 'stored'
      ? (labels.uploadInserting ?? productControlLabels.uploadInserting)
      : labels.uploading;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border p-2">
      <p role={failed ? 'alert' : 'status'} aria-label={status} className="min-w-0 flex-1 wrap-break-word text-sm">
        {status} <bdi>{entry.file.name}</bdi>
      </p>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={labels.uploadLocation ?? productControlLabels.uploadLocation}
        disabled={!editable}
        onClick={onLocate}
      >
        <LocateFixed aria-hidden="true" />
      </Button>
      {failed ? (
        <>
          <Button type="button" variant="secondary" disabled={!editable} onClick={actions.retry}>
            {labels.retryUpload}
          </Button>
          <Button type="button" variant="outline" disabled={!editable} onClick={() => input.current?.click()}>
            {labels.uploadFile}
          </Button>
          <input
            ref={input}
            type="file"
            hidden
            accept={imageTypes.join(',')}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (editable && file) actions.replace(file);
            }}
          />
          <Button type="button" variant="ghost" disabled={!editable} onClick={actions.dismiss}>
            {labels.dismissUpload}
          </Button>
        </>
      ) : null}
    </div>
  );
}
