import { PostReadingBody } from './post-reading-body';
import { ContentItemFrame } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { useId } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { Byline } from './byline';
import { NativeDocumentImage } from './document-media';
import type { ExactRevisionIdentity, ExactRevisionState } from './exact-revision';
import { revisionDocumentImage } from './exact-revision-media';
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
  const detailsId = `revision-details-${useId().replaceAll(':', '')}`;
  if (
    page.state === 'ready' &&
    (page.revision.id !== identity.postId || page.revision.revisionId !== identity.revisionId)
  ) {
    page = { state: 'unavailable', status: 404 };
  }
  const returnHref =
    page.state === 'ready' ? threadLocation(locale, page.thread, undefined, page.revision.id) : undefined;
  return (
    <ContentItemFrame
      as="article"
      data-slot="content-item-frame"
      className="mx-auto w-full min-w-0 max-w-3xl space-y-6 text-foreground [overflow-wrap:anywhere]"
      aria-busy={page.state === 'loading'}
    >
      <header className="space-y-3">
        {page.state === 'ready' ? (
          <a
            href={returnHref}
            className="inline-flex min-h-11 max-w-full items-center rounded-sm text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {m.exact_revision_back()}
          </a>
        ) : null}
        <PageHeading>{m.exact_revision_heading()}</PageHeading>
        <p className="text-sm text-muted-foreground">{m.exact_revision_read_only()}</p>
      </header>
      {page.state === 'loading' ? <p role="status">{m.exact_revision_loading()}</p> : null}
      {page.state === 'unavailable' ? <p role="status">{m.exact_revision_unavailable()}</p> : null}
      {page.state === 'problem' ? (
        <div className="space-y-3">
          <p role="alert">{m.exact_revision_problem()}</p>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={onRetry}
            >
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
            className="[&_.truncate]:overflow-visible [&_.truncate]:text-clip [&_.truncate]:whitespace-normal"
          />
          <PostReadingBody
            key={`${page.revision.id}:${page.revision.revisionId}`}
            document={page.revision.body}
            mentions={page.mentions}
            locale={locale}
            renderImage={({ mediaId, alt }) => (
              <NativeDocumentImage
                image={revisionDocumentImage(page.documentMedia, page.revision, mediaId)}
                alt={alt}
                locale={locale}
              />
            )}
          />
          <Collapsible className="min-w-0">
            <p className="mb-1 text-xs text-muted-foreground">
              {m.thread_history_licence()}: {page.revision.licence}
            </p>
            <CollapsibleTrigger
              aria-controls={detailsId}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-auto min-h-11 min-w-11 max-w-full py-2 text-start whitespace-normal [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                />
              }
            >
              {m.thread_provenance_heading()}
            </CollapsibleTrigger>
            <CollapsibleContent id={detailsId} keepMounted className="min-w-0 space-y-4 pt-3">
              <dl className="space-y-2 text-sm [overflow-wrap:anywhere]">
                <div>
                  <dt className="font-medium">{m.exact_revision_post()}</dt>
                  <dd className="select-text">
                    <bdi dir="ltr">{identity.postId}</bdi>
                  </dd>
                </div>
                <div>
                  <dt className="font-medium">{m.exact_revision_id()}</dt>
                  <dd className="select-text">
                    <bdi dir="ltr">{identity.revisionId}</bdi>
                  </dd>
                </div>
              </dl>
              <RevisionProvenance revision={page.revision} subjects={[]} showLicence={false} />
            </CollapsibleContent>
          </Collapsible>
        </section>
      ) : null}
    </ContentItemFrame>
  );
}
