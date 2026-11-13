import { useEffect, useId, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Input } from '@rezics/ui/shadcn/input';
import { Label } from '@rezics/ui/shadcn/label';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import { HostedDraftPickerView } from './hosted-draft-picker-view';
import { draftPointReady, type DraftPointAnchor, type HostedDraftPointVisit } from './hosted-draft-points';
import type { HostedOutlineWindow } from './hosted-outline-window';
import './studio.css';

function Anchor({ anchor, fallback }: { anchor: DraftPointAnchor | null; fallback: string }) {
  return anchor ? (
    <span>
      {anchor.item.title}
      <br />
      <span className="studio-help break-all">{anchor.item.occurrenceId}</span>
    </span>
  ) : (
    <span>{fallback}</span>
  );
}

function Outline({
  visit,
  window,
  locale,
  locked,
}: {
  visit: HostedDraftPointVisit;
  window: HostedOutlineWindow;
  locale: Locale;
  locked: boolean;
}) {
  const state = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const command = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale };
  const parentId = command.kind === 'active' ? (command.choice.parent?.item.occurrenceId ?? null) : null;
  return (
    <section
      className="studio-stack"
      aria-label={m.studio_draft_point_outline({}, options)}
      aria-busy={state.kind === 'loading'}
    >
      <h2>{m.studio_draft_point_outline({}, options)}</h2>
      <p className="studio-help">{m.studio_draft_point_window_help({}, options)}</p>
      {state.kind === 'loading' ? <p role="status">{m.studio_draft_point_loading({}, options)}</p> : null}
      {state.kind === 'failed' ? (
        <div className="studio-stack" role="alert">
          <p>{m.studio_draft_point_read_failed({}, options)}</p>
          <div className="studio-action-row">
            <Button type="button" variant="outline" onClick={() => void window.load()}>
              {m.studio_draft_point_retry_read({}, options)}
            </Button>
          </div>
        </div>
      ) : null}
      {state.kind === 'ready' ? (
        <>
          {!state.page.items.length ? <p>{m.studio_draft_point_empty({}, options)}</p> : null}
          <ol className="studio-draft-list">
            {state.page.items.map((item) => (
              <li key={item.occurrenceId} className="studio-stack">
                <p>{item.availability === 'available' ? item.title : m.studio_draft_point_unavailable({}, options)}</p>
                <p className="studio-help break-all">{item.occurrenceId}</p>
                <p className="studio-help break-all">
                  {m.studio_draft_point_parent({}, options)}: {item.parentId ?? m.studio_draft_point_root({}, options)}
                </p>
                {item.availability === 'available' ? (
                  <div className="studio-action-row">
                    {item.kind === 'part' ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={() => visit.observe(item.occurrenceId, 'parent')}
                      >
                        {m.studio_draft_point_use_parent({ title: item.title }, options)}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked || item.parentId !== parentId}
                      onClick={() => visit.observe(item.occurrenceId, 'before')}
                    >
                      {m.studio_draft_point_use_before({ title: item.title }, options)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      onClick={() => visit.observe(item.occurrenceId, 'removal')}
                    >
                      {m.studio_draft_point_use_remove({ title: item.title }, options)}
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
          {state.page.nextCursor !== null ? (
            <div className="studio-action-row">
              <Button type="button" variant="outline" disabled={locked} onClick={() => void window.next()}>
                {m.studio_draft_point_next({}, options)}
              </Button>
            </div>
          ) : null}
          {state.cursor !== null ? (
            <div className="studio-action-row">
              <Button type="button" variant="outline" disabled={locked} onClick={() => void window.load(null)}>
                {m.studio_draft_point_restart({}, options)}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function HostedDraftPointView({ visit, locale }: { visit: HostedDraftPointVisit; locale: Locale }) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale };
  const titleId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLHeadingElement>(null);
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (!visit.isCurrent()) return;
    if (['review', 'acknowledged', 'uncertain', 'stale', 'rejected'].includes(phase)) feedback.current?.focus();
    else if (phase === 'idle') titleInput.current?.focus();
  }, [visit, phase]);
  if (state.kind === 'ended') return <p role="alert">{m.studio_draft_point_ended({}, options)}</p>;
  const editable = visit.canEdit();
  const locked = !editable || phase === 'review';
  const { choice, selection, intent } = state;
  const body = intent?.request.body;
  const catalogueId = state.outlineAddress.catalogueId;
  const existingEditor = `/studio?catalogueId=${catalogueId}`;
  const feedbackTitle =
    phase === 'acknowledged'
      ? m.studio_draft_point_acknowledged({}, options)
      : phase === 'uncertain'
        ? m.studio_draft_point_uncertain({}, options)
        : phase === 'stale'
          ? m.studio_draft_point_stale({}, options)
          : phase === 'rejected'
            ? m.studio_draft_point_rejected({}, options)
            : m.studio_draft_point_review({}, options);
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl px-4 py-8">
      <header className="studio-header">
        <h1>{m.studio_draft_point_heading({}, options)}</h1>
        <p className="studio-help max-w-prose">{m.studio_draft_point_help({}, options)}</p>
        <div className="studio-action-row">
          <a className="studio-toc-open" href={localizeHref('/studio?books=1', options)}>
            {m.studio_root_append_return({}, options)}
          </a>
          <a className="studio-toc-open" href={localizeHref(existingEditor, options)}>
            {m.studio_draft_point_editor({}, options)}
          </a>
        </div>
      </header>
      <div className="studio-stack gap-8">
        <p className="studio-help break-all">{m.studio_draft_point_head({ revisionId: state.head }, options)}</p>
        <section className="studio-stack" aria-label={m.studio_draft_point_operation({}, options)}>
          <h2>{m.studio_draft_point_operation({}, options)}</h2>
          <div className="studio-action-row">
            {(['part', 'chapter', 'remove'] as const).map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="outline"
                aria-pressed={choice.kind === kind}
                disabled={locked}
                onClick={() => visit.setKind(kind)}
              >
                {kind === 'part'
                  ? m.studio_draft_point_part({}, options)
                  : kind === 'chapter'
                    ? m.studio_draft_point_chapter({}, options)
                    : m.studio_draft_point_remove({}, options)}
              </Button>
            ))}
          </div>
          {choice.kind === 'remove' ? (
            <>
              <p>{m.studio_draft_point_subtree({}, options)}</p>
              <Anchor anchor={choice.removal} fallback={m.studio_draft_point_choose_remove({}, options)} />
            </>
          ) : (
            <>
              <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
                <dt>{m.studio_draft_point_parent({}, options)}</dt>
                <dd>
                  <Anchor anchor={choice.parent} fallback={m.studio_draft_point_root({}, options)} />
                </dd>
                <dt>{m.studio_draft_point_before({}, options)}</dt>
                <dd>
                  <Anchor anchor={choice.before} fallback={m.studio_draft_point_end({}, options)} />
                </dd>
              </dl>
              <div className="studio-action-row">
                <Button type="button" variant="outline" disabled={locked} onClick={visit.root}>
                  {m.studio_draft_point_root({}, options)}
                </Button>
                <Button type="button" variant="outline" disabled={locked} onClick={visit.end}>
                  {m.studio_draft_point_end({}, options)}
                </Button>
              </div>
              <Label htmlFor={titleId}>{m.studio_draft_point_title({}, options)}</Label>
              <Input
                ref={titleInput}
                id={titleId}
                value={state.title}
                disabled={locked}
                onChange={(event) => visit.setTitle(event.target.value)}
              />
              <p className="studio-help">{m.studio_draft_point_title_help({}, options)}</p>
            </>
          )}
        </section>
        {choice.kind === 'chapter' ? (
          <section
            className="studio-stack"
            aria-label={m.studio_draft_point_version({}, options)}
            aria-busy={phase === 'selecting' || phase === 'preparing'}
          >
            <h2>{m.studio_draft_point_version({}, options)}</h2>
            <HostedDraftPickerView
              picker={visit.picker}
              disabled={locked}
              onSelect={(postId) => void visit.select(postId)}
            />
            {selection ? (
              <>
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
                {choice.versionHead !== state.head ? (
                  <div className="studio-stack">
                    <p>{m.studio_draft_point_version_stale({}, options)}</p>
                    <div className="studio-action-row">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={() => void visit.rereadVersion()}
                      >
                        {m.studio_draft_point_reread({}, options)}
                      </Button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>
        ) : null}
        <Outline visit={visit} window={state.outline} locale={locale} locked={locked} />
        <section
          className="studio-stack"
          aria-busy={phase === 'submitting' || phase === 'preparing' || state.refreshing}
        >
          <h2 ref={feedback} tabIndex={-1}>
            {feedbackTitle}
          </h2>
          {body ? (
            <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt>{m.studio_draft_point_head_label({}, options)}</dt>
              <dd>{body.expectedRevisionId}</dd>
              <dt>{m.studio_draft_point_occurrence({}, options)}</dt>
              <dd>{body.occurrenceId}</dd>
              {intent!.request.kind === 'insert' ? (
                <>
                  <dt>{m.studio_draft_point_title({}, options)}</dt>
                  <dd>{intent!.request.body.title}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
          {phase === 'uncertain' ? <p role="alert">{m.studio_draft_point_replay_help({}, options)}</p> : null}
          {phase === 'stale' ? <p role="alert">{m.studio_draft_point_stale_help({}, options)}</p> : null}
          {phase === 'acknowledged' ? (
            <p role="status" className="break-all">
              {m.studio_draft_point_receipt({ revisionId: state.receipt!.revisionId }, options)}
            </p>
          ) : null}
          {phase === 'rejected' ? <p role="alert">{m.studio_draft_point_rejected_help({}, options)}</p> : null}
          {state.refreshing || phase === 'submitting' || phase === 'selecting' || phase === 'preparing' ? (
            <p role="status">{m.studio_draft_point_loading({}, options)}</p>
          ) : null}
          {phase === 'stale' && state.error && state.error.kind !== 'stale' && !state.refreshing ? (
            <p role="alert">{m.studio_draft_point_refresh_failed({}, options)}</p>
          ) : null}
          {editable && phase !== 'review' && !draftPointReady(state) ? (
            <p className="studio-help">{m.studio_draft_point_review_help({}, options)}</p>
          ) : null}
          <div className="studio-action-row">
            {editable && phase !== 'review' ? (
              <Button type="button" disabled={!draftPointReady(state)} onClick={() => void visit.review()}>
                {m.studio_draft_point_review({}, options)}
              </Button>
            ) : null}
            {phase === 'review' || phase === 'uncertain' ? (
              <Button type="button" onClick={() => void visit.submit()}>
                {phase === 'uncertain'
                  ? m.studio_draft_point_replay({}, options)
                  : m.studio_draft_point_submit({}, options)}
              </Button>
            ) : null}
            {phase === 'review' ? (
              <Button type="button" variant="outline" onClick={visit.cancelReview}>
                {m.studio_draft_point_edit({}, options)}
              </Button>
            ) : null}
            {phase === 'stale' ? (
              <Button
                type="button"
                variant="outline"
                disabled={state.refreshing}
                onClick={() => void visit.refreshHead()}
              >
                {m.studio_draft_point_refresh({}, options)}
              </Button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
