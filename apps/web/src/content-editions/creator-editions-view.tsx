import { EditionTechnicalDetails, editionSubjectName, editionRevisionDate } from './edition-identity';
import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorEditionsPage } from './creator-editions';

export function creatorEditionsHref(cursor?: string): string {
  return localizeHref(`/editions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
}

export function CreatorEditionsView({ page, cursor }: { page: CreatorEditionsPage; cursor?: string }) {
  const href = creatorEditionsHref(cursor);
  const notice =
    page.kind === 'sign-in'
      ? m.creator_editions_sign_in_help()
      : page.kind === 'denied'
        ? m.creator_editions_denied()
        : page.kind === 'loading'
          ? m.creator_editions_loading()
          : page.kind === 'stale'
            ? m.creator_editions_stale()
            : m.creator_editions_unavailable();
  return (
    <section className="w-full min-w-0 space-y-7 text-foreground" aria-labelledby="creator-editions-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <PageHeading id="creator-editions-heading">{m.creator_editions_heading()}</PageHeading>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.creator_editions_intro()}</p>
        </div>
        <Button className="min-h-11" nativeButton={false} render={<a href={localizeHref('/editions/new')} />}>
          {m.creator_editions_create()}
        </Button>
      </div>
      {page.kind !== 'ready' ? (
        <div className="space-y-4 border-y border-border py-8" role={page.kind === 'loading' ? 'status' : 'alert'}>
          <p className="max-w-prose text-sm leading-relaxed">{notice}</p>
          {page.kind === 'sign-in' ? (
            <Button
              variant="outline"
              className="min-h-11"
              nativeButton={false}
              render={<a href={`/auth/sign-in?return_to=${encodeURIComponent(href)}`} />}
            >
              {m.creator_editions_sign_in()}
            </Button>
          ) : (
            page.kind !== 'loading' && (
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="outline"
                  className="min-h-11"
                  nativeButton={false}
                  render={<a href={page.kind === 'stale' ? creatorEditionsHref() : href} />}
                >
                  {page.kind === 'stale' ? m.creator_editions_restart() : m.creator_editions_retry()}
                </Button>
                {page.kind === 'unavailable' && cursor && (
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    nativeButton={false}
                    render={<a href={creatorEditionsHref()} />}
                  >
                    {m.creator_editions_restart()}
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      ) : (
        <>
          {page.editions.length === 0 ? (
            <p role="status" className="border-y border-border py-8 text-sm text-muted-foreground">
              {page.next
                ? m.creator_editions_sparse()
                : cursor
                  ? m.creator_editions_page_empty()
                  : m.creator_editions_empty()}
            </p>
          ) : (
            <ul className="min-w-0 space-y-2">
              {page.editions.map((edition) => (
                <ContentItem
                  key={edition.editionId}
                  headingLevel={2}
                  title={editionSubjectName(edition.identity?.subject)}
                  {...(edition.identity?.subject.label ? { titleLang: edition.identity.subject.label.language } : {})}
                  {...(edition.state === 'published'
                    ? { href: localizeHref(`/editions/${encodeURIComponent(edition.editionId)}`) }
                    : {})}
                  state={
                    <span className="rounded-md bg-muted px-2 py-1 text-sm font-medium">
                      {edition.state === 'draft'
                        ? m.creator_editions_draft()
                        : edition.state === 'published'
                          ? m.creator_editions_published()
                          : m.creator_editions_withdrawn()}
                    </span>
                  }
                  metadata={
                    <div className="min-w-0 space-y-3">
                      <p>{m.creator_editions_version({ version: edition.editionRevision })}</p>
                      <p>
                        {m.edition_identity_revision_date({
                          date: editionRevisionDate(edition.identity?.revisionCreatedAt),
                        })}
                      </p>
                      {edition.identity?.subject.kind !== 'available' && (
                        <p role="status">{m.edition_identity_recovery()}</p>
                      )}
                      <dl>
                        <div>
                          <dt className="text-xs text-muted-foreground">{m.creator_editions_licence()}</dt>
                          <dd className="mt-1 break-words text-foreground [overflow-wrap:anywhere]">
                            {edition.licence}
                          </dd>
                        </div>
                      </dl>
                      <EditionTechnicalDetails edition={edition} />
                    </div>
                  }
                  actions={
                    edition.state !== 'withdrawn' && (
                      <>
                        {edition.state === 'draft' && (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            nativeButton={false}
                            render={
                              <a
                                href={localizeHref(`/editions/new?editionId=${encodeURIComponent(edition.editionId)}`)}
                              />
                            }
                          >
                            {m.creator_editions_resume()}
                          </Button>
                        )}
                        {edition.state === 'published' && (
                          <Button
                            variant="outline"
                            className="min-h-11"
                            nativeButton={false}
                            render={
                              <a
                                href={localizeHref(
                                  `/creator/offers/new?editionId=${encodeURIComponent(edition.editionId)}`,
                                )}
                              />
                            }
                          >
                            {m.creator_editions_offer()}
                          </Button>
                        )}
                      </>
                    )
                  }
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
              {m.creator_editions_permissions()}
            </p>
            <nav className="flex flex-wrap gap-3" aria-label={m.creator_editions_pagination()}>
              {cursor && (
                <Button
                  variant="ghost"
                  className="min-h-11"
                  nativeButton={false}
                  render={<a href={creatorEditionsHref()} />}
                >
                  {m.creator_editions_restart()}
                </Button>
              )}
              <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
                {m.creator_editions_refresh()}
              </Button>
              {page.next && (
                <Button className="min-h-11" nativeButton={false} render={<a href={creatorEditionsHref(page.next)} />}>
                  {m.creator_editions_next()}
                </Button>
              )}
            </nav>
          </div>
        </>
      )}
    </section>
  );
}
