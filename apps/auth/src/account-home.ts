import { flushSync } from 'react-dom';
import { useLayoutEffect, useRef, useState } from 'react';
import {
  loadAccountIdentity,
  type AccountIdentityResult,
  type AccountIdentitySource,
  type AccountIdentityState,
} from './account-identity';

const loading: AccountIdentityState = { kind: 'loading' };

/** A page-local observation. No selected account or command authority is accepted here. */
export function useAccountHomeIdentity(source: AccountIdentitySource = loadAccountIdentity) {
  const [snapshot, setSnapshot] = useState<{ source: AccountIdentitySource; state: AccountIdentityState }>({
    source,
    state: loading,
  });
  const [retryFocusVersion, setRetryFocusVersion] = useState(0);
  const restart = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    let active = true;
    let generation = 0;
    let controller: AbortController | undefined;

    const showLoading = () => setSnapshot({ source, state: loading });
    const read = (clearSynchronously = false) => {
      const requestGeneration = ++generation;
      controller?.abort();
      const request = new AbortController();
      controller = request;
      if (clearSynchronously) flushSync(showLoading);
      else showLoading();

      let pending: Promise<AccountIdentityResult>;
      try {
        pending = source(request.signal);
      } catch {
        pending = Promise.resolve({ kind: 'unavailable' });
      }
      void pending
        .catch((): AccountIdentityResult => ({ kind: 'unavailable' }))
        .then((result) => {
          if (!active || requestGeneration !== generation || request.signal.aborted) return;
          setSnapshot({ source, state: result });
        });
    };

    const restartRead = () => read();
    restart.current = restartRead;
    read();

    const onPageHide = () => {
      generation++;
      controller?.abort();
      controller = undefined;
      flushSync(showLoading);
    };
    const onPageShow = (event: Event) => {
      if ((event as PageTransitionEvent).persisted) read(true);
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      active = false;
      generation++;
      controller?.abort();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      if (restart.current === restartRead) restart.current = () => {};
    };
  }, [source]);

  return {
    state: snapshot.source === source ? snapshot.state : loading,
    retry: () => {
      setRetryFocusVersion((version) => version + 1);
      restart.current();
    },
    retryFocusVersion,
  };
}
