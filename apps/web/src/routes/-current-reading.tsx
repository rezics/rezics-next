import { Asset, Outlet, useRouter, useRouterState, useTags } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { isPreparingReadError } from '../session/unavailable';
import { PendingPage } from '../shell/pending';

type ReadingMatch = { status: string; isFetching?: boolean | string; _notFound?: boolean };
type ReadingRoute = { pathname: string; isLoading: boolean; matches: readonly ReadingMatch[] };

/** These default readers publish metadata and native continuation controls from their current route read. */
export function ownsCurrentPublicReading(pathname: string): boolean {
  const path = pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '');
  return (
    path === '' ||
    path === '/' ||
    /^\/(?:subjects|zones)(?:\/|$)/.test(path) ||
    /^\/@/.test(path) ||
    (/^\/collections\/[^/]+\/?$/.test(path) && path !== '/collections/new') ||
    path === '/search/list'
  );
}

/** A loader starting again withdraws the admitted reading before any replacement can complete. */
export function publicReadingWithdrawn(route: ReadingRoute): boolean {
  return (
    ownsCurrentPublicReading(route.pathname) &&
    (route.isLoading ||
      route.matches.some((match) => match.status !== 'success' || !!match.isFetching || match._notFound))
  );
}

function useWithdrawnPublicReading() {
  return useRouterState({
    select: (state) =>
      publicReadingWithdrawn({
        pathname: state.resolvedLocation?.pathname ?? state.location.pathname,
        isLoading: state.isLoading,
        matches: state.matches,
      }),
  });
}

/** Unmount old reader-owned controls and their pending work while the original loader rereads. */
export function CurrentReadingOutlet({ children }: { children?: ReactNode }) {
  const withdrawn = useWithdrawnPublicReading();
  const pending = useRouterState({
    select: (state) =>
      state.isLoading || state.matches.some((match) => match.status === 'pending' || !!match.isFetching),
  });
  // Error/not-found matches still mount their native boundary and recovery actions.
  if (withdrawn && pending) return <PendingPage />;
  return children ?? <Outlet />;
}

type Tag = ReturnType<typeof useTags>[number];

/** Infrastructure tags survive; retired titles, descriptions, cards, structured data and preloads do not. */
export function currentReadingTags(tags: readonly Tag[], withdrawn: boolean): Tag[] {
  if (!withdrawn) return [...tags];
  return tags.filter((tag) => {
    if (tag.tag === 'meta')
      return tag.attrs?.charSet !== undefined || tag.attrs?.name === 'viewport' || tag.attrs?.property === 'csp-nonce';
    if (tag.tag === 'title') return false;
    if (tag.tag === 'script') return tag.attrs?.type !== 'application/ld+json';
    if (tag.tag === 'link') return ['stylesheet', 'modulepreload', 'icon'].includes(String(tag.attrs?.rel));
    return true;
  });
}

/** Use the router's public tag/asset APIs so styles, preload policy and CSP retain their existing owner. */
export function CurrentReadingHead() {
  const tags = useTags();
  const router = useRouter();
  const withdrawn = useWithdrawnPublicReading();
  const pending = useRouterState({
    select: (state) => state.isLoading || state.matches.some((match) => !!match.isFetching),
  });
  const missing = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'notFound' || match._notFound),
  });
  const preparing = useRouterState({
    select: (state) => state.matches.some((match) => match.status === 'error' && isPreparingReadError(match.error)),
  });
  const failed = useRouterState({ select: (state) => state.matches.find((match) => match.status === 'error')?.error });
  const denied =
    failed && typeof failed === 'object' && 'status' in failed && (failed.status === 401 || failed.status === 403);
  const heading = pending
    ? m.route_loading_page()
    : missing
      ? m.not_found_heading()
      : isPlatformClosedError(failed)
        ? m.platform_closed_heading()
        : preparing
          ? m.public_read_preparing()
          : denied
            ? m.public_read_denied()
            : m.dependency_unavailable_heading();
  return (
    <>
      {currentReadingTags(tags, withdrawn).map((tag) => (
        <Asset {...tag} key={`tsr-meta-${JSON.stringify(tag)}`} nonce={router.options.ssr?.nonce} />
      ))}
      {withdrawn && (
        <>
          <title>{heading}</title>
          <meta name="robots" content="noindex" />
        </>
      )}
    </>
  );
}
