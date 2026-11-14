import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { PostReadingBody } from '../threads/post-reading-body';
import { fullDateTime } from '../threads/byline-time';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { sameExact, type ExactDocument, type StudioPresentation, type StudioRevision } from './contract';
import type { StudioController, StudioState } from './controller';

const control = 'h-auto min-h-11 min-w-11 max-w-full whitespace-normal text-start [overflow-wrap:anywhere]';

export function ExactVersionDetails({ exact }: { exact: ExactDocument }) {
  const options = { locale: getLocale() };
  return (
    <details className="studio-technical min-w-0">
      <summary className={control}>{m.studio_revision_exact({}, options)}</summary>
      <dl>
        <dt>{m.studio_revision_post({}, options)}</dt>
        <dd>{exact.postId}</dd>
        <dt>{m.studio_revision_id({}, options)}</dt>
        <dd>{exact.revisionId}</dd>
        <dt>{m.studio_revision_digest({}, options)}</dt>
        <dd>{exact.sha256}</dd>
      </dl>
    </details>
  );
}

export function RevisionBody({
  revision,
  presentation,
  isCurrent,
}: {
  revision: StudioRevision;
  presentation: StudioPresentation;
  isCurrent: () => boolean;
}) {
  const locale = getLocale();
  const options = { locale };
  const title = revision.title.trim() || m.own_drafts_no_title({}, options);
  const exactKey = `${revision.exact.postId}:${revision.exact.revisionId}:${revision.exact.sha256}`;
  return (
    <section className="studio-revision-body min-w-0" aria-label={m.studio_revision_saved_name({ title }, options)}>
      <h3 className="[overflow-wrap:anywhere]">{title}</h3>
      <p className="studio-help">
        <time dateTime={revision.savedAt} title={revision.savedAt}>
          {m.studio_revision_saved({ savedAt: fullDateTime(revision.savedAt, locale) }, options)}
        </time>
      </p>
      <ExactVersionDetails exact={revision.exact} />
      <PostReadingBody
        {...presentation.reader?.(revision.exact)}
        document={revision.body}
        readerIdentity={revision}
        isReaderCurrent={isCurrent}
        visitKey={exactKey}
        wideVisitKey={`studio-version:${exactKey}`}
        locale={locale}
      />
    </section>
  );
}

type VersionProps = {
  controller: StudioController;
  state: StudioState;
  presentation: StudioPresentation;
  /** Closing the workspace history retires readers and focus, while keeping its bounded page and copy review. */
  active?: boolean;
};

/** Replacement retires local disclosures and focus as well as the controller's version coordinates. */
export function StudioVersions(props: VersionProps) {
  const locale = getLocale();
  const postId = props.state.selected?.source.revision.exact.postId;
  const admitted = props.controller.port.isCurrent();
  const [visit, setVisit] = useState(() => ({ controller: props.controller, locale, postId, generation: 0 }));
  useLayoutEffect(() => {
    props.controller.retainVersionLocale(locale);
    if (!admitted) props.controller.retireVersions();
  }, [props.controller, locale, admitted]);
  useLayoutEffect(() => () => props.controller.retireVersions(), [props.controller]);
  if (visit.controller !== props.controller || visit.locale !== locale || visit.postId !== postId) {
    setVisit({ controller: props.controller, locale, postId, generation: visit.generation + 1 });
    return null;
  }
  if (!admitted || props.state.versionLocale !== locale) return null;
  return <VersionVisit key={visit.generation} {...props} />;
}

type FocusTicket = { cancel: () => void; live: () => boolean };

