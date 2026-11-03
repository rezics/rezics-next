import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { BANGUMI_FORMAT, BANGUMI_ROWS, BANGUMI_UPLOAD_BYTES } from './contract';
import { BangumiAction } from './controls';

export function BangumiUploadForm({
  busy,
  disabled,
  onUpload,
}: {
  busy: boolean;
  disabled?: boolean;
  onUpload: (upload: string) => void;
}) {
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
      <p>{m.library_bangumi_not_official()}</p>
      <p>{m.library_bangumi_not_account()}</p>
      <p id={formatId} className="text-sm text-muted-foreground">
        {m.library_bangumi_format({ format: BANGUMI_FORMAT })}
      </p>
      <p id={helpId} className="text-sm text-muted-foreground">
        {m.library_bangumi_guidance({ size: Math.floor(BANGUMI_UPLOAD_BYTES / 1024), rows: BANGUMI_ROWS })}
      </p>
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
    </form>
  );
}
