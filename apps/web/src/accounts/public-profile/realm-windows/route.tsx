import { useLayoutEffect, useRef } from 'react';
import { useLocation, useRouter } from '@tanstack/react-router';
import { PublicAccountState, PublicRealmsPage } from '../view';
import type { PublicRealms, PublicReadState } from '../read';
import { realmsWindowHref } from './address';
import { realmsVisit, type Movement } from './visit';

export type RealmsRouteSource =
  | {
      kind: 'page';
      page: { account?: { id: string; handle: string } | null };
      title: string;
      realms?: PublicRealms;
      publicRealms: boolean;
    }
  | { kind: 'state'; state: PublicReadState };

/** Loader data is the replacing native page. No query observer retains earlier Realm projections. */
export function PublicRealmsRoute({
  source,
  locale,
  cursor,
}: {
  source: RealmsRouteSource;
  locale: string;
  cursor?: string;
}) {
  const router = useRouter();
  useLocation();
  const { search: searchStr, hash } = router.history.location;
  const visit = realmsVisit(router);
  const region = useRef<HTMLElement>(null);
  const account = source.kind === 'page' ? source.page.account : undefined;
  const published = source.kind === 'page' && source.publicRealms;
  const result = source.kind === 'page' ? source.realms : undefined;
  const binding = account && published ? JSON.stringify([account.id, locale, 'realms']) : undefined;
  // Failed composition reads have no new identity to admit. They can only retry the pending target.
  const transfer = visit.accept(
    source,
    source.kind === 'state' ? visit.binding : binding,
    cursor,
    published && result?.state === 'ready',
  );
  useLayoutEffect(() => {
    visit.mounts++;
    return () => {
      visit.mounts--;
      // A cursor remount hands the same visit to its successor in this commit.
      queueMicrotask(() => {
        if (!visit.mounts && !visit.pending?.loading) visit.retire();
      });
    };
  }, [visit]);
  useLayoutEffect(() => {
    if (transfer && visit.active) region.current?.focus();
  }, [source, transfer, visit]);
  const revision = visit.revision;
  const current = () =>
    visit.revision === revision && visit.active && visit.source?.deref() === source && !visit.pending?.loading;
  const move = (movement: Movement, target: string | undefined, href: string, action?: HTMLElement) => {
    if (!current()) return;
    visit.start(target, movement, href, action);
    router.history.push(href);
  };
  const retry = () => {
    if (!current()) return;
    const pending = visit.pending;
    if (pending) {
      visit.start(pending.target, pending.movement, pending.href);
      void router.invalidate();
    } else void router.invalidate();
  };
  if (source.kind === 'state') return <PublicAccountState page state={source.state} retry={retry} />;
  return (
    <PublicRealmsPage
      handle={account!.handle}
      title={source.title}
      locale={locale}
      result={published ? (result ?? { state: 'unavailable' }) : { state: 'denied' }}
      search={searchStr}
      hash={hash}
      retry={retry}
      regionRef={region}
      navigation={{
        previous: visit.coordinates.length > 1 ? visit.coordinates[visit.coordinates.length - 2] : undefined,
        hasPrevious: visit.coordinates.length > 1,
        later: cursor !== undefined && result?.state === 'ready' && published,
        move: (movement, target, action) =>
          move(movement, target, realmsWindowHref(account!.handle, locale, searchStr, hash, target), action),
      }}
    />
  );
}