/** Only the explicit keyboard command may orient; a focus move, hidden tab or replacement cancels it. */
function useVersionMovement(controller: StudioController, root: RefObject<HTMLElement | null>, active: boolean) {
  const ticket = useRef<FocusTicket | null>(null);
  const [pending, setPending] = useState<{ ticket: FocusTicket; target: RefObject<HTMLHeadingElement | null> } | null>(
    null,
  );
  const locale = getLocale();
  useLayoutEffect(
    () => () => {
      ticket.current?.cancel();
      ticket.current = null;
    },
    [controller, locale, active],
  );
  useLayoutEffect(() => {
    if (!pending) return;
    if (
      pending.ticket === ticket.current &&
      pending.ticket.live() &&
      pending.target.current?.isConnected &&
      !root.current?.closest('[hidden], [inert], [aria-hidden="true"]')
    ) {
      pending.target.current.focus();
    }
    pending.ticket.cancel();
    if (ticket.current === pending.ticket) ticket.current = null;
  }, [pending, root]);
  return (
    event: MouseEvent<HTMLButtonElement>,
    action: () => Promise<boolean>,
    target: RefObject<HTMLHeadingElement | null>,
  ) => {
    ticket.current?.cancel();
    ticket.current = null;
    const origin = event.currentTarget;
    const document = origin.ownerDocument;
    let next: FocusTicket | null = null;
    if (event.detail === 0 && document.activeElement === origin) {
      let moved = false;
      const onFocus = (event: FocusEvent) => {
        if (event.target !== origin) moved = true;
      };
      document.addEventListener('focusin', onFocus, true);
      next = {
        cancel: () => {
          moved = true;
          document.removeEventListener('focusin', onFocus, true);
        },
        live: () => !moved && controller.current() && getLocale() === locale && Boolean(root.current?.isConnected),
      };
      ticket.current = next;
    }
    const requested = next;
    void action().then((succeeded) => {
      if (succeeded && requested && ticket.current === requested && requested.live()) {
        setPending({ ticket: requested, target });
      } else {
        requested?.cancel();
        if (ticket.current === requested) ticket.current = null;
      }
    });
  };
}

