import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { DocumentBody } from '../document-body';
import { m } from '../paraglide/messages.js';
import { localizeHref, type Locale } from '../paraglide/runtime.js';
import type { HostedOutlineWindow } from './hosted-outline-window';
import {
  publicationPointReady,
  type HostedPublicationPointVisit,
  type PublicationPointAnchor,
} from './hosted-publication-point';
import { HostedReleaseReaderLink } from './hosted-release-reader-link-action';
import { HostedSourceConsentView } from './hosted-source-consent-view';
import './studio.css';

function Anchor({ anchor, empty }: { anchor: PublicationPointAnchor | null; empty: string }) {
  return anchor ? (
    <span>
      {anchor.item.title}
      <br />
      <span className="studio-help break-all">{anchor.item.occurrenceId}</span>
    </span>
  ) : (
    <span>{empty}</span>
  );
}
function Window({
  visit,
  window,
  publicSnapshot,
  locked,
  locale,
}: {
  visit: HostedPublicationPointVisit;
  window: HostedOutlineWindow;
  publicSnapshot: boolean;
  locked: boolean;
  locale: Locale;
}) {
  const state = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  const command = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const options = { locale };
  const title = publicSnapshot ? m.studio_point_public_outline({}, options) : m.studio_draft_point_outline({}, options);
  return (
    <section className="studio-stack" aria-label={title} aria-busy={state.kind === 'loading'}>
      <h2>{title}</h2>
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
          <p className="studio-help break-all">{state.page.revisionId}</p>
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
                    {!publicSnapshot ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={locked}
                        onClick={() => visit.observeDraft(item.occurrenceId)}
                      >
                        {item.kind === 'chapter'
                          ? m.studio_point_select_chapter({ title: item.title }, options)
                          : m.studio_point_review_ancestor({ title: item.title }, options)}
                      </Button>
                    ) : (
                      <>
                        {item.kind === 'part' ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              disabled={locked}
                              onClick={() => visit.observePublic(item.occurrenceId, 'parent')}
                            >
                              {m.studio_draft_point_use_parent({ title: item.title }, options)}
                            </Button>
                            {command.kind === 'active' &&
                            command.ancestors.some((a) => a.draft.item.occurrenceId === item.occurrenceId) ? (
                              <Button
                                type="button"
                                variant="outline"
                                disabled={locked}
                                onClick={() => visit.observePublic(item.occurrenceId, 'ancestor')}
                              >
                                {m.studio_point_already_public({ title: item.title }, options)}
                              </Button>
                            ) : null}
                          </>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={locked}
                            onClick={() => visit.observePublic(item.occurrenceId, 'replacement')}
                          >
                            {m.studio_point_replace_selected({ title: item.title }, options)}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="outline"
                          disabled={locked}
                          onClick={() => visit.observePublic(item.occurrenceId, 'before')}
                        >
                          {m.studio_draft_point_use_before({ title: item.title }, options)}
                        </Button>
                      </>
                    )}
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

/** Illustrative stories and the mounted point route share the complete review/recovery surface. */
export function HostedPublicationPointView({
  visit,
  locale,
  onBack,
}: {
  visit: HostedPublicationPointVisit;
  locale: Locale;
  onBack?: () => void;
}) {
  const state = useSyncExternalStore(visit.subscribe, visit.snapshot, visit.snapshot);
  const feedback = useRef<HTMLHeadingElement>(null);
  const options = { locale };
  const phase = state.kind === 'active' ? state.phase : 'ended';
  useEffect(() => {
    if (visit.isCurrent() && ['review', 'stale', 'rejected', 'uncertain', 'acknowledged'].includes(phase))
      feedback.current?.focus();
  }, [visit, phase]);
  if (state.kind === 'ended') return <p role="alert">{m.studio_draft_point_ended({}, options)}</p>;
  const locked = !visit.canEdit() || phase === 'review';
  const acknowledged = phase === 'acknowledged';
  const review = phase === 'review' || phase === 'uncertain' || phase === 'submitting' || acknowledged;
  const activeParent =
    state.destination === null
      ? (state.parent?.item.occurrenceId ?? null)
      : (state.ancestors.find((a) => a.draft.item.occurrenceId === state.destination)?.draft.item.parentId ?? null);
  return (
    <main className="studio-workspace mx-auto w-full max-w-4xl px-4 py-8">
      <header className="studio-header">
        <h1>{m.studio_point_publication_heading({}, options)}</h1>
        <p className="studio-help max-w-prose">{m.studio_point_publication_help({}, options)}</p>
        <div className="studio-action-row">
          {onBack ? (
            <Button type="button" variant="outline" onClick={onBack}>
              {m.studio_point_back_draft({}, options)}
            </Button>
          ) : null}
          <a className="studio-toc-open" href={localizeHref(`/studio?catalogueId=${state.owner.catalogueId}`, options)}>
            {m.studio_draft_point_editor({}, options)}
          </a>
        </div>
      </header>
      <div className="studio-stack gap-8">
        <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt>{m.studio_draft_point_head_label({}, options)}</dt>
          <dd>{state.owner.headRevisionId}</dd>
          <dt>{m.studio_point_public_outline({}, options)}</dt>
          <dd>{state.owner.publicationId ?? m.studio_point_first_release({}, options)}</dd>
        </dl>
        <section className="studio-stack" aria-label={m.studio_draft_point_operation({}, options)}>
          <h2>{m.studio_draft_point_operation({}, options)}</h2>
          <div className="studio-action-row">
            <Button
              type="button"
              variant="outline"
              aria-pressed={state.operation === 'publish'}
              disabled={locked}
              onClick={() => visit.setOperation('publish')}
            >
              {m.studio_point_add_public({}, options)}
            </Button>
            <Button
              type="button"
              variant="outline"
              aria-pressed={state.operation === 'replace'}
              disabled={locked}
              onClick={() => visit.setOperation('replace')}
            >
              {m.studio_point_replace_public({}, options)}
            </Button>
          </div>
          <p>
            {state.operation === 'replace'
              ? m.studio_point_replace_help({}, options)
              : m.studio_point_ancestor_help({}, options)}
          </p>
          <Anchor anchor={state.chapter} empty={m.studio_point_choose_chapter({}, options)} />
          {state.operation === 'replace' ? (
            <>
              <Anchor anchor={state.replacement} empty={m.studio_point_choose_public({}, options)} />
              {state.replacement ? (
                <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt>{m.studio_draft_point_parent({}, options)}</dt>
                  <dd>{state.replacement.item.parentId ?? m.studio_draft_point_root({}, options)}</dd>
                  <dt>{m.studio_point_placement({}, options)}</dt>
                  <dd>{state.replacement.item.position + 1}</dd>
                </dl>
              ) : null}
            </>
          ) : null}
        </section>
        {state.draft ? (
          <Window visit={visit} window={state.draft} publicSnapshot={false} locked={locked} locale={locale} />
        ) : null}
        {state.publication ? (
          <Window visit={visit} window={state.publication} publicSnapshot locked={locked} locale={locale} />
        ) : null}
        {state.operation === 'publish' ? (
          <section className="studio-stack" aria-label={m.studio_point_ancestors({}, options)}>
            <h2>{m.studio_point_ancestors({}, options)}</h2>
            <p className="studio-help">{m.studio_point_ancestor_help({}, options)}</p>
            <ol className="studio-draft-list">
              {state.ancestors.map((a) => (
                <li className="studio-stack" key={a.draft.item.occurrenceId}>
                  <Anchor anchor={a.draft} empty="" />
                  {a.public && !a.include ? (
                    <p>{m.studio_point_already_public({ title: a.public.item.title }, options)}</p>
                  ) : null}
                  <div className="studio-action-row">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={locked}
                      aria-pressed={a.include}
                      onClick={() => visit.includeAncestor(a.draft.item.occurrenceId, !a.include)}
                    >
                      {m.studio_point_include_ancestor({ title: a.draft.item.title }, options)}
                    </Button>
                    {a.include ? (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={locked}
                          onClick={() => visit.useAncestorParent(a.draft.item.occurrenceId)}
                        >
                          {m.studio_draft_point_use_parent({ title: a.draft.item.title }, options)}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          disabled={locked}
                          aria-pressed={state.destination === a.draft.item.occurrenceId}
                          onClick={() => visit.destination(a.draft.item.occurrenceId)}
                        >
                          {m.studio_point_place_ancestor({ title: a.draft.item.title }, options)}
                        </Button>
                        <Anchor anchor={a.before} empty={m.studio_draft_point_end({}, options)} />
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
            <h3>{m.studio_point_placement({}, options)}</h3>
            <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt>{m.studio_draft_point_parent({}, options)}</dt>
              <dd>
                <Anchor anchor={state.parent} empty={m.studio_draft_point_root({}, options)} />
              </dd>
              <dt>{m.studio_draft_point_before({}, options)}</dt>
              <dd>
                <Anchor anchor={state.before} empty={m.studio_draft_point_end({}, options)} />
              </dd>
            </dl>
            <p className="studio-help break-all">
              {m.studio_point_anchor_destination(
                { parent: activeParent ?? m.studio_draft_point_root({}, options) },
                options,
              )}
            </p>
            <div className="studio-action-row">
              <Button type="button" variant="outline" disabled={locked} onClick={visit.root}>
                {m.studio_draft_point_root({}, options)}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={locked}
                aria-pressed={state.destination === null}
                onClick={() => visit.destination(null)}
              >
                {m.studio_point_place_chapter({}, options)}
              </Button>
              <Button type="button" variant="outline" disabled={locked} onClick={visit.end}>
                {m.studio_draft_point_end({}, options)}
              </Button>
            </div>
          </section>
        ) : null}
        {state.chapter?.item.kind === 'chapter' ? (
          <section className="studio-stack" aria-label={m.studio_draft_point_version({}, options)}>
            <h2>{m.studio_draft_point_version({}, options)}</h2>
            <div className="studio-action-row">
              <Button type="button" variant="outline" disabled={locked} onClick={() => void visit.readVersion()}>
                {m.studio_draft_point_reread({}, options)}
              </Button>
            </div>
            {state.version ? (
              <>
                <h3>{state.chapter.item.title}</h3>
                <time dateTime={state.version.savedAt}>{state.version.savedAt}</time>
                <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
                  <dt>{m.studio_root_append_post({}, options)}</dt>
                  <dd>{state.version.exact.postId}</dd>
                  <dt>{m.studio_root_append_revision({}, options)}</dt>
                  <dd>{state.version.exact.revisionId}</dd>
                  <dt>{m.studio_root_append_digest({}, options)}</dt>
                  <dd>{state.version.exact.sha256}</dd>
                </dl>
                <DocumentBody document={state.version.body} visitKey={JSON.stringify([state.version.exact, locale])} />
              </>
            ) : null}
          </section>
        ) : null}
        <section
          className="studio-stack"
          aria-busy={phase === 'loading' || phase === 'selecting' || phase === 'submitting'}
        >
          <h2 ref={feedback} tabIndex={-1}>
            {acknowledged
              ? m.studio_draft_point_acknowledged({}, options)
              : phase === 'stale'
                ? m.studio_draft_point_stale({}, options)
                : phase === 'uncertain'
                  ? m.studio_draft_point_uncertain({}, options)
                  : m.studio_draft_point_review({}, options)}
          </h2>
          {review && state.intent ? (
            <dl className="grid min-w-0 gap-2 break-all sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt>{m.studio_draft_point_head_label({}, options)}</dt>
              <dd>{state.intent.request.body.expectedRevisionId}</dd>
              <dt>{m.studio_point_public_outline({}, options)}</dt>
              <dd>{state.intent.request.body.expectedPublicationId}</dd>
              <dt>{m.studio_draft_point_occurrence({}, options)}</dt>
              <dd>{state.intent.request.body.occurrenceId}</dd>
            </dl>
          ) : null}
          {phase === 'stale' ? <p role="alert">{m.studio_draft_point_stale_help({}, options)}</p> : null}
          {phase === 'uncertain' ? <p role="alert">{m.studio_draft_point_replay_help({}, options)}</p> : null}
          {phase === 'rejected' ? <p role="alert">{m.studio_point_eligibility_help({}, options)}</p> : null}
          {state.error ? <p role="alert">{m.studio_point_recovery({}, options)}</p> : null}
          {acknowledged ? (
            <p role="status" className="break-all">
              {m.studio_draft_point_receipt({ revisionId: state.receipt!.revisionId }, options)}
            </p>
          ) : null}
          {state.readbackError ? <p role="alert">{m.studio_point_readback_help({}, options)}</p> : null}
          {review && visit.sourceConsent ? (
            <HostedSourceConsentView
              visit={visit.sourceConsent}
              bookTitle={state.owner.title ?? m.threads_untitled({}, options)}
              locale={locale}
              disabled={phase === 'submitting'}
            />
          ) : null}
          {['loading', 'selecting', 'submitting'].includes(phase) ? (
            <p role="status">{m.studio_draft_point_loading({}, options)}</p>
          ) : null}
          {!locked && !publicationPointReady(state) ? (
            <p className="studio-help">{m.studio_point_ready_help({}, options)}</p>
          ) : null}
          <div className="studio-action-row">
            {!locked ? (
              <Button type="button" disabled={!publicationPointReady(state)} onClick={visit.review}>
                {m.studio_draft_point_review({}, options)}
              </Button>
            ) : null}
            {phase === 'review' || phase === 'uncertain' ? (
              <Button type="button" onClick={() => void visit.submit()}>
                {phase === 'uncertain' ? m.studio_draft_point_replay({}, options) : m.studio_point_confirm({}, options)}
              </Button>
            ) : null}
            {phase === 'review' ? (
              <Button type="button" variant="outline" onClick={visit.cancelReview}>
                {m.studio_draft_point_edit({}, options)}
              </Button>
            ) : null}
            {phase === 'stale' || !locked ? (
              <Button type="button" variant="outline" onClick={() => void visit.refresh()}>
                {m.studio_point_refresh({}, options)}
              </Button>
            ) : null}
            {acknowledged ? (
              <Button type="button" variant="outline" onClick={() => void visit.readback()}>
                {m.studio_draft_point_retry_read({}, options)}
              </Button>
            ) : null}
          </div>
          <HostedReleaseReaderLink binding={visit.readerLink} locale={locale} />
        </section>
      </div>
    </main>
  );
}
