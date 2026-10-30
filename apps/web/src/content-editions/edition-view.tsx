import { DocumentBody } from '../document-body';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { subjectHref } from '../subject/subject-href';
import type { ContentEditionState } from './edition-model';
import { NativeDocumentImage } from './edition-media';

/** A fixed document reader has no shadcn equivalent; controls and document typography retain their shared owners. */
export function ContentEditionReader({
  editionId,
  page,
  onRetry,
}: {
  editionId: string;
  page: ContentEditionState;
  onRetry?: () => void;
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
  const retryable = page.state !== 'published' && page.state !== 'loading';
  return (
    <article
      className="mx-auto w-full max-w-3xl space-y-8 text-foreground [overflow-wrap:anywhere]"
      aria-busy={page.state === 'loading'}
    >
      <header className="space-y-3">
        {subject ? (
          <a
            className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
            href={subjectHref(subject, locale).href}
          >
            {m.content_edition_subject()}
          </a>
        ) : null}
        <p className="text-sm font-medium text-muted-foreground">{m.content_edition_fixed()}</p>
        <PageHeading>{subject?.label || m.content_edition_heading()}</PageHeading>
        {creator ? (
          <p className="text-sm text-muted-foreground">{m.content_edition_creator({ name: creator.name })}</p>
        ) : null}
      </header>
      {page.state === 'loading' ? <p role="status">{m.content_edition_loading()}</p> : null}
      {page.state === 'unavailable' ? <p role="status">{m.content_edition_unavailable()}</p> : null}
      {page.state === 'refused' ? (
        <div className="space-y-3">
          <p role="status">{m.content_edition_refused()}</p>
          {page.status === 401 ? (
            <a
              className="inline-flex min-h-11 items-center underline underline-offset-4"
              href={`/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/editions/${encodeURIComponent(editionId)}`)}`}
            >
              {m.content_edition_sign_in()}
            </a>
          ) : null}
        </div>
      ) : null}
      {page.state === 'withdrawn' ? <p role="status">{m.content_edition_withdrawn()}</p> : null}
      {page.state === 'version-mismatch' ? <p role="alert">{m.content_edition_version_mismatch()}</p> : null}
      {retryable && onRetry ? (
        <Button type="button" variant="outline" onClick={onRetry}>
          {m.content_edition_retry()}
        </Button>
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
            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="font-medium text-foreground">{m.content_edition_licence()}</dt>
                <dd>{published.metadata.licence}</dd>
              </div>
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
          </footer>
        </>
      ) : null}
    </article>
  );
}

// Pages and the served route consume this same reading region; AppShell owns the one page main.
export const ContentEditionPage = ContentEditionReader;
