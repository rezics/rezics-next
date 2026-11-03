import { useCallback, useEffect, useRef } from 'react';
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';
import { useEditorLifetime } from './editor-lifetime';

type Location = { routeId: string; pathname: string; params: object; search: object };

function sameDestination(current: Location, next: Location) {
  return (
    current.routeId === next.routeId &&
    current.pathname === next.pathname &&
    JSON.stringify(current.params) === JSON.stringify(next.params) &&
    JSON.stringify(current.search) === JSON.stringify(next.search)
  );
}

/** Protect an edited catalogue companion owned by the current editor, including Publication, release and file. */
export function useCatalogueEditorNavigation(needsDecision: () => boolean) {
  const lifetime = useEditorLifetime();
  const latest = useRef(needsDecision);
  latest.current = needsDecision;
  const shouldProtect = useCallback(() => lifetime.active() && latest.current(), [lifetime]);
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      return !sameDestination(current, next) && shouldProtect();
    },
    [shouldProtect],
  );
  const blocker = useBlocker({
    shouldBlockFn,
    withResolver: true,
    enableBeforeUnload: shouldProtect,
  });
  useEffect(() => {
    if (blocker.status !== 'blocked') return;
    return () => blocker.proceed?.();
  }, [blocker.status, blocker.proceed]);
  return blocker;
}

/** Protect only an edited independent Publication owned by the current catalogue editor. */
export function usePublicationEditorNavigation(needsDecision: () => boolean) {
  return useCatalogueEditorNavigation(needsDecision);
}
