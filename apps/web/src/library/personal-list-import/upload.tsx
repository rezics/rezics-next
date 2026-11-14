import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { useEffect, useId, useRef } from 'react';
import { m } from '../../paraglide/messages.js';
import { VndbAction } from './controls';

export function VndbUploadForm({
  busy,
  disabled,
  onUpload,
  onEdit,
  onReadFailure,
}: {
  busy: boolean;
  disabled?: boolean;
  onEdit?: () => void;
  onUpload: (xml: string) => void;
  onReadFailure: () => void;
}) {
  const inputId = useId();
  const helpId = useId();
  const input = useRef<HTMLInputElement>(null);
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  function edit() {
    revision.current += 1;
    onEdit?.();
  }

  async function submit() {
    const token = ++revision.current;
    onEdit?.();
    const file = input.current?.files?.[0];
    if (!file) return;
    try {
      const xml = await file.text();
      if (token === revision.current) onUpload(xml);
    } catch {
      if (token === revision.current) onReadFailure();
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
      <p id={helpId} className="text-sm text-muted-foreground">
        {m.library_vndb_bounds()}
      </p>
      <Field>
        <FieldLabel htmlFor={inputId} className="min-h-11 items-center">
          {m.library_vndb_file_label()}
        </FieldLabel>
        <input
          ref={input}
          id={inputId}
          type="file"
          onChange={edit}
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
