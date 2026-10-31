import { EditionTechnicalDetails, editionSubjectName, editionRevisionDate } from './edition-identity';
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
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={page.kind === 'stale' ? creatorEditionsHref() : href} />}
              >
                {page.kind === 'stale' ? m.creator_editions_restart() : m.creator_editions_retry()}
              </Button>
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
            <ul className="min-w-0 divide-y divide-border border-y border-border">
              {page.editions.map((edition) => (
                <li
                  key={edition.editionId}
                  className="grid min-w-0 gap-5 py-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] lg:gap-7"
                >
                  <div className="min-w-0 space-y-3">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="rounded-md bg-muted px-2 py-1 font-medium">
                        {edition.state === 'draft'
                          ? m.creator_editions_draft()
                          : edition.state === 'published'
                            ? m.creator_editions_published()
                            : m.creator_editions_withdrawn()}
                      </span>
                      <span className="text-muted-foreground">
                        {m.creator_editions_version({ version: edition.editionRevision })}
                      </span>
                    </p>
                    <h2
                      className="break-words text-lg font-semibold [overflow-wrap:anywhere]"
                      lang={edition.identity?.subject.label?.language}
                    >
                      {editionSubjectName(edition.identity?.subject)}
                    </h2>
                    <p className="text-sm text-muted-foreground">
                      {m.edition_identity_revision_date({
                        date: editionRevisionDate(edition.identity?.revisionCreatedAt),
                      })}
                    </p>
                    {edition.identity?.subject.kind !== 'available' && (
                      <p role="status" className="text-sm text-muted-foreground">
                        {m.edition_identity_recovery()}
                      </p>
                    )}
                    <EditionTechnicalDetails edition={edition} />
                  </div>
                  <dl className="min-w-0 space-y-3 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">{m.creator_editions_licence()}</dt>
                      <dd className="mt-1 break-words [overflow-wrap:anywhere]">{edition.licence}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-start gap-3 lg:flex-col">
                    {edition.state === 'draft' && (
                      <Button
                        variant="outline"
                        className="min-h-11"
                        nativeButton={false}
                        render={
                          <a href={localizeHref(`/editions/new?editionId=${encodeURIComponent(edition.editionId)}`)} />
                        }
                      >
                        {m.creator_editions_resume()}
                      </Button>
                    )}
                    {edition.state === 'published' && (
                      <>
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
                        <a
                          className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
                          href={localizeHref(`/editions/${encodeURIComponent(edition.editionId)}`)}
                        >
                          {m.creator_editions_read()}
                        </a>
                      </>
                    )}
                  </div>
                </li>
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
