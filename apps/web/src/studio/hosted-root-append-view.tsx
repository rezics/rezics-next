import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import { HostedDraftPickerView } from './hosted-draft-picker-view';
import type { HostedOutlineWindow } from './hosted-outline-window';
import type { HostedRootAppendVisit } from './hosted-root-append';
import './studio.css';

function RootAppendOutline({ window, locale }: { window: HostedOutlineWindow; locale: Locale }) {
  const state = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const options = { locale };
  return (
    <section
      className="studio-stack"
      aria-label={m.studio_root_append_outline({}, options)}
      aria-busy={state.kind === 'loading'}
    >
      <h2>{m.studio_root_append_outline({}, options)}</h2>
      <p className="studio-help">{m.studio_root_append_outline_help({}, options)}</p>
      {state.kind === 'loading' ? <p role="status">{m.studio_root_append_loading({}, options)}</p> : null}
      {state.kind === 'failed' ? (
        <div className="studio-stack" role="alert">
          <p>{m.studio_root_append_readback_failed({}, options)}</p>
          <div className="studio-action-row">
            <Button type="button" variant="outline" onClick={() => void window.load()}>
              {m.studio_root_append_retry_page({}, options)}
            </Button>
          </div>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {!state.page.items.length ? <p>{m.studio_root_append_empty_page({}, options)}</p> : null}
          <ol className="studio-draft-list">
            {state.page.items.map((item) => (
              <li key={item.occurrenceId}>
                <span>
                  {item.availability === 'available' ? item.title : m.studio_root_append_withheld({}, options)}
                </span>
                <span className="studio-help">
                  {m.studio_root_append_position({ position: String(item.position) }, options)}
                </span>
              </li>
            ))}
          </ol>
          {state.page.nextCursor !== null ? (
            <div className="studio-action-row">
              <Button type="button" variant="outline" onClick={() => void window.next()}>
                {m.studio_root_append_next({}, options)}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function HostedRootAppendView({ visit, locale }: { visit: HostedRootAppendVisit; locale: Locale }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const titleId = useId();
  const feedback = useRef<HTMLHeadingElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const options = { locale };
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (!visit.isCurrent()) return;
    if (['review', 'acknowledged', 'uncertain', 'stale', 'rejected'].includes(phase)) feedback.current?.focus();
    else if (phase === 'idle') title.current?.focus();
  }, [visit, phase]);
  if (state.kind === 'ended') return <p role="alert">{m.studio_root_append_ended({}, options)}</p>;
  const selection = state.selection;
  const editable = visit.canEdit();
  const locked = !editable || state.phase === 'review';
  const intent = state.intent;
  const feedbackTitle =
    state.phase === 'acknowledged'
      ? m.studio_root_append_acknowledged({}, options)
      : state.phase === 'uncertain'
        ? m.studio_root_append_uncertain({}, options)
        : state.phase === 'stale'
          ? m.studio_root_append_stale({}, options)
          : state.phase === 'rejected'
            ? m.studio_root_append_rejected({}, options)
            : m.studio_root_append_review({}, options);
  const reviewing = ['review', 'submitting', 'uncertain', 'stale', 'acknowledged', 'rejected'].includes(state.phase);
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl px-4 py-8">
      <header className="studio-header">
        <h1>{m.studio_root_append_heading({}, options)}</h1>
        <a className="studio-skip" href={localizeHref('/studio?books=1', options)}>
          {m.studio_root_append_return({}, options)}
        </a>
        <p className="studio-help max-w-prose">{m.studio_root_append_help({}, options)}</p>
      </header>
      <div className="studio-stack gap-8">
        <p className="studio-help break-all">{m.studio_root_append_head({ revisionId: state.head }, options)}</p>
        <section
          className="studio-stack"
          aria-label={m.studio_root_append_saved({}, options)}
          aria-busy={state.phase === 'selecting'}
        >
          <HostedDraftPickerView
            picker={visit.picker}
            disabled={locked}
            onSelect={(postId) => void visit.select(postId)}
          />
          {selection ? (
            <>
              <h2>{m.studio_root_append_saved({}, options)}</h2>
              <h3>{selection.revision.title}</h3>
              <time dateTime={selection.revision.savedAt}>{selection.revision.savedAt}</time>
              <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
                <dt>{m.studio_root_append_post({}, options)}</dt>
                <dd>{selection.revision.exact.postId}</dd>
                <dt>{m.studio_root_append_revision({}, options)}</dt>
                <dd>{selection.revision.exact.revisionId}</dd>
                <dt>{m.studio_root_append_digest({}, options)}</dt>
                <dd>{selection.revision.exact.sha256}</dd>
              </dl>
              <DocumentBody
                document={selection.revision.body}
                visitKey={JSON.stringify([selection.revision.exact, locale])}
              />
              <Label htmlFor={titleId}>{m.studio_root_append_title({}, options)}</Label>
              <Input
                ref={title}
                id={titleId}
                value={state.title}
                disabled={locked}
                onChange={(event) => visit.setTitle(event.target.value)}
              />
              <p className="studio-help">{m.studio_root_append_title_help({}, options)}</p>
              {editable && state.phase !== 'review' ? (
                <div className="studio-action-row">
                  <Button
                    type="button"
                    disabled={!state.title.trim() || [...state.title.trim()].length > 256}
                    onClick={() => void visit.review()}
                  >
                    {m.studio_root_append_review({}, options)}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}
          {state.phase === 'selecting' || state.phase === 'preparing' ? (
            <p role="status">{m.studio_root_append_loading({}, options)}</p>
          ) : null}
        </section>
        {reviewing ? (
          <section className="studio-stack" aria-busy={state.phase === 'submitting' || state.refreshing}>
            <h2 ref={feedback} tabIndex={-1}>
              {feedbackTitle}
            </h2>
            {intent ? (
              <p>
                {m.studio_root_append_intent(
                  { title: intent.request.body.title, revisionId: intent.request.body.expectedRevisionId },
                  options,
                )}
              </p>
            ) : null}
            {state.phase === 'uncertain' ? <p role="alert">{m.studio_root_append_replay_help({}, options)}</p> : null}
            {state.phase === 'stale' ? <p role="alert">{m.studio_root_append_stale_help({}, options)}</p> : null}
            {state.phase === 'acknowledged' ? (
              <p role="status">{m.studio_root_append_receipt({ revisionId: state.receipt!.revisionId }, options)}</p>
            ) : null}
            {state.phase === 'rejected' ? <p role="alert">{m.studio_root_append_rejected_help({}, options)}</p> : null}
            <div className="studio-action-row">
              {state.phase === 'review' || state.phase === 'uncertain' ? (
                <Button type="button" onClick={() => void visit.submit()}>
                  {state.phase === 'uncertain'
                    ? m.studio_root_append_replay({}, options)
                    : m.studio_root_append_submit({}, options)}
                </Button>
              ) : null}
              {state.phase === 'review' ? (
                <Button type="button" variant="outline" onClick={visit.cancelReview}>
                  {m.studio_root_append_edit({}, options)}
                </Button>
              ) : null}
              {state.phase === 'stale' ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={state.refreshing}
                  onClick={() => void visit.refreshHead()}
                >
                  {m.studio_root_append_refresh({}, options)}
                </Button>
              ) : null}
            </div>
            {state.refreshing || state.phase === 'submitting' ? (
              <p role="status">{m.studio_root_append_loading({}, options)}</p>
            ) : null}
            {state.phase === 'stale' && state.error && !state.refreshing && state.error.kind !== 'stale' ? (
              <p role="alert">{m.studio_root_append_refresh_failed({}, options)}</p>
            ) : null}
          </section>
        ) : null}
        <RootAppendOutline key={state.head} window={state.outline} locale={locale} />
      </div>
    </main>
  );
}
