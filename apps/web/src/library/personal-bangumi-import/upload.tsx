import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useRef, useState } from 'react';
import { ImportDetails } from '../personal-list-import/presentation';
import { m } from '../../paraglide/messages.js';
import { BANGUMI_FORMAT, BANGUMI_ROWS, BANGUMI_UPLOAD_BYTES } from './contract';
import { BangumiAction } from './controls';

export function BangumiUploadForm({
  busy,
  disabled,
  onUpload,
  onReopen,
}: {
  busy: boolean;
  disabled?: boolean;
  onUpload: (upload: string) => void;
  onReopen?: (uploadId: string) => void;
}) {
  const retainedIdInput = useId();
  const [retainedId, setRetainedId] = useState('');
  const inputId = useId();
  const helpId = useId();
  const formatId = useId();
  const attestId = useId();
  const input = useRef<HTMLInputElement>(null);
  async function submit() {
    const file = input.current?.files?.[0];
    if (!file) return;
    if (file.size > BANGUMI_UPLOAD_BYTES) {
      onUpload('');
      return;
    }
    onUpload(await file.text());
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{m.library_bangumi_intro()}</p>
      <p id={attestId}>{m.library_bangumi_attestation()}</p>
      <ImportDetails>
        <p>{m.library_bangumi_not_official()}</p>
        <p>{m.library_bangumi_not_account()}</p>
        <p id={formatId} className="text-sm text-muted-foreground">
          {m.library_bangumi_format({ format: BANGUMI_FORMAT })}
        </p>
        <p id={helpId} className="text-sm text-muted-foreground">
          {m.library_bangumi_guidance({ size: Math.floor(BANGUMI_UPLOAD_BYTES / 1024), rows: BANGUMI_ROWS })}
        </p>
      </ImportDetails>
      <Field>
        <FieldLabel htmlFor={inputId} className="min-h-11 items-center">
          {m.library_bangumi_file_label()}
        </FieldLabel>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept="application/json,.json"
          aria-describedby={`${attestId} ${formatId} ${helpId}`}
          disabled={busy || disabled}
          className="min-h-11 w-full max-w-full text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:px-3"
        />
      </Field>
      <BangumiAction type="submit" disabled={busy || disabled} aria-busy={busy}>
        {busy ? m.library_bangumi_uploading() : m.library_bangumi_upload()}
      </BangumiAction>
      {onReopen ? (
        <ImportDetails title={m.library_import_retained()}>
          <p>{m.library_import_reopen_help()}</p>
          <Field>
            <FieldLabel htmlFor={retainedIdInput}>{m.library_anilist_retained_id()}</FieldLabel>
            <input
              id={retainedIdInput}
              className="min-h-11 w-full rounded-md border px-3"
              value={retainedId}
              disabled={busy || disabled}
              autoComplete="off"
              onChange={(event) => setRetainedId(event.target.value)}
            />
            <BangumiAction
              type="button"
              disabled={busy || disabled || !retainedId}
              onClick={() => onReopen(retainedId)}
            >
              {m.library_anilist_reopen()}
            </BangumiAction>
          </Field>
        </ImportDetails>
      ) : null}
    </form>
  );
}
