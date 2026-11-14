import { useEffect, useMemo, useRef, useState } from 'react';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { hostedBookHref } from './address';
import { HostedBookCheckpointControls } from './checkpoint-controls';
import {
  readNativeHostedCheckpoint,
  writeNativeHostedCheckpoint,
  type CheckpointObservation,
} from './native-checkpoint';
import type { CheckpointCommand, CheckpointWrite } from './checkpoint-api';
import {
  captureCheckpointIntent,
  checkpointConfirmsIntent,
  type CheckpointIntent,
  type CheckpointIntentContext,
  type CheckpointLifetime,
  type CheckpointTransport,
} from './checkpoint-intent';
import type { BookPage } from './source';
import type { CheckpointPosition } from './checkpoint-position';

const nativeTransport: CheckpointTransport = {
  read: (request) => readNativeHostedCheckpoint(request),
  write: (request) => writeNativeHostedCheckpoint(request),
};
type Outcome = {
  intent: CheckpointIntent;
  state: 'sending' | 'saved' | 'cleared' | 'uncertain' | 'conflict' | 'changed';
};
type Reading = {
  owner: CheckpointLifetime;
  observation: CheckpointObservation | null;
  outcome: Outcome | null;
};
export type HostedBookCheckpointProps = {
  subjectId: string;
  viewer: string;
  page: BookPage;
  locale: Locale;
  isCurrent: () => boolean;
  reload: () => void;
  position: CheckpointPosition;
  /** Stories and acceptance use this component with installed native response shapes. */
  transport?: CheckpointTransport;
};

