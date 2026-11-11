import { useEffect, useId, useState } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { ExactVersionDetails } from './revisions';
import { bookTocRows } from './book-toc';
import type { StudioController, StudioState } from './controller';

export function StudioPublication({ controller, state }: { controller: StudioController; state: StudioState }) {
  const review = state.review;
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const confirmationId = useId();
  useEffect(() => {
    setConfirmed(false);
    setNow(Date.now());
    if (!review) return;
    const delay = Math.max(0, Date.parse(review.expiresAt) - Date.now());
    // One local expiry timer, without network polling or background work.
    const timer = window.setTimeout(() => { setNow(Date.now()); setConfirmed(false); }, Math.min(delay, 2147483647));
    return () => window.clearTimeout(timer);
  }, [review]);
  const expired = review ? Date.parse(review.expiresAt) <= now : false;
  const selected = state.selected;
  const unresolved = controller.hasUnresolvedCommand();
  const blocked = Boolean(state.busy) || unresolved;
  const unsaved = selected?.dirty || selected?.snapshotPending || selected?.invalid || selected?.uploading;
  const book = Boolean(state.structure);
  let hasTarget = false;
  try { hasTarget = Boolean(controller.publicationTarget()); } catch { /* The organizer presents an invalid structure. */ }
  if (controller.input.publicationUnavailableReason) return <section className="studio-stack" aria-label="Publication">
    <h2>Publish</h2><p>{controller.input.publicationUnavailableReason}</p>
  </section>;
  return <section className="studio-stack" aria-label="Publication">
    <div className="studio-section-heading"><h2>Publish</h2>
      {book ? <span>{state.selectedOccurrences.size} chapters selected</span> : null}
    </div>
    <p className="studio-help">{book
      ? 'Publish a frozen snapshot of the selected table of contents and pinned chapter versions. Unselected chapters stay outside this release.'
      : 'Publish the reviewed saved article version. New edits continue as a private draft.'}</p>
    {!controller.input.canPublish ? <p>Publishing is unavailable for this visit. You can continue drafting with your available permissions.</p> : null}
    {unsaved ? <p>Save the current draft before reviewing publication.</p> : null}
    {book && !hasTarget ? <p>Select chapters in the table of contents to prepare a release.</p> : null}
    {review ? <div className="studio-release-review" aria-label="Review before publishing">
      <h3>Review this release</h3>
      <p>{review.expectedPublicationRevision ? 'This advances the published snapshot.' : 'This creates the first published snapshot.'}</p>
      {review.target.kind === 'book' ? <p className="studio-break">Structure revision: {review.target.structureRevision}</p> : null}
      {review.bookOutline ? <nav aria-label="Frozen release table of contents">
        <ol className="studio-review-entries">
          {bookTocRows({ ...review.bookOutline, canOrganize: false }).map(({ placement, depth }) => <li
            key={placement.occurrenceId} style={{ marginInlineStart: `${Math.min(depth, 8) * .75}rem` }}>
            {placement.target.kind === 'part' ? <strong>{placement.title}</strong> : <span>{placement.title}</span>}
          </li>)}
        </ol>
      </nav> : null}
      <ol className="studio-review-entries">
        {review.entries.map((entry) => <li key={entry.occurrenceId ?? entry.document.postId}>
          <strong>{entry.title}</strong><ExactVersionDetails exact={entry.document} />
        </li>)}
      </ol>
      {review.notices.map((notice, index) => <p key={index}>{notice}</p>)}
      <p className="studio-help">Review expires <time dateTime={review.expiresAt}>{review.expiresAt}</time>.</p>
      {expired ? <p role="status">The review expired. Prepare a fresh review.</p> : null}
      <label className="studio-confirm" htmlFor={confirmationId}>
        <input id={confirmationId} type="checkbox" checked={confirmed} disabled={blocked || expired}
          onChange={(event) => setConfirmed(event.target.checked)} />
        <span>I have reviewed these exact versions and want to publish this release.</span>
      </label>
      <div className="studio-action-row">
        <Button type="button" disabled={!confirmed || blocked || expired || Boolean(unsaved)} onClick={() => void controller.publish()}>
          Publish reviewed {book ? 'chapters' : 'article'}
        </Button>
        <Button type="button" variant="outline" disabled={blocked} onClick={controller.cancelReview}>Cancel review</Button>
      </div>
    </div> : null}
    <Button type="button" variant={review ? 'outline' : 'default'} disabled={blocked || !hasTarget || Boolean(unsaved) || !controller.input.canPublish}
      onClick={() => void controller.reviewPublication()}>{review ? 'Refresh publication review' : 'Review publication…'}</Button>
    {state.published ? <p role="status">Published snapshot {state.published.revision}. Future draft changes do not change this release.</p> : null}
    <details className="studio-publication-history">
      <summary>Publication history</summary>
      {state.publications.items.length ? <ol className="studio-history-list">
        {state.publications.items.map((publication) => <li key={`${publication.publicationId}:${publication.revision}`}>
          <h3>{publication.state === 'withdrawn' ? 'Withdrawn snapshot' : 'Published snapshot'}</h3>
          <p><time dateTime={publication.publishedAt}>{publication.publishedAt}</time> · {publication.entries.length} {book ? 'chapters' : 'articles'}</p>
          <p className="studio-break">Revision: {publication.revision}</p>
          <details><summary>Included versions</summary>
            <ol>{publication.entries.map((entry) => <li key={entry.occurrenceId ?? entry.document.postId}>
              {entry.title}<ExactVersionDetails exact={entry.document} />
            </li>)}</ol>
          </details>
        </li>)}
      </ol> : <p>No publication history on this page.</p>}
      {state.publications.nextCursor ? <Button type="button" variant="outline" disabled={blocked}
        onClick={() => void controller.loadPublications()}>Next publications</Button> : null}
    </details>
  </section>;
}
