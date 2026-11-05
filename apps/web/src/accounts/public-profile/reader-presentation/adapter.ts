import { useQuery } from '@tanstack/react-query';
import { useAgentReaderResult, useAgentReaderScope, type AgentReaderPath } from '../../../features/pages/agent-reader';
import { agentReaderQuery } from '../../../features/pages/agent-queries';
import { useSession } from '../../../session/query';
import type { Reader } from '../../../subject/reader';

export type ProfileReadingState =
  | 'conservative'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'rejected'
  | 'signed-out'
  | 'closed'
  | 'preparing'
  | 'retired';
export type ProfileReading = {
  state: ProfileReadingState;
  reader: Reader;
  /** Local disclosure state belongs to this response, independent of public row identity. */
  response: string;
  retry?: () => void;
};

/** The overview and named views use exactly the same private preference admission. */
export function useProfileReading(input: {
  handle: string;
  locale: string;
  path: AgentReaderPath;
  enabled: boolean;
  owner: unknown;
}): ProfileReading {
  const session = useSession();
  const scope = useAgentReaderScope({ ...input, session });
  const query = useQuery(agentReaderQuery(input.handle, input.locale, scope));
  const reader = useAgentReaderResult(scope, query.data, query.status);
  let state: ProfileReadingState = 'conservative';
  if (scope.enabled) {
    state =
      scope.failure() ??
      (query.status === 'error'
        ? 'unavailable'
        : scope.accepts(query.data) && query.data?.kind === 'ready'
          ? 'ready'
          : 'loading');
  } else if (session.state === 'unavailable') state = 'unavailable';
  else if (session.state === 'signed-out') state = 'signed-out';
  return {
    reader,
    state,
    response: `${scope.generation}:${state === 'ready' ? 'applied' : 'conservative'}`,
    // Session dependency recovery remains session-owned. Preference retry never rereads the public page.
    ...(scope.canRetry() ? { retry: scope.retry } : {}),
  };
}
