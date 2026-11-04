import { useContext, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { browserObservation, type BrowserObservationSnapshot } from '../../session/observation';
import { observeReactionSession } from '../../threads/thread-reactions';
import type { FeedInput, FeedStream, HomeFeedResult } from '../pages/home-feed-read';

const admittedPages = new WeakSet<object>();
const noBrowserSnapshot: BrowserObservationSnapshot = { state: 'unknown' };
const noSubscribe = () => () => {};
const getNoSnapshot = () => noBrowserSnapshot;

/** One observation for the displayed page; an old baseline cannot be rebound to a new reader or request. */
export function useHomeReactionCurrentness(
  result: HomeFeedResult,
  input: FeedInput | undefined,
  stream: FeedStream,
  signedIn: boolean,
  busy: boolean,
) {
  const client = useContext(QueryClientContext);
  const session = useMemo(() => observeReactionSession(client), [client]);
  const revision = useSyncExternalStore(session.subscribe, session.snapshot, session.serverSnapshot);
  const observation = useMemo(() => (client ? browserObservation(client) : undefined), [client]);
  const browser = useSyncExternalStore(
    observation?.subscribe ?? noSubscribe,
    observation?.getSnapshot ?? getNoSnapshot,
    observation?.getServerSnapshot ?? getNoSnapshot,
  );
  const sessionValue = session.read();
  const reader = browser.state === 'signed-in' ? browser.observation.subject : null;
  const sessionIdentity = () => {
    const current = session.read();
    return JSON.stringify([
      session.healthy(),
      current?.state ?? null,
      current?.subject ?? null,
      current?.csrfToken ?? null,
    ]);
  };
  const identity = sessionIdentity();
  const page = result.state === 'ready' ? result.page : undefined;
  const source = JSON.stringify([
    stream,
    input?.stream,
    input?.cursor,
    input?.kind,
    input?.spaceId,
    input?.ratingQuestionId,
    signedIn,
    page?.sources,
  ]);
  const awaitingBrowserObservation = !!client && (browser.state === 'unknown' || browser.state === 'inactive');
  const invalidSession =
    signedIn &&
    !!client &&
    (!session.healthy() ||
      sessionValue?.state !== 'signed-in' ||
      !sessionValue.subject ||
      !sessionValue.csrfToken ||
      (!awaitingBrowserObservation &&
        (browser.state !== 'signed-in' || browser.observation.subject !== sessionValue.subject)));
  const sessionState = client?.getQueryState(['session']);
  const changingSession = !!client && (sessionState?.fetchStatus !== 'idle' || sessionState?.isInvalidated === true);
  const unavailable = busy || result.state !== 'ready' || invalidSession || changingSession;

  const [binding, setBinding] = useState(() => {
    const alreadyAdmitted = !!page && admittedPages.has(page);
    const pending = !!page && awaitingBrowserObservation && !unavailable && !alreadyAdmitted;
    return {
      page,
      source,
      client,
      browser,
      revision,
      identity,
      retired: unavailable || alreadyAdmitted,
      pending,
      visit: 0,
    };
  });

  if (binding.page !== page) {
    const alreadyAdmitted = !!page && admittedPages.has(page);
    const pending = !!page && awaitingBrowserObservation && !unavailable && !alreadyAdmitted;
    setBinding({
      page,
      source,
      client,
      browser,
      revision,
      identity,
      retired: unavailable || alreadyAdmitted,
      pending,
      visit: binding.visit + 1,
    });
  } else if (binding.pending) {
    if (unavailable || binding.client !== client || binding.source !== source) {
      setBinding({ ...binding, retired: true, pending: false, visit: binding.visit + 1 });
    } else if (awaitingBrowserObservation) {
      if (binding.browser !== browser || binding.revision !== revision || binding.identity !== identity)
        setBinding({ ...binding, browser, revision, identity });
    } else if (page && !admittedPages.has(page)) {
      setBinding({ ...binding, browser, revision, identity, pending: false });
    } else {
      setBinding({ ...binding, retired: true, pending: false, visit: binding.visit + 1 });
    }
  } else if (
    !binding.retired &&
    (unavailable ||
      binding.client !== client ||
      binding.source !== source ||
      binding.browser !== browser ||
      binding.revision !== revision ||
      binding.identity !== identity)
  ) {
    setBinding({ ...binding, retired: true, pending: false, visit: binding.visit + 1 });
  }

  const current = useRef<typeof binding | null>(binding);
  current.current = binding;
  const available =
    !binding.retired &&
    !binding.pending &&
    !unavailable &&
    binding.page === page &&
    binding.source === source &&
    binding.client === client &&
    binding.browser === browser &&
    binding.revision === revision &&
    binding.identity === identity;

  useLayoutEffect(() => {
    current.current = binding;
    if (binding.page && !binding.pending) admittedPages.add(binding.page);
    return () => {
      if (binding.page && !binding.pending) admittedPages.add(binding.page);
      if (current.current === binding) current.current = null;
    };
  }, [binding]);

  return {
    available,
    retire: () => {
      if (current.current !== binding || binding.retired) return;
      current.current = null;
      setBinding({ ...binding, retired: true, pending: false, visit: binding.visit + 1 });
    },
    origin: {
      key: String(binding.visit),
      reader,
      isCurrent: () => {
        const currentSession = session.read();
        const currentBrowser = observation?.getSnapshot() ?? noBrowserSnapshot;
        const currentIdentity = JSON.stringify([
          session.healthy(),
          currentSession?.state ?? null,
          currentSession?.subject ?? null,
          currentSession?.csrfToken ?? null,
        ]);
        return (
          current.current === binding &&
          !binding.retired &&
          !binding.pending &&
          !unavailable &&
          binding.page === page &&
          binding.source === source &&
          binding.client === client &&
          binding.browser === currentBrowser &&
          session.snapshot() === binding.revision &&
          currentIdentity === binding.identity &&
          (!signedIn ||
            !client ||
            (session.healthy() &&
              currentSession?.state === 'signed-in' &&
              !!currentSession.subject &&
              !!currentSession.csrfToken &&
              currentBrowser.state === 'signed-in' &&
              currentBrowser.observation.subject === currentSession.subject))
        );
      },
    },
  };
}
