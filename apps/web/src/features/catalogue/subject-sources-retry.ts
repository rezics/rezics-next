import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { subjectReaderPartition } from '../pages/context-reader';
import { useSession } from '../../session/query';

type Intent = { scope: string; opener: Element | null; focus: boolean; dispose: () => void };
type Retry = {
  pending: boolean;
  intent?: Intent;
  listeners: Set<() => void>;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => boolean;
};
// Only this reader's retry crosses its pending/error/ready component replacements.
const retries = new WeakMap<object, Retry>();
function retryFor(router: object): Retry {
  let retry = retries.get(router);
  if (!retry) {
    retry = {
      pending: false,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener);
        return () => {
          this.listeners.delete(listener);
        };
      },
      snapshot() {
        return this.pending;
      },
    };
    retry.subscribe = retry.subscribe.bind(retry);
    retry.snapshot = retry.snapshot.bind(retry);
    retries.set(router, retry);
  }
  return retry;
}

export function useSourcesRetry({
  realm,
  reader,
  locale,
  loading,
  reset,
}: {
  realm: string | undefined;
  reader: string | null;
  locale: string;
  loading: boolean;
  reset?: () => void;
}) {
  const router = useRouter();
  const { href, busy } = useRouterState({ select: (state) => ({ href: state.location.href, busy: state.isLoading }) });
  const partition = subjectReaderPartition(realm, reader, useSession());
  const scope = JSON.stringify([href, realm, partition, locale]);
  const retry = retryFor(router);
  const pending = useSyncExternalStore(retry.subscribe, retry.snapshot, () => false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const emit = () => {
    for (const listener of retry.listeners) listener();
  };
  const retire = () => {
    retry.intent?.dispose();
    delete retry.intent;
  };

  useLayoutEffect(() => {
    const intent = retry.intent;
    if (!intent) return;
    if (intent.scope !== scope) {
      retire();
      return;
    }
    if (pending || busy || loading) return;
    retire();
    const target = headingRef.current;
    if (!intent.focus || !target?.isConnected) return;
    const active = target.ownerDocument.activeElement;
    if (active === intent.opener && intent.opener?.isConnected) return;
    if (active === intent.opener || active === target.ownerDocument.body) {
      if (intent.opener?.isConnected) (intent.opener as HTMLElement).focus();
      else target.focus();
    }
  });

  const onRetry = () => {
    if (retry.pending || busy || loading) return;
    retire();
    const document = headingRef.current?.ownerDocument;
    if (!document) return;
    const opener = document.activeElement;
    const intent: Intent = { scope, opener, focus: opener?.tagName === 'BUTTON', dispose: () => {} };
    const moved = (event: FocusEvent) => {
      if (event.target !== opener && event.target !== document.body) intent.focus = false;
    };
    const leave = router.subscribe('onBeforeNavigate', retire);
    document.addEventListener('focusin', moved);
    intent.dispose = () => {
      leave();
      document.removeEventListener('focusin', moved);
    };
    retry.intent = intent;
    retry.pending = true;
    emit();
    // Reset is the error-boundary branch; invalidate also rereads failed loaders.
    void (async () => {
      try {
        reset?.();
        await router.invalidate();
      } finally {
        retry.pending = false;
        if (!retry.listeners.size) retire();
        emit();
      }
    })();
  };
  return { headingRef, onRetry, busy: pending || busy };
}