function VersionVisit({ controller, state, presentation, active = true }: VersionProps) {
  const root = useRef<HTMLElement>(null);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const comparisonHeading = useRef<HTMLHeadingElement>(null);
  const activity = useRef(active);
  activity.current = active;
  const move = useVersionMovement(controller, root, active);
  const locale = getLocale();
  const options = { locale };
  const selected = state.selected;
  const historical = state.historical;
  const readingCurrent = useCallback(
    () => activity.current && controller.current() && getLocale() === locale && Boolean(root.current?.isConnected),
    [controller, locale],
  );
  const historicalCurrent = useCallback(
    () => readingCurrent() && controller.snapshot().historical === historical,
    [readingCurrent, controller, historical],
  );
  const currentRevision = selected?.source.revision;
  const savedCurrent = useCallback(
    () => readingCurrent() && controller.snapshot().selected?.source.revision === currentRevision,
    [readingCurrent, controller, currentRevision],
  );
  if (!selected) return null;
  const blocked = Boolean(state.operation) || controller.hasUnresolvedCommand();
  const copyBlocked = blocked || selected.snapshotPending || selected.uploading;
  const copyReview = state.versionCopyReview;
  const copyReviewed = controller.isVersionCopyReviewCurrent(copyReview);
  const failed = state.versionNavigation.staged && !state.operation;
  const compareTime = historical ? fullDateTime(historical.savedAt, locale) : '';
  return (
    <section ref={root} className="studio-stack min-w-0" aria-label={m.studio_revision_region({}, options)}>
      <div className="studio-section-heading flex-wrap gap-3">
        <h2 ref={pageHeading} tabIndex={-1}>
          {m.studio_revision_heading({}, options)}
        </h2>
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={blocked}
          onClick={(event) => move(event, () => controller.loadVersions(), pageHeading)}
        >
          {m.studio_revision_first({}, options)}
        </Button>
      </div>
      <p className="studio-help">{m.studio_revision_intro({}, options)}</p>
      {failed ? (
        <div role="status" className="studio-stack">
          <p>{m.studio_revision_navigation_failed({}, options)}</p>
          <Button
            type="button"
            variant="outline"
            className={control}
            disabled={blocked}
            onClick={(event) => move(event, () => controller.navigateVersions('retry'), pageHeading)}
          >
            {m.studio_revision_retry({}, options)}
          </Button>
        </div>
      ) : null}
      {state.versions ? (
        <>
          <ol className="studio-version-list">
            {state.versions.items.map((version) => (
              <li key={`${version.exact.revisionId}:${version.exact.sha256}`}>
                <Button
                  type="button"
                  variant="outline"
                  className={control}
                  disabled={blocked}
                  aria-pressed={Boolean(historical && sameExact(historical.exact, version.exact))}
                  onClick={(event) => move(event, () => controller.inspectVersion(version.exact), comparisonHeading)}
                >
                  <time dateTime={version.savedAt} title={version.savedAt}>
                    {m.studio_revision_compare({ savedAt: fullDateTime(version.savedAt, locale) }, options)}
                  </time>
                </Button>
                <ExactVersionDetails exact={version.exact} />
              </li>
            ))}
          </ol>
          {!state.versions.items.length ? (
            <p>
              {state.versions.nextCursor !== null
                ? m.thread_history_page_empty({}, options)
                : m.thread_history_empty({}, options)}
            </p>
          ) : null}
          <nav className="studio-action-row" aria-label={m.studio_revision_region({}, options)}>
            <Button
              type="button"
              variant="outline"
              className={control}
              disabled={blocked || !state.versionNavigation.predecessors.length}
              onClick={(event) => move(event, () => controller.navigateVersions('previous'), pageHeading)}
            >
              {m.studio_revision_previous({}, options)}
            </Button>
            {state.versions.nextCursor !== null ? (
              <Button
                type="button"
                variant="outline"
                className={control}
                disabled={blocked}
                onClick={(event) => move(event, () => controller.loadVersions(true), pageHeading)}
              >
                {m.studio_revision_next({}, options)}
              </Button>
            ) : null}
          </nav>
        </>
      ) : !failed ? (
        <Button
          type="button"
          variant="outline"
          className={control}
          disabled={blocked}
          onClick={(event) => move(event, () => controller.loadVersions(), pageHeading)}
        >
          {m.studio_revision_load({}, options)}
        </Button>
      ) : null}
      {state.inspectedVersion && active ? (
        <div className="studio-comparison">
          <div>
            <h3 ref={comparisonHeading} tabIndex={-1}>
              {m.studio_revision_selected({}, options)}
            </h3>
            {historical ? (
              <RevisionBody
                key={`${historical.exact.revisionId}:${historical.exact.sha256}`}
                revision={historical}
                presentation={presentation}
                isCurrent={historicalCurrent}
              />
            ) : (
              <p role="status">
                {state.operation === 'revision'
                  ? m.studio_workspace_reading_version({}, options)
                  : m.studio_workspace_failure_unavailable({}, options)}
              </p>
            )}
          </div>
          <div>
            <h3>{m.studio_revision_current({}, options)}</h3>
            <RevisionBody
              key={`${selected.source.revision.exact.revisionId}:${selected.source.revision.exact.sha256}`}
              revision={selected.source.revision}
              presentation={presentation}
              isCurrent={savedCurrent}
            />
          </div>
        </div>
      ) : null}
      {historical ? (
        <>
          {selected.dirty ? <p className="studio-help">{m.studio_revision_unsaved({}, options)}</p> : null}
          {selected.source.permissions.edit ? (
            copyReview ? (
              <div role="group" aria-label={m.studio_revision_copy_review({}, options)} className="studio-stack">
                {!copyReviewed ? <p role="status">{m.studio_revision_review_changed({}, options)}</p> : null}
                <p>
                  {selected.dirty
                    ? m.studio_revision_replace_dirty({ title: historical.title, savedAt: compareTime }, options)
                    : m.studio_revision_replace_clean({ title: historical.title, savedAt: compareTime }, options)}
                </p>
                <div className="studio-action-row">
                  {copyReviewed ? (
                    <Button
                      type="button"
                      className={control}
                      disabled={copyBlocked}
                      onClick={() => controller.restoreVersion(copyReview)}
                    >
                      {m.studio_revision_copy({}, options)}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className={control}
                      disabled={copyBlocked}
                      onClick={() => controller.reviewVersionCopy()}
                    >
                      {m.studio_revision_use({}, options)}
                    </Button>
                  )}
                  <Button type="button" variant="outline" className={control} onClick={controller.cancelVersionCopy}>
                    {m.action_cancel({}, options)}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className={control}
                disabled={copyBlocked}
                onClick={() => controller.reviewVersionCopy()}
              >
                {m.studio_revision_use({}, options)}
              </Button>
            )
          ) : null}
        </>
      ) : null}
    </section>
  );
}
