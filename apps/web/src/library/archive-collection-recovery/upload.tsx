import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  isCurrent,
  onUpload,
}: {
  busy: boolean;
  locked: boolean;
  isCurrent: () => boolean;
  onUpload: (archiveBase64: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const file = useRef<File | null>(null);
  const ticket = useRef(0);
  const mounted = useRef(true);
  const preparingRef = useRef(false);
  const currentCheck = useRef(isCurrent);
  const availability = useRef({ busy, locked });
  currentCheck.current = isCurrent;
  availability.current = { busy, locked };
  const [hasFile, setHasFile] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<'size' | 'empty' | 'read' | null>(null);

  function active(id: number): boolean {
    return (
      mounted.current &&
      ticket.current === id &&
      currentCheck.current() &&
      !availability.current.busy &&
      !availability.current.locked
    );
  }

  function discard(id: number) {
    if (ticket.current !== id) return;
    ticket.current++;
    preparingRef.current = false;
    file.current = null;
    if (input.current) input.current.value = '';
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ticket.current++;
      preparingRef.current = false;
      file.current = null;
    };
  }, []);

  useEffect(() => {
    if ((!busy && !locked) || !preparingRef.current) return;
    const id = ticket.current;
    discard(id);
    if (currentCheck.current()) {
      setHasFile(false);
      setPreparing(false);
    }
  }, [busy, locked]);

  async function prepareSelectedFile(id: number): Promise<string | null> {
    const selected = file.current;
    if (!selected) return null;
    let encoded = '';
    try {
      encoded = await encodeArchiveFile(selected);
    } catch {
      if (active(id)) setError('read');
      return null;
    }
    if (!active(id)) {
      encoded = '';
      discard(id);
      return null;
    }
    return encoded;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked || preparingRef.current || !currentCheck.current()) return;
    const selectedSize = file.current?.size;
    if (selectedSize === undefined) return;
    if (!selectedSize) {
      setError('empty');
      return;
    }
    if (selectedSize > RECOVERY_UPLOAD_BYTES) {
      setError('size');
      return;
    }

    const id = ++ticket.current;
    preparingRef.current = true;
    setError(null);
    setPreparing(true);
    let encoded = '';
    try {
      let prepared = await prepareSelectedFile(id);
      if (prepared === null) return;
      encoded = prepared;
      prepared = '';
      if (!active(id)) {
        discard(id);
        return;
      }

      file.current = null;
      setHasFile(false);
      if (input.current) input.current.value = '';
      setError(null);
      preparingRef.current = false;
      setPreparing(false);

      let upload: Promise<void>;
      try {
        upload = onUpload(encoded);
      } finally {
        encoded = '';
      }
      await upload;
    } finally {
      encoded = '';
      if (ticket.current === id && preparingRef.current) {
        preparingRef.current = false;
        if (active(id)) setPreparing(false);
        else discard(id);
      }
    }
  }

  return (
    <section className="grid gap-4 rounded-xl border p-4 sm:p-6" aria-labelledby="recovery-upload-title">
      <h2 id="recovery-upload-title" className="text-lg font-semibold">
        {m.library_archive_recovery_upload_title()}
      </h2>
      <p>{m.library_archive_recovery_upload_help({ megabytes: 34 })}</p>
      <form className="grid gap-4" aria-busy={preparing || undefined} onSubmit={(event) => void submit(event)}>
        <label className="grid gap-2">
          <span className="font-medium">{m.library_archive_recovery_file()}</span>
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="min-h-11 max-w-full rounded-md border p-2"
            disabled={busy || locked || preparing}
            onChange={(event) => {
              if (!currentCheck.current()) return;
              if (preparingRef.current) {
                ticket.current++;
                preparingRef.current = false;
                setPreparing(false);
              }
              file.current = event.currentTarget.files?.[0] ?? null;
              setHasFile(file.current !== null);
              setError(null);
            }}
          />
        </label>
        {preparing ? (
          <p role="status" aria-live="polite" aria-atomic="true" className="text-sm">
            {m.library_archive_recovery_preparing()}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error === 'size'
              ? m.library_archive_recovery_upload_too_large()
              : error === 'empty'
                ? m.library_archive_recovery_upload_empty()
                : m.library_archive_recovery_upload_read_failed()}
          </p>
        ) : null}
        <button className={actionClass} type="submit" disabled={!hasFile || busy || locked || preparing}>
          {preparing
            ? m.library_archive_recovery_preparing()
            : busy
              ? m.library_archive_recovery_uploading()
              : m.library_archive_recovery_upload_action()}
        </button>
      </form>
      <p className="text-sm text-muted-foreground">{m.library_archive_recovery_private_evidence({ hours: 24 })}</p>
    </section>
  );
}
