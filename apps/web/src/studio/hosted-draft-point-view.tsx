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

function Anchor({ anchor, fallback, locale }: { anchor: DraftPointAnchor | null; fallback: string; locale: Locale }) {
  const options = { locale };
  return anchor ? (
    <div className="studio-stack gap-1">
      <span>{anchor.item.title}</span>
      <span className="studio-help break-all">{anchor.item.occurrenceId}</span>
      <span className="studio-help break-all">
        {m.studio_draft_point_observed({ revisionId: anchor.revisionId }, options)}
      </span>
      {!anchor.confirmed ? <span>{m.studio_draft_point_reobserve({}, options)}</span> : null}
    </div>
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
  const choice = command.kind === 'active' ? command.choice : null;
  const parentId = choice?.parent?.item.occurrenceId ?? null;
  const positions = new Intl.NumberFormat(locale);
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
              <li key={item.occurrenceId} className="studio-stack [overflow-wrap:anywhere]">
                <p>{item.availability === 'available' ? item.title : m.studio_draft_point_unavailable({}, options)}</p>
                <p className="studio-help">
                  {item.kind === 'part'
                    ? m.studio_draft_point_kind_part({}, options)
                    : m.studio_draft_point_kind_chapter({}, options)}
                  {' · '}
                  {m.studio_draft_point_position({ position: positions.format(item.position) }, options)}
                </p>
                <p className="studio-help break-all">{item.occurrenceId}</p>
                <p className="studio-help break-all">
                  {m.studio_draft_point_parent({}, options)}: {item.parentId ?? m.studio_draft_point_root({}, options)}
                </p>
                {item.availability === 'available' ? (
                  <div className="studio-action-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      aria-pressed={choice?.kind === 'move' && choice.move?.item.occurrenceId === item.occurrenceId}
                      onClick={() => visit.observe(item.occurrenceId, 'move')}
                    >
                      {m.studio_draft_point_use_move({ title: item.title }, options)}
                    </Button>
                    {item.kind === 'part' ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        aria-pressed={choice?.parent?.item.occurrenceId === item.occurrenceId}
                        onClick={() => visit.observe(item.occurrenceId, 'parent')}
                      >
                        {m.studio_draft_point_use_parent({ title: item.title }, options)}
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked || item.parentId !== parentId}
                      aria-pressed={choice?.before?.item.occurrenceId === item.occurrenceId}
                      onClick={() => visit.observe(item.occurrenceId, 'before')}
                    >
                      {choice?.kind === 'move'
                        ? m.studio_draft_point_move_before({ title: item.title }, options)
                        : m.studio_draft_point_use_before({ title: item.title }, options)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      onClick={() => visit.observe(item.occurrenceId, 'update')}
                    >
                      {m.studio_point_update_selected({ title: item.title }, options)}
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
          <div className="studio-action-row">
            {state.page.nextCursor !== null ? (
              <Button type="button" variant="outline" disabled={locked} onClick={() => void window.next()}>
                {m.studio_draft_point_next({}, options)}
              </Button>
            ) : null}
            {state.cursor !== null ? (
              <Button type="button" variant="outline" disabled={locked} onClick={() => void window.load(null)}>
                {m.studio_draft_point_restart({}, options)}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}

export function HostedDraftPointView({
  visit,
  locale,
  onPublication,
}: {
  visit: HostedDraftPointVisit;
  locale: Locale;
  onPublication?: () => void;
}) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale };
  const titleId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const feedback = useRef<HTMLHeadingElement>(null);
  const operation = useRef<HTMLHeadingElement>(null);
  const focusRequest = useRef<{ origin: Element | null; target: 'feedback' | 'edit' | 'next-edit' } | null>(null);
  const phase = state.kind === 'active' ? state.phase : 'ended';
  const titleEditable = state.kind === 'active' && state.choice.kind !== 'move' && state.choice.kind !== 'remove';
  const refreshing = state.kind === 'active' && state.refreshing;

  // Only an explicit review/recovery action requests focus. Any subsequent navigation cancels it.
  useEffect(() => {
    const moved = () => {
      focusRequest.current = null;
    };
    const keyed = (event: KeyboardEvent) => {
      if (event.key === 'Tab') moved();
    };
    document.addEventListener('focusin', moved);
    document.addEventListener('pointerdown', moved);
    document.addEventListener('keydown', keyed);
    return () => {
      document.removeEventListener('focusin', moved);
      document.removeEventListener('pointerdown', moved);
      document.removeEventListener('keydown', keyed);
    };
  }, []);
  useEffect(() => {
    const pending = focusRequest.current;
    if (!pending || !visit.isCurrent()) return;
    const ready =
      pending.target === 'next-edit'
        ? phase === 'idle' || (phase === 'next-edit' && !refreshing)
        : pending.target === 'edit'
          ? phase === 'idle' || (phase === 'stale' && !refreshing)
          : ['review', 'acknowledged', 'uncertain', 'stale', 'rejected'].includes(phase);
    if (!ready) return;
    focusRequest.current = null;
    const stillHere =
      document.activeElement === pending.origin ||
      (!pending.origin?.isConnected && document.activeElement === document.body);
    if (stillHere) {
      if (pending.target === 'feedback' || phase === 'stale' || phase === 'next-edit') feedback.current?.focus();
      else if (pending.target === 'next-edit') operation.current?.focus();
      else if (titleEditable) titleInput.current?.focus();
      else operation.current?.focus();
    }
  }, [visit, state, phase, titleEditable, refreshing]);
  const focusAfter = (
    action: () => void | Promise<void>,
    target: 'feedback' | 'edit' | 'next-edit' = 'feedback',
  ) => {
    focusRequest.current = { origin: document.activeElement, target };
    void action();
  };

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
      : phase === 'next-edit'
        ? m.studio_draft_command_current_head({}, options)
        : phase === 'uncertain'
          ? m.studio_draft_point_uncertain({}, options)
          : phase === 'stale'
            ? m.studio_draft_point_stale({}, options)
            : phase === 'rejected'
              ? m.studio_draft_point_rejected({}, options)
              : m.studio_draft_point_review({}, options);
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl px-4 py-8 [overflow-wrap:anywhere]">
      <header className="studio-header">
        <h1>{m.studio_draft_point_heading({}, options)}</h1>
        <p className="studio-help max-w-prose">{m.studio_draft_point_help({}, options)}</p>
        <div className="studio-action-row">
          {onPublication ? (
            <Button type="button" variant="outline" onClick={onPublication}>
              {m.studio_point_publication_heading({}, options)}
            </Button>
          ) : null}
          <a className="studio-toc-open" href={localizeHref('/studio?books=1', options)}>
            {m.studio_root_append_return({}, options)}
          </a>
          <a className="studio-toc-open" href={localizeHref(existingEditor, options)}>
            {m.studio_draft_point_editor({}, options)}
          </a>
        </div>
      </header>
      <div className="studio-stack gap-8">
        {phase !== 'next-edit' ? (
          <p className="studio-help break-all">{m.studio_draft_point_head({ revisionId: state.head }, options)}</p>
        ) : null}
        <section className="studio-stack" aria-label={m.studio_draft_point_operation({}, options)}>
          <h2 ref={operation} tabIndex={-1}>
            {m.studio_draft_point_operation({}, options)}
          </h2>
          <div className="studio-action-row">
            {(['part', 'chapter', 'move', 'update', 'remove'] as const).map((kind) => (
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
                  : kind === 'move'
                    ? m.studio_draft_point_move({}, options)
                    : kind === 'update'
                      ? m.studio_point_update({}, options)
                      : kind === 'chapter'
                        ? m.studio_draft_point_chapter({}, options)
                        : m.studio_draft_point_remove({}, options)}
              </Button>
            ))}
          </div>
          {choice.kind === 'remove' ? (
            <>
              <p>{m.studio_draft_point_subtree({}, options)}</p>
              <Anchor
                anchor={choice.removal}
                fallback={m.studio_draft_point_choose_remove({}, options)}
                locale={locale}
              />
            </>
          ) : (
            <>
              {choice.kind === 'move' ? (
                <>
                  <h3>{m.studio_draft_point_source({}, options)}</h3>
                  <Anchor
                    anchor={choice.move}
                    fallback={m.studio_draft_point_choose_move({}, options)}
                    locale={locale}
                  />
                  <p className="studio-help">{m.studio_draft_point_move_help({}, options)}</p>
                </>
              ) : null}
              {choice.kind === 'update' ? (
                <>
                  <Anchor anchor={choice.update} fallback={m.studio_point_choose_update({}, options)} locale={locale} />
                  <p>{m.studio_point_update_help({}, options)}</p>
                </>
              ) : (
                <>
                  <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
                    <dt>{m.studio_draft_point_parent({}, options)}</dt>
                    <dd>
                      <Anchor
                        anchor={choice.parent}
                        fallback={m.studio_draft_point_root({}, options)}
                        locale={locale}
                      />
                    </dd>
                    <dt>{m.studio_draft_point_destination_before({}, options)}</dt>
                    <dd>
                      <Anchor anchor={choice.before} fallback={m.studio_draft_point_end({}, options)} locale={locale} />
                    </dd>
                  </dl>
                  <div className="studio-action-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      aria-pressed={choice.parent === null}
                      onClick={visit.root}
                    >
                      {m.studio_draft_point_root({}, options)}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      aria-pressed={choice.before === null}
                      onClick={visit.end}
                    >
                      {m.studio_draft_point_end({}, options)}
                    </Button>
                  </div>
                </>
              )}
              {choice.kind !== 'move' ? (
                <>
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
              ) : null}
            </>
          )}
        </section>
        {choice.kind === 'chapter' || (choice.kind === 'update' && choice.update?.item.kind === 'chapter') ? (
          <section
            className="studio-stack"
            aria-label={m.studio_draft_point_version({}, options)}
            aria-busy={phase === 'selecting' || phase === 'preparing'}
          >
            <h2>{m.studio_draft_point_version({}, options)}</h2>
            {choice.kind === 'update' ? (
              <div className="studio-action-row">
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked}
                  onClick={() => void visit.readUpdateVersion()}
                >
                  {m.studio_draft_point_reread({}, options)}
                </Button>
              </div>
            ) : null}
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
        <section
          className="studio-stack"
          aria-busy={phase === 'submitting' || phase === 'preparing' || state.refreshing}
        >
          <h2 ref={feedback} tabIndex={-1}>
            {feedbackTitle}
          </h2>
          {body ? (
            <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt>{m.studio_draft_point_catalogue({}, options)}</dt>
              <dd>{intent!.request.catalogueId}</dd>
              <dt>{m.studio_draft_point_head_label({}, options)}</dt>
              <dd>{body.expectedRevisionId}</dd>
              <dt>{m.studio_draft_point_occurrence({}, options)}</dt>
              <dd>{body.occurrenceId}</dd>
              {intent!.request.kind === 'move' ? (
                <>
                  <dt>{m.studio_draft_point_source({}, options)}</dt>
                  <dd>
                    <Anchor
                      anchor={choice.move}
                      fallback={m.studio_draft_point_choose_move({}, options)}
                      locale={locale}
                    />
                  </dd>
                </>
              ) : null}
              {'title' in body ? (
                <>
                  <dt>{m.studio_draft_point_title({}, options)}</dt>
                  <dd>{body.title}</dd>
                </>
              ) : null}
              {'parentId' in body ? (
                <>
                  <dt>{m.studio_draft_point_parent({}, options)}</dt>
                  <dd>
                    <Anchor anchor={choice.parent} fallback={m.studio_draft_point_root({}, options)} locale={locale} />
                  </dd>
                  <dt>{m.studio_draft_point_destination_before({}, options)}</dt>
                  <dd>
                    <Anchor anchor={choice.before} fallback={m.studio_draft_point_end({}, options)} locale={locale} />
                  </dd>
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
          {state.receipt && phase !== 'acknowledged' ? (
            <p className="studio-help break-all">
              {m.studio_draft_command_history({ revisionId: state.receipt.revisionId }, options)}
            </p>
          ) : null}
          {phase === 'acknowledged' || phase === 'next-edit' ? (
            <p className="studio-help">{m.studio_draft_command_next_help({}, options)}</p>
          ) : null}
          {phase === 'next-edit' && state.error && !refreshing ? (
            <div role="alert" className="studio-stack">
              <p>{m.studio_draft_command_next_failed({}, options)}</p>
              <p>{state.error.message}</p>
            </div>
          ) : null}
          {phase === 'rejected' ? <p role="alert">{m.studio_draft_point_rejected_help({}, options)}</p> : null}
          {state.refreshing || phase === 'submitting' || phase === 'selecting' || phase === 'preparing' ? (
            <p role="status">{m.studio_draft_point_loading({}, options)}</p>
          ) : null}
          {phase === 'stale' && state.error && state.error.kind !== 'stale' && !state.refreshing ? (
            <p role="alert">{m.studio_draft_point_refresh_failed({}, options)}</p>
          ) : null}
          {editable && phase !== 'review' && !draftPointReady(state) ? (
            <p className="studio-help">
              {choice.kind === 'move'
                ? m.studio_draft_point_move_review_help({}, options)
                : m.studio_draft_point_review_help({}, options)}
            </p>
          ) : null}
          <div className="studio-action-row">
            {phase === 'acknowledged' || phase === 'next-edit' ? (
              <Button
                type="button"
                disabled={refreshing}
                onClick={() => focusAfter(visit.nextEdit, 'next-edit')}
              >
                {phase === 'acknowledged'
                  ? m.studio_draft_command_next_edit({}, options)
                  : m.studio_draft_command_retry_next({}, options)}
              </Button>
            ) : null}
            {editable && phase !== 'review' ? (
              <Button type="button" disabled={!draftPointReady(state)} onClick={() => focusAfter(visit.review)}>
                {m.studio_draft_point_review({}, options)}
              </Button>
            ) : null}
            {phase === 'review' || phase === 'uncertain' ? (
              <Button type="button" onClick={() => focusAfter(visit.submit)}>
                {phase === 'uncertain'
                  ? m.studio_draft_point_replay({}, options)
                  : m.studio_draft_point_submit({}, options)}
              </Button>
            ) : null}
            {phase === 'review' ? (
              <Button type="button" variant="outline" onClick={() => focusAfter(visit.cancelReview, 'edit')}>
                {m.studio_draft_point_edit({}, options)}
              </Button>
            ) : null}
            {phase === 'stale' ? (
              <Button
                type="button"
                variant="outline"
                disabled={state.refreshing}
                onClick={() => focusAfter(visit.refreshHead, 'edit')}
              >
                {m.studio_draft_point_refresh({}, options)}
              </Button>
            ) : null}
          </div>
        </section>
        <Outline visit={visit} window={state.outline} locale={locale} locked={locked} />
      </div>
    </main>
  );
}
