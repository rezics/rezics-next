import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { MAL_ROWS, MAL_UPLOAD_BYTES, MAL_UPLOADS } from './contract';
import { MalAction } from './controls';

export function MalUploadForm({
  busy,
  disabled,
  onUpload,
}: {
  busy: boolean;
  disabled?: boolean;
  onUpload: (xml: string) => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);
  async function submit() {
    const file = input.current?.files?.[0];
    if (!file) return;
    if (file.size > MAL_UPLOAD_BYTES) {
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
      <p>{m.library_mal_intro()}</p>
      <p id={helpId} className="text-sm text-muted-foreground">
        {m.library_mal_guidance({ size: MAL_UPLOAD_BYTES / (1024 * 1024), rows: MAL_ROWS, uploads: MAL_UPLOADS })}
      </p>
      <Field>
        <FieldLabel htmlFor={inputId} className="min-h-11 items-center">
          {m.library_mal_file_label()}
        </FieldLabel>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept=".xml,text/xml,application/xml"
          aria-describedby={helpId}
          disabled={busy || disabled}
          className="min-h-11 w-full max-w-full text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:px-3"
        />
      </Field>
      <MalAction type="submit" disabled={busy || disabled} aria-busy={busy}>
        {busy ? m.library_mal_uploading() : m.library_mal_upload()}
      </MalAction>
    </form>
  );
}

/** Reopen finite native evidence without another file or provider request. The handle stays private. */
export function MalRetainedUpload({ busy, onOpen }: { busy: boolean; onOpen: (id: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (input.current?.reportValidity()) onOpen(input.current.value);
      }}
    >
      <label className="block" htmlFor={id}>
        {m.library_mal_label_upload_id()}
      </label>
      <input
        ref={input}
        id={id}
        className="min-h-11 w-full min-w-0 border p-2"
        required
        pattern="[0-9a-fA-F-]{36}"
        autoComplete="off"
        disabled={busy}
      />
      <MalAction type="submit" disabled={busy}>
        {m.library_mal_label_reopen()}
      </MalAction>
    </form>
  );
}
