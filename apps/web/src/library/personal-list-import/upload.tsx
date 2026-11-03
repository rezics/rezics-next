import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { VndbAction } from './controls';

export function VndbUploadForm({
  busy,
  disabled,
  onUpload,
  onReadFailure,
}: {
  busy: boolean;
  disabled?: boolean;
  onUpload: (xml: string) => void;
  onReadFailure: () => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);

  async function submit() {
    const file = input.current?.files?.[0];
    if (!file) return;
    try {
      onUpload(await file.text());
    } catch {
      onReadFailure();
    }
  }

  return (
    <form
      className="space-y-4"
      data-vndb-stage="upload"
      tabIndex={-1}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p>{m.library_vndb_intro()}</p>
      <p>{m.library_vndb_own_export()}</p>
      <p id={helpId} className="text-sm text-muted-foreground">{m.library_vndb_bounds()}</p>
      <Field>
        <FieldLabel htmlFor={inputId} className="min-h-11 items-center">{m.library_vndb_file_label()}</FieldLabel>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept="application/xml,text/xml,.xml"
          aria-describedby={helpId}
          disabled={busy || disabled}
          className="min-h-11 w-full max-w-full text-sm file:me-3 file:min-h-11 file:rounded-md file:border file:px-3"
        />
      </Field>
      <VndbAction type="submit" disabled={busy || disabled} aria-busy={busy}>
        {busy ? m.library_vndb_uploading() : m.library_vndb_upload()}
      </VndbAction>
    </form>
  );
}
