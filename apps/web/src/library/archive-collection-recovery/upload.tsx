import { useRef, useState, type FormEvent } from 'react';
import { RECOVERY_UPLOAD_BYTES } from './contract';
import { m } from '../../paraglide/messages.js';
import { actionClass } from '../private-export/controls';

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 16 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))));
  }
  return btoa(parts.join(''));
}

export async function encodeArchiveFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return base64(bytes);
  } finally {
    bytes.fill(0);
  }
}

export function ArchiveCollectionRecoveryUpload({
  busy,
  locked,
  onUpload,
}: {
  busy: boolean;
  locked: boolean;
  onUpload: (archiveBase64: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<'size' | 'empty' | 'read' | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked || busy || !file) return;
    if (!file.size) {
      setError('empty');
      return;
    }
    if (file.size > RECOVERY_UPLOAD_BYTES) {
      setError('size');
      return;
    }
    setError(null);
    let encoded: string;
    try {
      encoded = await encodeArchiveFile(file);
    } catch {
      setError('read');
      return;
    }
    setFile(null);
    if (input.current) input.current.value = '';
    await onUpload(encoded);
    encoded = '';
  }

  return (
    <section className="grid gap-4 rounded-xl border p-4 sm:p-6" aria-labelledby="recovery-upload-title">
      <h2 id="recovery-upload-title" className="text-lg font-semibold">
        {m.library_archive_recovery_upload_title()}
      </h2>
      <p>{m.library_archive_recovery_upload_help({ megabytes: 34 })}</p>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <label className="grid gap-2">
          <span className="font-medium">{m.library_archive_recovery_file()}</span>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="min-h-11 max-w-full rounded-md border p-2"
            disabled={busy || locked}
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setError(null);
            }}
          />
        </label>
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error === 'size'
              ? m.library_archive_recovery_upload_too_large()
              : error === 'empty'
                ? m.library_archive_recovery_upload_empty()
                : m.library_archive_recovery_upload_read_failed()}
          </p>
        ) : null}
        <button className={actionClass} type="submit" disabled={!file || busy || locked}>
          {busy ? m.library_archive_recovery_uploading() : m.library_archive_recovery_upload_action()}
        </button>
      </form>
      <p className="text-sm text-muted-foreground">{m.library_archive_recovery_private_evidence({ hours: 24 })}</p>
    </section>
  );
}
