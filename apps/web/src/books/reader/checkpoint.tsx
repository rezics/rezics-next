import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { hostedBookHref } from './address';
import {
  readNativeHostedCheckpoint,
  writeNativeHostedCheckpoint,
  type CheckpointObservation,
} from './native-checkpoint';
import type { CheckpointCommand, CheckpointWrite } from './checkpoint-api';
import type { BookPage } from './source';

type Pending = { command: CheckpointCommand; key: string };
export type HostedBookCheckpointProps = {
  subjectId: string;
  viewer: string;
  page: BookPage;
  locale: Locale;
  isCurrent: () => boolean;
  reload: () => void;
};

/** A chapter checkpoint, with native availability and CAS. Retiring the reading also retires its private controls. */
export function HostedBookCheckpoint({
  subjectId,
  viewer,
  page,
  locale,
  isCurrent,
  reload,
}: HostedBookCheckpointProps) {
  const [observation, setObservation] = useState<CheckpointObservation | null>(null);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'cleared' | 'conflict' | 'uncertain' | 'changed' | null>(null);
  const pending = useRef<Pending | null>(null);
  const writing = useRef(false);
  const live = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const options = { locale };
  useEffect(() => {
    const controller = new AbortController();
    live.current = true;
    lifetime.current = controller;
    const current = () => !controller.signal.aborted && isCurrent();
    if (current()) {
      setObservation(null);
      void readNativeHostedCheckpoint({ data: { subjectId, viewer, locale }, signal: controller.signal }).then(
        (value) => {
          if (current()) setObservation(value);
        },
        () => {
          if (current()) setObservation({ state: 'unavailable' });
        },
      );
    }
    return () => {
      live.current = false;
      controller.abort();
    };
  }, [subjectId, viewer, locale, page, isCurrent, retry]);
  const current = () => live.current && isCurrent();
  const value = observation?.state === 'ready' ? observation.value : null;

  const send = async (captured: Pending) => {
    if (!current() || writing.current || !observation?.csrfToken) return;
    writing.current = true;
    pending.current = captured;
    setBusy(true);
    setNotice(null);
    let result: CheckpointWrite;
    try {
      result = await writeNativeHostedCheckpoint({
        data: { viewer, locale, ...captured },
        headers: { 'X-CSRF-Token': observation.csrfToken },
        ...(lifetime.current ? { signal: lifetime.current.signal } : {}),
      });
    } catch {
      result = { state: 'uncertain' };
    }
    writing.current = false;
    if (!current()) return;
    setBusy(false);
    if (result.state === 'ready') {
      pending.current = null;
      setObservation({ ...result, csrfToken: observation.csrfToken });
      const command = captured.command;
      const saved = result.value;
      const matches =
        command.kind === 'clear'
          ? saved.state === 'none'
          : saved.state === 'saved' &&
            saved.address.catalogueId === command.address.catalogueId &&
            saved.address.publicationRevisionId === command.address.publicationRevisionId &&
            saved.address.occurrenceId === command.address.occurrenceId &&
            saved.address.targetRevisionId === command.address.targetRevisionId &&
            saved.address.targetSha256 === command.address.targetSha256 &&
            saved.address.documentPosition === null;
      setNotice(matches ? (command.kind === 'save' ? 'saved' : 'cleared') : 'changed');
    } else {
      if (result.state !== 'uncertain') pending.current = null;
      setNotice(result.state === 'uncertain' ? 'uncertain' : result.state === 'conflict' ? 'conflict' : 'changed');
    }
  };
  const save = () => {
    if (!value || page.kind !== 'chapter') return;
    const { publication, selection } = page.address;
    // Native publications always carry a release ID; the optional consumer form also serves illustrative hosts.
    const publicationRevisionId = publication.releaseRevisionId!;
    void send({
      key: crypto.randomUUID(),
      command: {
        kind: 'save',
        subjectId,
        expectedRevision: value.state === 'saved' ? value.revision : null,
        address: {
          catalogueId: publication.id,
          publicationRevisionId,
          occurrenceId: selection.occurrenceId,
          targetRevisionId: selection.body.revisionId,
          targetSha256: selection.body.sha256,
          documentPosition: null,
        },
      },
    });
  };
  const clear = () => {
    if (value?.state !== 'saved') return;
    void send({ key: crypto.randomUUID(), command: { kind: 'clear', subjectId, expectedRevision: value.revision } });
  };
  const blocked =
    busy || !observation?.csrfToken || notice === 'uncertain' || notice === 'conflict' || notice === 'changed';
  const resume =
    value?.state === 'saved' && value.resume.availability === 'available'
      ? hostedBookHref(value.address.catalogueId, locale, {
          subject: subjectId,
          release: value.address.publicationRevisionId,
          occurrence: value.address.occurrenceId,
          view: 'chapter',
        })
      : null;
  const message =
    notice === 'saved'
      ? m.book_reader_checkpoint_saved({}, options)
      : notice === 'cleared'
        ? m.book_reader_checkpoint_cleared({}, options)
        : notice === 'uncertain'
          ? m.book_reader_checkpoint_uncertain({}, options)
          : notice === 'conflict' || notice === 'changed'
            ? m.book_reader_changed({}, options)
            : observation === null
              ? m.book_reader_loading({}, options)
              : observation.state !== 'ready'
                ? m.book_reader_progress_unavailable({}, options)
                : value?.state === 'saved' && value.resume.availability === 'unavailable'
                  ? m.book_reader_checkpoint_withheld({}, options)
                  : value?.state === 'none'
                    ? m.book_reader_checkpoint_none({}, options)
                    : null;
  return (
    <section className="grid gap-3 rounded-xl border p-4" aria-label={m.book_reader_checkpoint_title({}, options)}>
      <h2 className="font-semibold">{m.book_reader_checkpoint_title({}, options)}</h2>
      {message ? <p role="status">{message}</p> : null}
      {notice && value?.state === 'saved' && value.resume.availability === 'unavailable' ? (
        <p>{m.book_reader_checkpoint_withheld({}, options)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2" aria-busy={busy}>
        {resume ? (
          <a
            href={resume}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11 whitespace-normal' })}
            onClick={(event) => {
              if (!current()) event.preventDefault();
            }}
          >
            {m.book_reader_checkpoint_resume({}, options)}
          </a>
        ) : null}
        {value && page.kind === 'chapter' ? (
          <Button variant="outline" className="min-h-11 whitespace-normal" disabled={blocked} onClick={save}>
            {m.book_reader_checkpoint_save({}, options)}
          </Button>
        ) : null}
        {value?.state === 'saved' ? (
          <Button variant="outline" className="min-h-11 whitespace-normal" disabled={blocked} onClick={clear}>
            {m.book_reader_checkpoint_clear({}, options)}
          </Button>
        ) : null}
        {notice === 'uncertain' ? (
          <Button
            variant="outline"
            className="min-h-11"
            disabled={busy}
            onClick={() => {
              if (pending.current) void send(pending.current);
            }}
          >
            {m.book_reader_retry({}, options)}
          </Button>
        ) : null}
        {notice === 'conflict' || notice === 'changed' ? (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              if (current()) reload();
            }}
          >
            {m.book_reader_retry({}, options)}
          </Button>
        ) : null}
        {observation && observation.state !== 'ready' ? (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              if (current()) setRetry((value) => value + 1);
            }}
          >
            {m.book_reader_retry({}, options)}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
