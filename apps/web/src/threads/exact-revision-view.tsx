import { DocumentBody } from '../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { Byline } from './byline';
import type { ExactRevisionIdentity, ExactRevisionState } from './exact-revision';
import { RevisionProvenance } from './revision-provenance-view';
import { threadLocation } from './thread-href';

/** Immutable document reading region; shadcn provides controls, but no revision/provenance reader. */
export function ExactRevisionView({
  identity,
  page,
  onRetry,
}: {
  identity: ExactRevisionIdentity;
  page: ExactRevisionState;
  onRetry?: () => void;
}) {
  const locale = getLocale();
  if (
    page.state === 'ready' &&
    (page.revision.id !== identity.postId || page.revision.revisionId !== identity.revisionId)
  ) {
    page = { state: 'unavailable', status: 404 };
  }
  return (
    <article className="w-full max-w-3xl space-y-6 text-foreground" aria-busy={page.state === 'loading'}>
      <header className="space-y-3">
        {page.state === 'ready' ? (
          <a
            href={`${threadLocation(locale, page.thread)}#post-${encodeURIComponent(page.revision.id)}`}
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
          >
            {m.exact_revision_back()}
          </a>
        ) : null}
        <PageHeading>{m.exact_revision_heading()}</PageHeading>
        <p className="text-sm text-muted-foreground">{m.exact_revision_read_only()}</p>
        <dl className="space-y-2 text-sm [overflow-wrap:anywhere]">
          <div>
            <dt className="font-medium">{m.exact_revision_post()}</dt>
            <dd>{identity.postId}</dd>
          </div>
          <div>
            <dt className="font-medium">{m.exact_revision_id()}</dt>
            <dd>{identity.revisionId}</dd>
          </div>
        </dl>
      </header>
      {page.state === 'loading' ? <p role="status">{m.exact_revision_loading()}</p> : null}
      {page.state === 'unavailable' ? <p role="status">{m.exact_revision_unavailable()}</p> : null}
      {page.state === 'problem' ? (
        <div className="space-y-3">
          <p role="alert">{m.exact_revision_problem()}</p>
          {onRetry ? (
            <Button type="button" variant="outline" onClick={onRetry}>
              {m.exact_revision_retry()}
            </Button>
          ) : null}
        </div>
      ) : null}
      {page.state === 'ready' ? (
        <section className="min-w-0 space-y-5" aria-label={m.exact_revision_heading()}>
          {page.thread.differentHead ? (
            <p className="text-sm text-muted-foreground">{m.exact_revision_different_head()}</p>
          ) : null}
          <Byline
            author={page.authors?.[page.revision.authorId]}
            createdAt={page.revision.revisedAt ?? page.revision.createdAt}
            now={page.now}
          />
          <RevisionProvenance revision={page.revision} subjects={[]} />
          <DocumentBody document={page.revision.body} mentions={page.mentions} locale={locale} />
        </section>
      ) : null}
    </article>
  );
}
