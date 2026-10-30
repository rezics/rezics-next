import { useSession } from '../../session/query';
import { csrfHeaders } from '../../threads/composer';
import {
  readProviderQueueAction,
  prepareProviderQueueAction,
  decideProviderCandidateAction,
  readProviderQueueSubjectsAction,
} from './provider-queue-actions';
import { ProviderQueue } from './provider-queue-view';
import type { QueueTransport } from './provider-queue';

const transport: QueueTransport = {
  read: (scope, cursor, session) =>
    readProviderQueueAction({ data: { scope, ...(cursor ? { cursor } : {}), ...(session ? { session } : {}) } }),
  prepare: (data) => prepareProviderQueueAction({ data, headers: csrfHeaders() }),
  decide: (data) => decideProviderCandidateAction({ data, headers: csrfHeaders() }),
  readings: (data) => readProviderQueueSubjectsAction({ data, headers: csrfHeaders() }),
};
export function ProviderQueueJourney() {
  const session = useSession();
  return (
    <ProviderQueue
      key={`${session.state}:${session.subject ?? ''}`}
      transport={transport}
      canWrite={session.state === 'signed-in' && !!session.csrfToken}
    />
  );
}
