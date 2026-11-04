import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { EditionTechnicalDetails, editionSubjectName, editionRevisionDate } from './edition-identity';
import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { localizeHref } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorEditionsPage } from './creator-editions';
import { useSession } from '../session/query';
import {
  addCreatorEditionOriginToken,
  createCreatorEditionOrigin,
  creatorEditionOriginTokenFromSearch,
  readCreatorEditionOrigin,
  restartCreatorEditionOrigin,
  retireCreatorEditionOrigin,
  type CreatorEditionOriginResolution,
} from './creator-edition-origin';
import { CreatorEditionOriginPanel } from './creator-edition-origin-panel';

export function creatorEditionsHref(cursor?: string): string {
  return localizeHref(`/editions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
}

const inventoryBoundaryId = 'creator-editions-inventory';

/** Native document navigation hands focus to an admitted page, including without hydration. */
export function creatorEditionsContinuationHref(cursor?: string): string {
  return `${creatorEditionsHref(cursor)}#${inventoryBoundaryId}`;
}

export function CreatorEditionsOriginView({ page, cursor }: { page: CreatorEditionsPage; cursor?: string }) {
  const router = useRouter();
  const locationSearch = useLocation({ select: (location) => location.search });
  const originToken = creatorEditionOriginTokenFromSearch(locationSearch);
  const session = useSession();
  const [origin, setOrigin] = useState<CreatorEditionOriginResolution | null>(null);
  const [returnedEdition, setReturnedEdition] = useState<'checking' | 'present' | 'missing' | undefined>();
  const preserveOriginOnLeave = useRef(false);
  const priorCredential = useRef<string | null>(null);
  const sawCredential = useRef(false);
  useEffect(
    () => () => {
      if (!preserveOriginOnLeave.current) retireCreatorEditionOrigin(originToken);
    },
    [originToken],
  );
  useEffect(() => {
    if (!originToken) {
      setOrigin(null);
      setReturnedEdition(undefined);
      return;
    }
    if (session.state === 'unknown') return;
    const resolution = readCreatorEditionOrigin(originToken, session.subject);
    if (resolution.kind === 'current' && resolution.receipt.cursor !== (cursor ?? null)) {
      retireCreatorEditionOrigin(originToken);
      setOrigin({ kind: 'lost', reason: 'replaced' });
      setReturnedEdition(undefined);
      return;
    }
    setOrigin(resolution);
    setReturnedEdition(resolution.kind === 'current' && page.kind === 'loading' ? 'checking' : undefined);
  }, [cursor, originToken, page.kind, session.state, session.subject]);

  useEffect(() => {
    if (!sawCredential.current) {
      if (session.csrfToken) {
        priorCredential.current = session.csrfToken;
        sawCredential.current = true;
      }
      return;
    }
    if (priorCredential.current !== session.csrfToken) {
      priorCredential.current = session.csrfToken;
      retireCreatorEditionOrigin(originToken);
      if (originToken) setOrigin({ kind: 'lost', reason: 'account' });
      setReturnedEdition(undefined);
    }
  }, [originToken, session.csrfToken]);

  useEffect(() => {
    if (origin?.kind !== 'current') {
      setReturnedEdition(undefined);
      return;
    }
    if (page.kind === 'loading') {
      setReturnedEdition('checking');
      return;
    }
    if (page.kind !== 'ready' || !origin.receipt.editionId) {
      setReturnedEdition(undefined);
      return;
    }
    const edition = page.editions.find((item) => item.editionId === origin.receipt.editionId);
    if (!edition) {
      setReturnedEdition('missing');
      return;
    }
    setReturnedEdition('present');
    const row = document.getElementById(`creator-edition-${origin.receipt.editionId}`);
    row?.focus();
  }, [origin, page]);

  function navigateFromInventory(event: MouseEvent<HTMLElement>) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest('a');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (anchor.target && anchor.target !== '_self') return;
    const destination = new URL(anchor.href, window.location.href);
    if (destination.origin !== window.location.origin) return;
    const path = destination.pathname;
    const isAuthoring = path.endsWith('/editions/new') || path.endsWith('/creator/offers/new');
    if (isAuthoring && session.subject && page.kind === 'ready') {
      const editionId = destination.searchParams.get('editionId');
      const token = createCreatorEditionOrigin({ accountId: session.subject, cursor: cursor ?? null, editionId });
      if (!token) return;
      preserveOriginOnLeave.current = true;
      event.preventDefault();
      const canonical = anchor.getAttribute('href') ?? destination.pathname + destination.search;
      void router.navigate({ href: addCreatorEditionOriginToken(canonical, token) });
      return;
    }
    if (originToken && origin?.kind === 'current') {
      const current = readCreatorEditionOrigin(originToken, session.subject);
      if (current.kind !== 'current' || current.receipt.cursor !== (cursor ?? null)) {
        retireCreatorEditionOrigin(originToken);
        setOrigin({ kind: 'lost', reason: current.kind === 'current' ? 'replaced' : current.reason });
        return;
      }
      const sameAddress = path.endsWith('/editions') && destination.searchParams.get('cursor') === (cursor ?? null);
      if (anchor.hasAttribute('data-creator-origin-restart')) {
        const receipt = restartCreatorEditionOrigin(current.receipt.token);
        if (receipt) {
          preserveOriginOnLeave.current = true;
          event.preventDefault();
          void router.navigate({ href: addCreatorEditionOriginToken(anchor.getAttribute('href') ?? creatorEditionsHref(), originToken) });
          return;
        }
      }
      if (sameAddress) {
        preserveOriginOnLeave.current = true;
        event.preventDefault();
        void router.navigate({ href: addCreatorEditionOriginToken(anchor.getAttribute('href') ?? href, originToken) });
        return;
      }
      // A new page or a changed cursor is a new inventory occurrence. Do not carry
      // the old focus target forward as if it had been admitted there.
      retireCreatorEditionOrigin(originToken);
    }
  }

  function restartInventory() {
    if (!originToken || origin?.kind !== 'current') {
      void router.navigate({ href: creatorEditionsContinuationHref() });
      return;
    }
    const current = readCreatorEditionOrigin(originToken, session.subject);
    const receipt =
      current.kind === 'current' && current.receipt.cursor === (cursor ?? null)
        ? restartCreatorEditionOrigin(originToken)
        : null;
    if (!receipt) {
      void router.navigate({ href: creatorEditionsContinuationHref() });
      return;
    }
    preserveOriginOnLeave.current = true;
    void router.navigate({ href: addCreatorEditionOriginToken(creatorEditionsContinuationHref(), originToken) });
  }

  return (
    <div onClickCapture={navigateFromInventory}>
      {origin ? (
        <CreatorEditionOriginPanel
          resolution={origin}
          occurrence={returnedEdition}
          onRestart={restartInventory}
          editionId={origin.kind === 'current' ? origin.receipt.editionId : undefined}
        />
      ) : null}
      <CreatorEditionsView page={page} cursor={cursor} />
    </div>
  );
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
    <section
      id={page.kind === 'ready' ? inventoryBoundaryId : undefined}
      tabIndex={page.kind === 'ready' ? -1 : undefined}
      className="w-full min-w-0 scroll-mt-24 space-y-7 text-foreground"
      aria-labelledby="creator-editions-heading"
      aria-describedby={page.kind === 'ready' && page.editions.length === 0 ? 'creator-editions-empty' : undefined}
    >
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
                  render={
                    <a
                      href={page.kind === 'stale' ? creatorEditionsContinuationHref() : href}
                      data-creator-origin-restart={page.kind === 'stale' ? '' : undefined}
                    />
                  }
                >
                  {page.kind === 'stale' ? m.creator_editions_restart() : m.creator_editions_retry()}
                </Button>
                {page.kind === 'unavailable' && cursor && (
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    nativeButton={false}
                    render={<a href={creatorEditionsContinuationHref()} data-creator-origin-restart="" />}
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
            <p
              id="creator-editions-empty"
              role="status"
              className="border-y border-border py-8 text-sm text-muted-foreground"
            >
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
                  id={`creator-edition-${edition.editionId}`}
                  tabIndex={-1}
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
                  render={<a href={creatorEditionsContinuationHref()} data-creator-origin-restart="" />}
                >
                  {m.creator_editions_restart()}
                </Button>
              )}
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<a href={href} data-creator-origin-retry="" />}
              >
                {m.creator_editions_refresh()}
              </Button>
              {page.next && (
                <Button
                  className="min-h-11"
                  nativeButton={false}
                  render={<a href={creatorEditionsContinuationHref(page.next)} />}
                >
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
