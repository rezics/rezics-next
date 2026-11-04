import { DocumentBody } from '../document-body';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import type { ContentEditionState } from './edition-model';
import { NativeDocumentImage } from './edition-media';

export type ContentEditionReturnOrigin = {
  kind: 'order' | 'entitlement';
  href: string;
};

/** A fixed document reader has no shadcn equivalent; controls and document typography retain their shared owners. */
export function ContentEditionReader({
  editionId,
  page,
  onRetry,
  retrying = false,
  returnOrigin,
}: {
  editionId: string;
  page: ContentEditionState;
  onRetry?: () => void;
  retrying?: boolean;
  returnOrigin?: ContentEditionReturnOrigin | undefined;
}) {
  const locale = getLocale();
  if (page.state === 'published' && (page.metadata.editionId !== editionId || page.metadata.state !== 'published'))
    page = { state: 'version-mismatch', status: 502 };
  const published = page.state === 'published' ? page : null;
  const subject = published?.subject?.id === published?.metadata.targetSubjectId ? published?.subject : null;
  const creator = published?.creator?.id === published?.metadata.creatorAccountId ? published?.creator : null;
  const images = new Map(
    published?.media.kind === 'ready' ? published.media.images.map((image) => [image.id, image]) : [],
  );
  const recoverable = page.state === 'unavailable' && page.reason !== 'not-published';
  const retryable = recoverable || page.state === 'version-mismatch';
  const signIn = page.state === 'refused' && page.status === 401;
  const retry =
    retryable && onRetry ? (
      <Button
        type="button"
        variant={recoverable ? 'default' : 'outline'}
        className="min-h-11"
        disabled={retrying}
        onClick={onRetry}
      >
        {m.content_edition_retry()}
      </Button>
    ) : null;
  const returnHref = returnOrigin?.href ?? `/${locale}/orders`;
  const returnLabel = returnOrigin
    ? returnOrigin.kind === 'order'
      ? m.content_edition_return_order()
      : m.content_edition_return_entitlement()
    : m.content_edition_purchases();
  const returnContext = returnOrigin
    ? returnOrigin.kind === 'order'
      ? m.content_edition_from_order()
      : m.content_edition_from_entitlement()
    : null;
  const returnLink = (className: string) => (
    <a href={returnHref} className={className}>
      {returnLabel}
    </a>
  );
  return (
    <article
      className="mx-auto w-full max-w-3xl space-y-8 text-foreground [overflow-wrap:anywhere]"
      aria-busy={page.state === 'loading' || retrying}
    >
      <header className="space-y-3">
        <PageHeading>{subject?.label || m.content_edition_heading()}</PageHeading>
        {published ? (
          <p className="text-sm text-muted-foreground">
            {creator ? m.content_edition_creator({ name: creator.name }) : m.content_edition_creator_unknown()}
          </p>
        ) : null}
        <p className="text-sm font-medium text-muted-foreground">{m.content_edition_fixed()}</p>
        <p className="text-sm text-muted-foreground">
          <span className="font-medium">{m.content_edition_identifier()}:</span>{' '}
          <span className="break-all font-mono">{editionId}</span>
        </p>
        {returnContext ? <p className="text-sm text-muted-foreground">{returnContext}</p> : null}
        {subject ? (
          <a
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
            href={subjectHref(subject, locale).href}
          >
            {m.content_edition_subject()}
          </a>
        ) : null}
      </header>
      {page.state === 'loading' ? <p role="status">{m.content_edition_loading()}</p> : null}
      {page.state === 'unavailable' ? (
        <p role="status">
          {page.reason === 'not-published' ? m.content_edition_not_published() : m.content_edition_unavailable()}
        </p>
      ) : null}
      {page.state === 'refused' ? <p role="status">{m.content_edition_refused()}</p> : null}
      {page.state === 'withdrawn' ? <p role="status">{m.content_edition_withdrawn()}</p> : null}
      {page.state === 'version-mismatch' ? <p role="alert">{m.content_edition_version_mismatch()}</p> : null}
      {page.state !== 'published' && page.state !== 'loading' ? (
        <div className="flex flex-wrap items-center gap-3">
          {signIn ? (
            <a
              className={buttonVariants({ className: 'min-h-11' })}
              href={`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/editions/${encodeURIComponent(editionId)}`)}`}
            >
              {m.content_edition_sign_in()}
            </a>
          ) : null}
          {recoverable ? retry : null}
          {returnLink(
            buttonVariants({
              variant: signIn || (recoverable && onRetry) ? 'outline' : 'default',
              className: 'min-h-11',
            }),
          )}
          {page.state === 'version-mismatch' ? retry : null}
        </div>
      ) : null}
      {published ? (
        <>
          <DocumentBody
            document={published.body}
            locale={locale}
            renderImage={({ mediaId, alt }) => (
              <NativeDocumentImage image={images.get(mediaId) ?? null} alt={alt} locale={locale} />
            )}
          />
          <footer className="space-y-4 border-t border-border pt-6 text-sm text-muted-foreground">
            <p>{m.content_edition_attribution()}</p>
          {returnLink('inline-flex min-h-11 items-center text-primary underline underline-offset-4')}
            <dl>
              <dt className="font-medium text-foreground">{m.content_edition_licence()}</dt>
              <dd>{published.metadata.licence}</dd>
            </dl>
            <details className="space-y-4">
              <summary className="min-h-11 cursor-pointer py-3 font-medium text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                {m.content_edition_details()}
              </summary>
              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="font-medium text-foreground">{m.content_edition_revision()}</dt>
                  <dd>{published.metadata.revisionId}</dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">{m.content_edition_id()}</dt>
                  <dd>{published.metadata.editionId}</dd>
                </div>
                <div>
                  <dt className="font-medium text-foreground">{m.content_edition_metadata_version()}</dt>
                  <dd>{published.metadata.editionRevision}</dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="font-medium text-foreground">{m.content_edition_digest()}</dt>
                  <dd className="font-mono text-xs">{published.metadata.sha256}</dd>
                </div>
              </dl>
            </details>
          </footer>
        </>
      ) : null}
    </article>
  );
}

// Pages and the served route consume this same reading region; AppShell owns the one page main.
export const ContentEditionPage = ContentEditionReader;
