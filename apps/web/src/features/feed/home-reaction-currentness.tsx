import { useContext, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { observeReactionSession } from '../../threads/thread-reactions';
import type { FeedInput, FeedStream, HomeFeedResult } from '../pages/home-feed-read';

/** One observation for the displayed page; an old baseline cannot be rebound to a new reader or request. */
export function useHomeReactionCurrentness(
  result: HomeFeedResult,
  input: FeedInput | undefined,
  stream: FeedStream,
  signedIn: boolean,
  busy: boolean,
) {
  const client = useContext(QueryClientContext);
  const observation = useMemo(() => observeReactionSession(client), [client]);
  const revision = useSyncExternalStore(observation.subscribe, observation.snapshot, observation.serverSnapshot);
  const session = observation.read();
  const reader = session?.state === 'signed-in' ? (session.subject ?? null) : null;
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
    page?.reactionsAsOf,
  ]);
  const retired =
    busy || result.state !== 'ready' || (signedIn && !!client && (!observation.healthy() || !reader));
  const [binding, setBinding] = useState({ result, source, observation, revision, retired, visit: 0 });
  if (binding.result !== result)
    setBinding({ result, source, observation, revision, retired, visit: binding.visit + 1 });
  else if (
    !binding.retired &&
    (retired || binding.source !== source || binding.observation !== observation || binding.revision !== revision)
  )
    setBinding({ ...binding, retired: true, visit: binding.visit + 1 });
  const current = useRef(binding);
  current.current = binding;
  return {
    available: !binding.retired,
    origin: {
      key: String(binding.visit),
      reader,
      isCurrent: () =>
        current.current === binding && !binding.retired && observation.snapshot() === binding.revision,
    },
  };
}
