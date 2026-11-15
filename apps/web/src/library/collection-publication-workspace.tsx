import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';

export type CollectionPublicationWorkspaceMode = 'selected' | 'query';

type CollectionPublicationWorkspaceProps = {
  mode: CollectionPublicationWorkspaceMode;
  modeNavigation?: ReactNode;
  backLink?: ReactNode;
  sourceIdentity?: ReactNode;
  help?: ReactNode;
  busy?: boolean;
  sourceKey?: string | null;
  unavailable?: ReactNode;
  selection?: ReactNode;
  review?: ReactNode;
  queryAction?: ReactNode;
  continuation?: ReactNode;
  result?: ReactNode;
  details?: ReactNode;
};

/** Presentation frame only; command, selection and recovery state remain with their existing owners. */
export function CollectionPublicationWorkspace({
  mode,
  modeNavigation,
  backLink,
  sourceIdentity,
  help,
  busy = false,
  sourceKey,
  unavailable,
  selection,
  review,
  queryAction,
  continuation,
  result,
  details,
}: CollectionPublicationWorkspaceProps) {
  const [mobileReview, setMobileReview] = useState(false);
  const mobileReviewTrigger = useRef<HTMLButtonElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const focusAfterTransition = useRef<'selection' | 'review' | null>(null);
  useEffect(() => {
    focusAfterTransition.current = null;
    setMobileReview(false);
  }, [mode, sourceKey]);
  useLayoutEffect(() => {
    if (mobileReview && focusAfterTransition.current === 'review') reviewHeading.current?.focus();
    if (!mobileReview && focusAfterTransition.current === 'selection') mobileReviewTrigger.current?.focus();
    focusAfterTransition.current = null;
  }, [mobileReview]);

  function showReview() {
    focusAfterTransition.current = 'review';
    setMobileReview(true);
  }

  function showSelection() {
    focusAfterTransition.current = 'selection';
    setMobileReview(false);
  }

  const hasSelection = selection !== undefined && review !== undefined;
  return (
    <article
      className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-6 text-foreground sm:py-8"
      aria-busy={mode === 'selected' ? busy : undefined}
      data-publication-workspace
      data-publication-mode={mode}
    >
      {mode === 'selected' ? (
        <header className="space-y-3">
          {backLink}
          <PageHeading>{m.library_publication_heading()}</PageHeading>
          {sourceIdentity}
          {help ? <div className="max-w-prose text-sm leading-relaxed text-muted-foreground">{help}</div> : null}
        </header>
      ) : (
        sourceIdentity ? <header className="space-y-3">{sourceIdentity}</header> : null
      )}
      {modeNavigation}

      {mode === 'query' ? (
        <div className="min-w-0 space-y-5" data-publication-query-action>
          {queryAction}
        </div>
      ) : unavailable !== undefined ? (
        <section className="min-w-0 space-y-4" aria-labelledby="publication-source-state">
          <h2 id="publication-source-state" className="text-xl font-semibold">
            {m.library_publication_current()}
          </h2>
          {unavailable}
        </section>
      ) : hasSelection ? (
        <>
          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,24rem)]">
            <section
              id="publication-candidate-panel"
              aria-labelledby="publication-selection"
              aria-busy={busy}
              data-publication-current
              className={`min-w-0 space-y-4 ${mobileReview ? 'hidden lg:block' : 'block'}`}
            >
              <h2 id="publication-selection" className="text-xl font-semibold">
                {m.library_publication_current()}
              </h2>
              {selection}
              {continuation}
              <Button
                ref={mobileReviewTrigger}
                type="button"
                variant="outline"
                className="h-auto min-h-7 w-full whitespace-normal text-start lg:hidden"
                aria-controls="publication-review-panel"
                onClick={showReview}
              >
                {m.collection_workbench_review()}
              </Button>
            </section>
            <aside
              id="publication-review-panel"
              aria-labelledby="publication-review-heading"
              className={`min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4 lg:sticky lg:top-4 sm:p-5 ${mobileReview ? 'block' : 'hidden lg:block'}`}
              data-publication-confirmation
            >
              <h2 id="publication-review-heading" ref={reviewHeading} tabIndex={-1} className="text-lg font-semibold">
                {m.collection_workbench_review()}
              </h2>
              <Button
                type="button"
                variant="outline"
                className="h-auto min-h-7 w-full whitespace-normal text-start lg:hidden"
                aria-controls="publication-candidate-panel"
                onClick={showSelection}
              >
                {m.library_publication_choose()}
              </Button>
              {review}
            </aside>
          </div>
        </>
      ) : null}

      {result ? (
        <section
          className="min-w-0 space-y-4 rounded-2xl border border-border bg-card p-4 sm:p-5"
          aria-label={m.library_publication_output()}
          data-publication-result
        >
          {result}
        </section>
      ) : null}
      {details}
    </article>
  );
}