/** A private checkpoint belongs to one admitted reading, never to a replacement visit. */
export function HostedBookCheckpoint({
  subjectId,
  viewer,
  page,
  locale,
  isCurrent,
  reload,
  position,
  transport = nativeTransport,
}: HostedBookCheckpointProps) {
  const [reading, setReading] = useState<Reading | null>(null);
  const controls = useRef<HTMLElement>(null);
  const active = useRef<CheckpointLifetime | null>(null);
  const visit = useMemo(() => ({}), [subjectId, viewer, locale, page, isCurrent, position, transport]);
  const renderedVisit = useRef(visit);
  renderedVisit.current = visit;
  const options = { locale };

  const read = async (owner: CheckpointLifetime, restore: boolean) => {
    if (!owner.current() || owner.read || owner.intent) return;
    const request = {};
    owner.read = request;
    setReading((previous) => previous?.owner === owner ? { ...previous, observation: null } : previous);
    let observation: CheckpointObservation;
    try {
      observation = await transport.read({ data: { subjectId, viewer, locale }, signal: owner.controller.signal });
    } catch {
      observation = { state: 'unavailable' };
    }
    if (!owner.current() || owner.read !== request) return;
    owner.read = null;
    // Reading observes current state; it cannot confirm an earlier uncertain command.
    setReading((previous) => previous?.owner === owner ? { ...previous, observation } : previous);
    if (restore && observation.state === 'ready') position.restore(observation.value, controls.current);
  };

  useEffect(() => {
    const owner: CheckpointLifetime = {
      controller: new AbortController(),
      current: () => active.current === owner && renderedVisit.current === visit &&
        !owner.controller.signal.aborted && isCurrent(),
      read: null,
      write: null,
      intent: null,
    };
    active.current = owner;
    setReading({ owner, observation: null, outcome: null });
    void read(owner, true);
    return () => {
      owner.controller.abort();
      owner.intent = null;
      owner.read = null;
      owner.write = null;
      if (active.current === owner) active.current = null;
    };
  }, [visit]);

  const current = () => reading?.owner.current() === true;
  // Remove private controls before replacement setup, including equal-value A/B/A visits.
  // A public loading shell keeps the control inset available to the existing initial position restore.
  if (!reading || !current()) {
    if (!isCurrent()) return null;
    return <section ref={controls} aria-label={m.book_reader_checkpoint_title({}, options)}
      className={`${page.kind === 'chapter' ? 'sticky top-0 z-20' : ''} min-w-0 border-y bg-background/95 px-1 py-2`}>
      <p role="status" className="max-w-prose px-2 py-1 text-sm text-muted-foreground">
        {m.book_reader_loading({}, options)}
      </p>
    </section>;
  }
  const { owner, observation, outcome } = reading;
  const value = observation?.state === 'ready' ? observation.value : null;
  const busy = outcome?.state === 'sending' || observation === null;
  const needsRecovery = outcome?.state === 'conflict' || outcome?.state === 'changed';
  const blocked = busy || !observation?.csrfToken || owner.intent !== null || needsRecovery;

  const send = async (intent: CheckpointIntent) => {
    const owning = intent.owner;
    if (!owning.current() || owning.write || (owning.intent !== null && owning.intent !== intent)) return;
    const request = {};
    owning.write = request;
    owning.intent = intent;
    setReading((previous) => previous?.owner === owning ? { ...previous, outcome: { intent, state: 'sending' } } : previous);
    let result: CheckpointWrite;
    try {
      // The BFF still prepares and authorizes the current server session on every dispatch.
      result = await intent.sender(intent.request);
    } catch {
      result = { state: 'uncertain' };
    }
    if (!owning.current() || owning.write !== request) return;
    owning.write = null;
    if (result.state !== 'uncertain') owning.intent = null;
    setReading((previous) => {
      if (previous?.owner !== owning) return previous;
      if (result.state === 'denied') return { owner: owning, observation: result, outcome: null };
      if (result.state === 'ready') {
        return {
          owner: owning,
          observation: { ...result, csrfToken: intent.request.headers['X-CSRF-Token'] },
          outcome: {
            intent,
            state: checkpointConfirmsIntent(intent, result.value) ?
              (intent.request.data.command.kind === 'save' ? 'saved' : 'cleared') : 'changed',
          },
        };
      }
      return {
        ...previous,
        outcome: { intent, state: result.state === 'uncertain' ? 'uncertain' : result.state === 'conflict' ? 'conflict' : 'changed' },
      };
    });
  };
  const start = (command: CheckpointCommand, context: CheckpointIntentContext) => {
    if (!owner.current() || blocked || owner.write || owner.read || !observation?.csrfToken) return;
    void send(captureCheckpointIntent({
      owner, command, context, key: crypto.randomUUID(), viewer, locale,
      csrfToken: observation.csrfToken, sender: transport.write,
    }));
  };
  const save = () => {
    if (!owner.current() || blocked || !value || page.kind !== 'chapter') return;
    const { publication, selection } = page.address;
    start({
      kind: 'save', subjectId, expectedRevision: value.state === 'saved' ? value.revision : null,
      address: {
        catalogueId: publication.id,
        publicationRevisionId: publication.releaseRevisionId!,
        occurrenceId: selection.occurrenceId,
        targetRevisionId: selection.body.revisionId,
        targetSha256: selection.body.sha256,
        documentPosition: position.capture(controls.current),
      },
    }, { kind: 'save', title: page.title });
  };
  const clear = () => {
    if (value?.state !== 'saved') return;
    start({ kind: 'clear', subjectId, expectedRevision: value.revision }, {
      kind: 'clear', title: value.resume.availability === 'available' ? value.resume.title : null,
    });
  };
  const resume = value?.state === 'saved' && value.resume.availability === 'available'
    ? { href: hostedBookHref(value.address.catalogueId, locale, {
        subject: subjectId, release: value.address.publicationRevisionId,
        occurrence: value.address.occurrenceId, view: 'chapter',
      }), title: value.resume.title }
    : null;
  const message = outcome?.state === 'sending'
    ? outcome.intent.context.kind === 'save'
      ? m.book_reader_checkpoint_saving({}, options) : m.book_reader_checkpoint_clearing({}, options)
    : outcome?.state === 'saved' ? m.book_reader_checkpoint_saved({}, options)
    : outcome?.state === 'cleared' ? m.book_reader_checkpoint_cleared({}, options)
    : outcome?.state === 'uncertain' ? m.book_reader_checkpoint_uncertain({}, options)
    : needsRecovery ? m.book_reader_changed({}, options)
    : observation === null ? m.book_reader_loading({}, options)
    : observation.state !== 'ready' ? m.book_reader_progress_unavailable({}, options)
    : value?.state === 'none' ? m.book_reader_checkpoint_none({}, options) : null;
  const context = outcome && (outcome.state === 'sending' || outcome.state === 'uncertain' || needsRecovery)
    ? outcome.intent.context : null;
  const originalAction = context?.kind === 'save'
    ? m.book_reader_checkpoint_intent_save({ chapter: context.title }, options)
    : context?.kind === 'clear'
      ? context.title === null ? m.book_reader_checkpoint_intent_clear_withheld({}, options)
        : m.book_reader_checkpoint_intent_clear({ chapter: context.title }, options)
      : null;
  const observed = value?.state === 'saved' && value.resume.availability === 'available'
    ? m.book_reader_checkpoint_observed_saved({ chapter: value.resume.title }, options)
    : outcome && value?.state === 'none' ? m.book_reader_checkpoint_observed_none({}, options) : null;
  const replay = owner.intent ? {
    kind: owner.intent.request.data.command.kind,
    run: () => { if (owner.intent) void send(owner.intent); },
  } : undefined;
  const retry = observation && observation.state !== 'ready' && !owner.intent
    ? () => void read(owner, true) : undefined;
  const recoverCurrent = needsRecovery ? () => { if (owner.current()) reload(); } : undefined;

  return <HostedBookCheckpointControls
    controlsRef={controls} locale={locale} chapter={page.kind === 'chapter'} message={message}
    saved={value?.state === 'saved'} withheld={value?.state === 'saved' && value.resume.availability === 'unavailable'}
    resume={resume} busy={busy} blocked={blocked} isCurrent={current}
    originalAction={originalAction} observed={observed}
    {...(value && page.kind === 'chapter' ? { save } : {})}
    {...(value?.state === 'saved' ? { clear } : {})}
    {...(replay ? { replay } : {})}
    {...(retry ? { retry } : {})}
    {...(recoverCurrent ? { recoverCurrent } : {})}
  />;
}
