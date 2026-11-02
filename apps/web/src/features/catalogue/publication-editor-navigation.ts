import { useCallback, useRef } from 'react';
import { useBlocker, type ShouldBlockFn } from '@tanstack/react-router';
import { useEditorLifetime } from './editor-lifetime';

/** Protect only an edited independent Publication owned by the current catalogue editor. */
export function usePublicationEditorNavigation(needsDecision: () => boolean) {
  const lifetime = useEditorLifetime();
  const latest = useRef(needsDecision);
  latest.current = needsDecision;
  const shouldBlockFn = useCallback<ShouldBlockFn>(
    ({ current, next }) => {
      const sameDestination =
        current.pathname === next.pathname && JSON.stringify(current.search) === JSON.stringify(next.search);
      return lifetime.active() && !sameDestination && latest.current();
    },
    [lifetime],
  );
  return useBlocker({
    shouldBlockFn,
    withResolver: true,
    enableBeforeUnload: () => lifetime.active() && latest.current(),
  });
}
