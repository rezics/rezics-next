import type { MouseEvent, Ref } from 'react';
import { realmsWindowHref } from './realm-windows/address';
import type { Movement } from './realm-windows/visit';
import { Button } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { ContentItem } from '@rezics/ui/content-item';
import { m } from '../../paraglide/messages.js';
import { accountHref } from '../../subject/subject-href';
import type { PublicReadState, PublicRealms } from './read';

export function PublicAccountState({
  state,
  retry,
  page = false,
}: {
  state: PublicReadState | 'invalid-cursor';
  page?: boolean;
  retry?: (() => void) | undefined;
}) {
  const text =
    state === 'denied'
      ? m.public_account_denied()
      : state === 'preparing'
        ? m.public_account_preparing()
        : state === 'invalid-cursor'
          ? m.public_account_cursor_expired()
          : m.public_account_unavailable();
  return (
    <Empty role={state === 'unavailable' ? 'alert' : 'status'} className="p-6 sm:p-10">
      <EmptyHeader>
        <EmptyTitle>{page ? <h1>{m.public_account_heading()}</h1> : m.public_account_heading()}</EmptyTitle>
        <EmptyDescription>{text}</EmptyDescription>
      </EmptyHeader>
      {state === 'unavailable' && retry && (
        <Button variant="outline" className="min-h-11 min-w-11 whitespace-normal wrap-anywhere" onClick={retry}>
          {m.public_account_retry()}
        </Button>
      )}
    </Empty>
  );
}

/** The native view flag is independent of whether its first page happens to be empty. */
export function PublicAccountLinks({ handle, locale, realms }: { handle: string; locale: string; realms: boolean }) {
  return realms ? (
    <nav aria-label={m.public_account_more()} className="text-sm">
      <a
        href={accountHref(locale, handle, 'realms')}
        className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
      >
        {m.public_account_realms()}
      </a>
    </nav>
  ) : null;
}

export function PublicRealmsPage({
  handle,
  title,
  locale,
  result,
  retry,
  search = '',
  hash = '',
  navigation,
  regionRef,
}: {
  handle: string;
  title: string;
  locale: string;
  result: PublicRealms;
  retry?: (() => void) | undefined;
  search?: string;
  hash?: string;
  regionRef?: Ref<HTMLElement>;
  navigation?: {
    previous: string | undefined;
    hasPrevious: boolean;
    later: boolean;
    move: (movement: Movement, target: string | undefined, action: HTMLElement) => void;
  };
}) {
  const continuationHref = (cursor?: string) => realmsWindowHref(handle, locale, search, hash, cursor);
  const navigate = (movement: Movement, cursor?: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!navigation || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigation.move(movement, cursor, event.currentTarget);
  };
  const actionClass =
    'inline-flex min-h-11 min-w-11 items-center wrap-anywhere text-primary underline underline-offset-4';
  return (
    <article
      ref={regionRef}
      tabIndex={-1}
      aria-label={m.public_account_realms()}
      className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-8 sm:py-10"
    >
      <header className="min-w-0 space-y-2 wrap-anywhere">
        <a
          href={accountHref(locale, handle)}
          className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
        >
          {title}
        </a>
        <h1 className="font-sans text-3xl font-semibold tracking-tight sm:text-4xl">{m.public_account_realms()}</h1>
      </header>
      {result.state !== 'ready' ? (
        <>
          <PublicAccountState state={result.state} retry={retry} />
          {result.state === 'invalid-cursor' && (
            <a className={actionClass} href={continuationHref()} onClick={navigate('first')}>
              {m.public_account_start_again()}
            </a>
          )}
        </>
      ) : (
        <>
          {result.realms.length ? (
            <ul aria-label={m.public_account_realms()}>
              {result.realms.map((realm) => (
                <ContentItem
                  key={realm.id}
                  title={realm.title}
                  href={`/${encodeURIComponent(locale)}/realms/${encodeURIComponent(realm.id)}`}
                  metadata={realm.role === 'owner' ? m.public_account_realm_owner() : m.public_account_realm_member()}
                  preview={realm.summary ? <p className="line-clamp-3 text-muted-foreground">{realm.summary}</p> : null}
                />
              ))}
            </ul>
          ) : (
            <p role="status" className="text-muted-foreground">
              {result.next ? m.public_account_realms_more() : m.public_account_realms_empty()}
            </p>
          )}
          <nav aria-label={m.public_account_realms()} className="flex flex-wrap gap-x-6 gap-y-2">
            {navigation?.hasPrevious && (
              <a
                className={actionClass}
                href={continuationHref(navigation.previous)}
                onClick={navigate('previous', navigation.previous)}
              >
                {m.music_context_previous_page()}
              </a>
            )}
            {navigation?.later && (
              <a className={actionClass} href={continuationHref()} onClick={navigate('first')}>
                {m.public_account_start_again()}
              </a>
            )}
            {result.next && (
              <a className={actionClass} href={continuationHref(result.next)} onClick={navigate('next', result.next)}>
                {m.public_account_next()}
              </a>
            )}
          </nav>
        </>
      )}
    </article>
  );
}
